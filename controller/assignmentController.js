const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { SchoolAssignment, AssignmentSubmission } = require('../models/assignmentModel');
const classModel = require('../models/classModel');
const studentModel = require('../models/studentModel');
const { resolveOwnStudentRegistration } = require('../utils/studentPortalAccess');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'assignments');
const STAFF = new Set(['admin', 'superadmin', 'mentor', 'teacher', 'examination staff']);

const ensureDir = () => fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const roleOf = (req) => String(req.user?.UserType || '').trim().toLowerCase();
const isStaff = (req) => STAFF.has(roleOf(req));
const staffName = (req) => [req.user?.FirstName, req.user?.LastName].filter(Boolean).join(' ').trim() || req.user?.UserName || 'Teacher';

const parseSubmitBy = (value) => {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      list = value.split(',');
    }
  }
  const allowed = ['text', 'image', 'pdf'];
  return [...new Set((Array.isArray(list) ? list : []).map((item) => String(item).trim().toLowerCase()).filter((item) => allowed.includes(item)))];
};

const kindOf = (mime, name) => {
  const type = String(mime || '').toLowerCase();
  const fileName = String(name || '').toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return 'image';
  if (type === 'application/pdf' || fileName.endsWith('.pdf')) return 'pdf';
  return '';
};

const removeStored = (files) => {
  (files || []).forEach((file) => {
    const stored = path.basename(String(file?.StoredName || ''));
    if (!stored) return;
    fs.unlink(path.join(UPLOAD_DIR, stored), () => {});
  });
};

const describeUploads = (files) => (files || []).map((file) => ({
  OriginalName: file.originalname,
  StoredName: path.basename(file.filename),
  MimeType: file.mimetype,
  Size: file.size,
  Kind: kindOf(file.mimetype, file.originalname),
}));

const timingFor = (dueAt, at = new Date()) => (new Date(at) <= new Date(dueAt) ? 'On time' : 'Late');

const studentInClass = (student, assignment) => {
  const classMatch = student.Class_Code === assignment.ClassCode
    || student.Class === assignment.ClassName
    || student.Class === assignment.ClassCode;
  if (!classMatch) return false;
  if (!assignment.SectionCode && !assignment.SectionName) return true;
  return student.SectionCode === assignment.SectionCode || student.Section === assignment.SectionName;
};

const loadOwnStudent = async (req) => {
  const resolved = resolveOwnStudentRegistration(req);
  if (resolved.error) return { error: resolved.error };
  const student = await studentModel.findOne({
    InstutionCode: req.user.InstutionCode,
    Registration_Number: resolved.registrationNumber,
  }).lean();
  if (!student) return { error: { status: 404, message: 'Student record not found' } };
  return { student };
};

const publicSubmission = (submission) => {
  if (!submission) return null;
  return {
    _id: submission._id,
    TextAnswer: submission.TextAnswer || '',
    Files: submission.Files || [],
    SubmittedAt: submission.SubmittedAt,
    Timing: submission.Timing,
    Status: submission.Status,
    Marks: submission.Marks,
    Feedback: submission.Feedback || '',
    GradedBy: submission.GradedBy || '',
    GradedAt: submission.GradedAt,
    Attempts: submission.Attempts || [],
  };
};

const withCounts = async (instutionCode, assignments) => {
  const ids = assignments.map((item) => item._id);
  const [submissions, students] = await Promise.all([
    AssignmentSubmission.find({ InstutionCode: instutionCode, AssignmentId: { $in: ids } })
      .select('AssignmentId Timing Status')
      .lean(),
    studentModel.find({ InstutionCode: instutionCode, Status: true })
      .select('Class Class_Code Section SectionCode')
      .lean(),
  ]);
  const counts = {};
  submissions.forEach((row) => {
    const key = String(row.AssignmentId);
    if (!counts[key]) counts[key] = { submitted: 0, onTime: 0, late: 0, graded: 0, returned: 0 };
    counts[key].submitted += 1;
    if (row.Timing === 'Late') counts[key].late += 1;
    else counts[key].onTime += 1;
    if (row.Status === 'Graded') counts[key].graded += 1;
    if (row.Status === 'Returned') counts[key].returned += 1;
  });
  return assignments.map((item) => {
    const plain = item.toObject ? item.toObject() : item;
    const expected = students.filter((student) => studentInClass(student, plain)).length;
    return {
      ...plain,
      counts: { expected, ...(counts[String(plain._id)] || { submitted: 0, onTime: 0, late: 0, graded: 0, returned: 0 }) },
    };
  });
};

const index = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot manage assignments' });
    const query = { InstutionCode: req.user.InstutionCode };
    if (req.query.classCode) query.ClassCode = req.query.classCode;
    if (req.query.status === 'Open' || req.query.status === 'Closed') query.Status = req.query.status;
    const rows = await SchoolAssignment.find(query).sort({ DueAt: -1 }).lean();
    const data = await withCounts(req.user.InstutionCode, rows);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load assignments' });
  }
};

const create = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot give an assignment' });
    const uploads = describeUploads(req.files);
    const bad = uploads.find((file) => !file.Kind);
    if (bad) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'Reference files can be a photo or a PDF' });
    }
    const submitBy = parseSubmitBy(req.body.SubmitBy);
    const dueAt = new Date(req.body.DueAt);
    const classInfo = await classModel.findOne({
      InstutionCode: req.user.InstutionCode,
      ClassCode: String(req.body.ClassCode || '').trim(),
    }).select('ClassName').lean();
    if (!classInfo || !String(req.body.Title || '').trim() || !String(req.body.Instructions || '').trim() || !String(req.body.Subject || '').trim() || !submitBy.length || Number.isNaN(dueAt.getTime())) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'Add the class, subject, title, instructions, due time, and how students should submit' });
    }
    const marks = Number(req.body.TotalMarks);
    const assignment = await SchoolAssignment.create({
      InstutionCode: req.user.InstutionCode,
      Title: String(req.body.Title).trim(),
      Instructions: String(req.body.Instructions).trim(),
      ClassCode: String(req.body.ClassCode).trim(),
      ClassName: classInfo.ClassName,
      SectionCode: String(req.body.SectionCode || '').trim(),
      SectionName: String(req.body.SectionName || '').trim(),
      Subject: String(req.body.Subject).trim(),
      DueAt: dueAt,
      TotalMarks: Number.isFinite(marks) && marks > 0 ? marks : 10,
      SubmitBy: submitBy,
      AllowLate: String(req.body.AllowLate) !== 'false',
      Status: 'Open',
      ReferenceFiles: uploads,
      AssignedBy: staffName(req),
    });
    return res.status(201).json({ success: true, data: assignment, message: 'Assignment given' });
  } catch (error) {
    removeStored(describeUploads(req.files));
    return res.status(500).json({ success: false, message: 'Could not save the assignment' });
  }
};

const update = async (req, res) => {
  const uploads = describeUploads(req.files);
  try {
    if (!isStaff(req)) {
      removeStored(uploads);
      return res.status(403).json({ success: false, message: 'You cannot change this assignment' });
    }
    if (uploads.some((file) => !file.Kind)) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'The question file must be a photo or a PDF' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'Assignment not found' });
    }
    const assignment = await SchoolAssignment.findOne({ _id: req.params.id, InstutionCode: req.user.InstutionCode });
    if (!assignment) {
      removeStored(uploads);
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }
    const submitBy = parseSubmitBy(req.body.SubmitBy);
    const dueAt = new Date(req.body.DueAt);
    if (!String(req.body.Title || '').trim() || !String(req.body.Instructions || '').trim() || !String(req.body.Subject || '').trim() || !submitBy.length || Number.isNaN(dueAt.getTime())) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'Title, instructions, subject, due time, and a way to submit are required' });
    }
    assignment.Title = String(req.body.Title).trim();
    assignment.Instructions = String(req.body.Instructions).trim();
    assignment.Subject = String(req.body.Subject).trim();
    assignment.DueAt = dueAt;
    assignment.SubmitBy = submitBy;
    assignment.AllowLate = req.body.AllowLate !== false && String(req.body.AllowLate) !== 'false';
    const marks = Number(req.body.TotalMarks);
    if (Number.isFinite(marks) && marks > 0) assignment.TotalMarks = marks;
    if (uploads.length) {
      assignment.ReferenceFiles = [...(assignment.ReferenceFiles || []), ...uploads].slice(-5);
    }
    await assignment.save();
    return res.status(200).json({ success: true, data: assignment, message: 'Assignment updated' });
  } catch (error) {
    removeStored(uploads);
    return res.status(500).json({ success: false, message: 'Could not update the assignment' });
  }
};

const setStatus = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot change this assignment' });
    const status = req.body.Status === 'Open' ? 'Open' : 'Closed';
    const assignment = await SchoolAssignment.findOneAndUpdate(
      { _id: req.params.id, InstutionCode: req.user.InstutionCode },
      { Status: status },
      { new: true }
    );
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });
    return res.status(200).json({ success: true, data: assignment, message: status === 'Closed' ? 'Assignment closed' : 'Assignment opened again' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not update the assignment' });
  }
};

const destroy = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot remove this assignment' });
    const assignment = await SchoolAssignment.findOne({ _id: req.params.id, InstutionCode: req.user.InstutionCode });
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });
    const submissions = await AssignmentSubmission.find({ InstutionCode: req.user.InstutionCode, AssignmentId: assignment._id });
    if (submissions.length) {
      return res.status(400).json({ success: false, message: 'Students have already submitted. Close the assignment instead of removing it.' });
    }
    removeStored(assignment.ReferenceFiles);
    await assignment.deleteOne();
    return res.status(200).json({ success: true, message: 'Assignment removed' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not remove the assignment' });
  }
};

const roster = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot open this assignment' });
    const assignment = await SchoolAssignment.findOne({ _id: req.params.id, InstutionCode: req.user.InstutionCode }).lean();
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });
    const [students, submissions] = await Promise.all([
      studentModel.find({ InstutionCode: req.user.InstutionCode, Status: true })
        .select('First_Name Last_Name Registration_Number Class Class_Code Section SectionCode')
        .lean(),
      AssignmentSubmission.find({ InstutionCode: req.user.InstutionCode, AssignmentId: assignment._id }).lean(),
    ]);
    const byReg = new Map(submissions.map((row) => [row.RegistrationNumber, row]));
    const rows = students
      .filter((student) => studentInClass(student, assignment))
      .map((student) => ({
        registrationNumber: student.Registration_Number,
        name: `${student.First_Name || ''} ${student.Last_Name || ''}`.trim() || student.Registration_Number,
        section: student.Section || '',
        submission: publicSubmission(byReg.get(student.Registration_Number)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ success: true, data: { assignment, students: rows } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load the class list' });
  }
};

const submit = async (req, res) => {
  const uploads = describeUploads(req.files);
  try {
    const loaded = await loadOwnStudent(req);
    if (loaded.error) {
      removeStored(uploads);
      return res.status(loaded.error.status).json({ success: false, message: loaded.error.message });
    }
    const assignment = await SchoolAssignment.findOne({ _id: req.params.id, InstutionCode: req.user.InstutionCode });
    if (!assignment || !studentInClass(loaded.student, assignment)) {
      removeStored(uploads);
      return res.status(404).json({ success: false, message: 'This assignment is not for your class' });
    }
    if (assignment.Status !== 'Open') {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'This assignment is closed' });
    }
    const now = new Date();
    const timing = timingFor(assignment.DueAt, now);
    if (timing === 'Late' && !assignment.AllowLate) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'The due time has passed, so this assignment no longer accepts work' });
    }
    const text = String(req.body.TextAnswer || '').trim();
    const images = uploads.filter((file) => file.Kind === 'image');
    const pdfs = uploads.filter((file) => file.Kind === 'pdf');
    if (uploads.some((file) => !file.Kind)) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'Only a photo (JPG or PNG) or a PDF can be uploaded' });
    }
    if (images.length && !assignment.SubmitBy.includes('image')) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'This assignment does not ask for a photo' });
    }
    if (pdfs.length && !assignment.SubmitBy.includes('pdf')) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'This assignment does not ask for a PDF' });
    }
    if (text && !assignment.SubmitBy.includes('text')) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'This assignment does not ask for a typed answer' });
    }
    const hasText = assignment.SubmitBy.includes('text') && text;
    const hasImage = assignment.SubmitBy.includes('image') && images.length;
    const hasPdf = assignment.SubmitBy.includes('pdf') && pdfs.length;
    if (!hasText && !hasImage && !hasPdf) {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'Add the work in the way the teacher asked' });
    }

    const registration = loaded.student.Registration_Number;
    let submission = await AssignmentSubmission.findOne({
      InstutionCode: req.user.InstutionCode,
      AssignmentId: assignment._id,
      RegistrationNumber: registration,
    });
    if (submission?.Status === 'Graded') {
      removeStored(uploads);
      return res.status(400).json({ success: false, message: 'This work is already checked. Ask the teacher if you need to send it again.' });
    }
    if (submission) {
      submission.Attempts.push({
        TextAnswer: submission.TextAnswer,
        Files: submission.Files,
        SubmittedAt: submission.SubmittedAt,
        Timing: submission.Timing,
        Marks: submission.Marks,
        Feedback: submission.Feedback,
        Status: submission.Status,
      });
      submission.TextAnswer = assignment.SubmitBy.includes('text') ? text : '';
      submission.Files = uploads;
      submission.SubmittedAt = now;
      submission.Timing = timing;
      submission.Status = 'Submitted';
      submission.Marks = undefined;
      submission.Feedback = '';
      submission.GradedBy = '';
      submission.GradedAt = undefined;
      await submission.save();
    } else {
      submission = await AssignmentSubmission.create({
        InstutionCode: req.user.InstutionCode,
        AssignmentId: assignment._id,
        RegistrationNumber: registration,
        StudentName: `${loaded.student.First_Name || ''} ${loaded.student.Last_Name || ''}`.trim(),
        TextAnswer: assignment.SubmitBy.includes('text') ? text : '',
        Files: uploads,
        SubmittedAt: now,
        Timing: timing,
        Status: 'Submitted',
      });
    }
    return res.status(200).json({
      success: true,
      data: publicSubmission(submission),
      message: timing === 'Late' ? 'Submitted late' : 'Submitted on time',
    });
  } catch (error) {
    removeStored(uploads);
    return res.status(500).json({ success: false, message: 'Could not submit the assignment' });
  }
};

const grade = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot check this work' });
    const submission = await AssignmentSubmission.findOne({ _id: req.params.id, InstutionCode: req.user.InstutionCode });
    if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });
    const assignment = await SchoolAssignment.findOne({ _id: submission.AssignmentId, InstutionCode: req.user.InstutionCode }).lean();
    const marks = Number(req.body.Marks);
    if (!Number.isFinite(marks) || marks < 0 || (assignment && marks > assignment.TotalMarks)) {
      return res.status(400).json({ success: false, message: `Marks must be between 0 and ${assignment?.TotalMarks || 0}` });
    }
    submission.Marks = marks;
    submission.Feedback = String(req.body.Feedback || '').trim();
    submission.Status = 'Graded';
    submission.GradedBy = staffName(req);
    submission.GradedAt = new Date();
    await submission.save();
    return res.status(200).json({ success: true, data: publicSubmission(submission), message: 'Marks saved' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not save the marks' });
  }
};

const sendBack = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot send this back' });
    const feedback = String(req.body.Feedback || '').trim();
    if (!feedback) return res.status(400).json({ success: false, message: 'Write a note so the student knows what to change' });
    const submission = await AssignmentSubmission.findOne({ _id: req.params.id, InstutionCode: req.user.InstutionCode });
    if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });
    submission.Status = 'Returned';
    submission.Feedback = feedback;
    submission.Marks = undefined;
    submission.GradedBy = staffName(req);
    submission.GradedAt = new Date();
    await submission.save();
    return res.status(200).json({ success: true, data: publicSubmission(submission), message: 'Sent back to the student' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not send the work back' });
  }
};

const mine = async (req, res) => {
  try {
    const loaded = await loadOwnStudent(req);
    if (loaded.error) return res.status(loaded.error.status).json({ success: false, message: loaded.error.message });
    const assignments = await SchoolAssignment.find({ InstutionCode: req.user.InstutionCode }).sort({ DueAt: -1 }).lean();
    const mineRows = assignments.filter((item) => studentInClass(loaded.student, item));
    const submissions = await AssignmentSubmission.find({
      InstutionCode: req.user.InstutionCode,
      RegistrationNumber: loaded.student.Registration_Number,
      AssignmentId: { $in: mineRows.map((item) => item._id) },
    }).lean();
    const byId = new Map(submissions.map((row) => [String(row.AssignmentId), row]));
    return res.status(200).json({
      success: true,
      data: mineRows.map((item) => ({ ...item, submission: publicSubmission(byId.get(String(item._id))) })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load your assignments' });
  }
};

const download = async (req, res) => {
  try {
    const stored = path.basename(String(req.params.storedName || ''));
    const full = path.join(UPLOAD_DIR, stored);
    if (!stored || !fs.existsSync(full)) return res.status(404).json({ success: false, message: 'File not found' });
    const instution = req.user.InstutionCode;
    const reference = await SchoolAssignment.findOne({ InstutionCode: instution, 'ReferenceFiles.StoredName': stored }).lean();
    const submission = reference ? null : await AssignmentSubmission.findOne({
      InstutionCode: instution,
      $or: [{ 'Files.StoredName': stored }, { 'Attempts.Files.StoredName': stored }],
    }).lean();
    const assignment = reference || (submission
      ? await SchoolAssignment.findOne({ _id: submission.AssignmentId, InstutionCode: instution }).lean()
      : null);
    if (!assignment) return res.status(404).json({ success: false, message: 'File not found' });
    if (!isStaff(req)) {
      const loaded = await loadOwnStudent(req);
      if (loaded.error) return res.status(loaded.error.status).json({ success: false, message: loaded.error.message });
      const ownWork = submission && submission.RegistrationNumber === loaded.student.Registration_Number;
      const ownReference = !submission && studentInClass(loaded.student, assignment);
      if (!ownWork && !ownReference) return res.status(403).json({ success: false, message: 'You cannot open this file' });
    }
    const allFiles = [
      ...(assignment.ReferenceFiles || []),
      ...(submission?.Files || []),
      ...((submission?.Attempts || []).flatMap((attempt) => attempt.Files || [])),
    ];
    const meta = allFiles.find((file) => file.StoredName === stored);
    res.setHeader('Content-Type', meta?.MimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta?.OriginalName || stored)}"`);
    return fs.createReadStream(full).pipe(res);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not open the file' });
  }
};

const upload = require('multer')({
  storage: require('multer').diskStorage({
    destination: (req, file, callback) => {
      ensureDir();
      callback(null, UPLOAD_DIR);
    },
    filename: (req, file, callback) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
      callback(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, callback) => {
    if (kindOf(file.mimetype, file.originalname)) callback(null, true);
    else callback(new Error('Only a photo or a PDF is allowed'));
  },
});

module.exports = {
  upload,
  index,
  create,
  update,
  setStatus,
  destroy,
  roster,
  submit,
  grade,
  sendBack,
  mine,
  download,
};
