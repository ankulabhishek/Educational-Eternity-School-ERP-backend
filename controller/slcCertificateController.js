const mongoose = require('mongoose')
const studentModel = require('../models/studentModel')
const slcModel = require('../models/slcCertificateModel')
const { getPermissionSet } = require('./permissionAssinment')
const { loadSchoolProfile } = require('../utils/schoolProfile')
const { renderSlcPdf } = require('../utils/slcPdf')
const { resolveOwnStudentRegistration } = require('../utils/studentPortalAccess')

const studentName = (student) => `${student.First_Name || ''} ${student.Last_Name || ''}`.trim()

const canReadStudents = async (req) => {
  const permissions = await getPermissionSet(req)
  return Boolean(permissions?.students && permissions.students.split('-').includes('R'))
}

const canIssue = async (req) => {
  const permissions = await getPermissionSet(req)
  return Boolean(permissions?.students && permissions.students.split('-').includes('W'))
}

const sendError = (res, error) => {
  const status = error.status || 500
  res.status(status).json({
    success: false,
    code: status,
    message: error.message || 'Could not prepare the leaving certificate',
  })
}

const publicCertificate = (certificate) => ({
  _id: certificate._id,
  SLCNumber: certificate.SLCNumber,
  RegistrationNumber: certificate.RegistrationNumber,
  StudentName: certificate.StudentName,
  FatherName: certificate.FatherName,
  MotherName: certificate.MotherName,
  DOB: certificate.DOB,
  Gender: certificate.Gender,
  Address: certificate.Address,
  ClassName: certificate.ClassName,
  SectionName: certificate.SectionName,
  DateOfAdmission: certificate.DateOfAdmission,
  DateOfLeaving: certificate.DateOfLeaving,
  Reason: certificate.Reason,
  Promoted: certificate.Promoted,
  Conduct: certificate.Conduct,
  WorkingDays: certificate.WorkingDays,
  AttendedDays: certificate.AttendedDays,
  FeesCleared: certificate.FeesCleared,
  MarkLeft: certificate.MarkLeft,
  Remarks: certificate.Remarks,
  createdAt: certificate.createdAt,
  updatedAt: certificate.updatedAt,
})

const school = async (req, res) => {
  try {
    if (!(await canReadStudents(req))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot issue leaving certificates' })
    }
    const profile = await loadSchoolProfile(req)
    res.status(200).json({ success: true, code: 200, data: profile })
  } catch (error) {
    sendError(res, error)
  }
}

const preview = async (req, res) => {
  try {
    if (!(await canReadStudents(req))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot issue leaving certificates' })
    }
    const registrationNumber = String(req.query.registrationNumber || '').trim()
    if (!registrationNumber) {
      return res.status(400).json({ success: false, code: 400, message: 'Choose a student first' })
    }
    const profile = await loadSchoolProfile(req)
    const student = await studentModel.findOne({
      InstutionCode: profile.code,
      Registration_Number: registrationNumber,
    }).select('-Password').lean()
    if (!student) {
      return res.status(404).json({ success: false, code: 404, message: 'Student not found in this school' })
    }
    const existing = await slcModel.findOne({
      InstutionCode: profile.code,
      RegistrationNumber: registrationNumber,
    }).lean()
    res.status(200).json({
      success: true,
      code: 200,
      data: {
        school: profile,
        student: {
          RegistrationNumber: student.Registration_Number,
          StudentName: studentName(student),
          FatherName: student.Father_Name || '',
          MotherName: student.Mother_Name || '',
          DOB: student.DOB || '',
          Gender: student.Gender || '',
          Address: student.Address || '',
          ClassName: student.Class || '',
          SectionName: student.Section || '',
          DateOfAdmission: student.createdAt || '',
          ContactNumber: student.Contact_Number || '',
          Status: student.Status,
        },
        certificate: existing ? publicCertificate(existing) : null,
      },
    })
  } catch (error) {
    sendError(res, error)
  }
}

const nextNumber = async (code) => {
  const year = new Date().getFullYear()
  const prefix = `SLC-${year}-`
  const count = await slcModel.countDocuments({
    InstutionCode: code,
    SLCNumber: new RegExp(`^${prefix}`),
  })
  return `${prefix}${String(count + 1).padStart(4, '0')}`
}

const issue = async (req, res) => {
  try {
    if (!(await canIssue(req))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot issue leaving certificates' })
    }
    const registrationNumber = String(req.body.registrationNumber || '').trim()
    const dateOfLeaving = String(req.body.dateOfLeaving || '').trim()
    const reason = String(req.body.reason || '').trim()
    if (!registrationNumber || !dateOfLeaving || !reason) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: 'Choose the student, the leaving date, and the reason',
      })
    }
    const profile = await loadSchoolProfile(req)
    const student = await studentModel.findOne({
      InstutionCode: profile.code,
      Registration_Number: registrationNumber,
    }).lean()
    if (!student) {
      return res.status(404).json({ success: false, code: 404, message: 'Student not found in this school' })
    }

    const payload = {
      StudentName: studentName(student),
      FatherName: student.Father_Name || '',
      MotherName: student.Mother_Name || '',
      DOB: student.DOB || '',
      Gender: student.Gender || '',
      Address: student.Address || '',
      ClassName: student.Class || '',
      SectionName: student.Section || '',
      DateOfAdmission: req.body.dateOfAdmission || student.createdAt || '',
      DateOfLeaving: dateOfLeaving,
      Reason: reason,
      Promoted: Boolean(req.body.promoted),
      Conduct: String(req.body.conduct || 'Good').trim() || 'Good',
      WorkingDays: req.body.workingDays != null ? String(req.body.workingDays) : '',
      AttendedDays: req.body.attendedDays != null ? String(req.body.attendedDays) : '',
      FeesCleared: req.body.feesCleared !== false,
      MarkLeft: req.body.markLeft !== false,
      Remarks: String(req.body.remarks || '').trim(),
      IssuedBy: req.user?.Name || req.user?.UserName || req.user?.MemberId || '',
    }

    let certificate = await slcModel.findOne({
      InstutionCode: profile.code,
      RegistrationNumber: registrationNumber,
    })
    const previouslyLeft = Boolean(certificate?.MarkLeft)
    if (certificate) {
      Object.assign(certificate, payload)
      await certificate.save()
    } else {
      certificate = await slcModel.create({
        ...payload,
        InstutionCode: profile.code,
        RegistrationNumber: registrationNumber,
        SLCNumber: await nextNumber(profile.code),
      })
    }

    if (payload.MarkLeft || previouslyLeft) {
      await studentModel.updateOne(
        { InstutionCode: profile.code, Registration_Number: registrationNumber },
        { $set: { Status: !payload.MarkLeft } }
      )
    }

    res.status(200).json({
      success: true,
      code: 200,
      message: `Leaving certificate ${certificate.SLCNumber} is ready`,
      data: publicCertificate(certificate),
    })
  } catch (error) {
    sendError(res, error)
  }
}

const list = async (req, res) => {
  try {
    if (!(await canReadStudents(req))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot view leaving certificates' })
    }
    const code = req.user.InstutionCode
    const rows = await slcModel.find({ InstutionCode: code }).sort({ updatedAt: -1 }).limit(500).lean()
    res.status(200).json({
      success: true,
      code: 200,
      data: rows.map(publicCertificate),
    })
  } catch (error) {
    sendError(res, error)
  }
}

const sendPdf = async (res, schoolProfile, certificate) => {
  const pdf = await renderSlcPdf(schoolProfile, certificate)
  const filename = `${certificate.SLCNumber}_${certificate.StudentName || 'student'}.pdf`.replace(/\s+/g, '_')
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(pdf)
}

const pdf = async (req, res) => {
  try {
    if (!(await canReadStudents(req))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot print leaving certificates' })
    }
    if (!mongoose.isValidObjectId(req.query.id)) {
      return res.status(400).json({ success: false, code: 400, message: 'Choose a certificate to print' })
    }
    const profile = await loadSchoolProfile(req)
    const certificate = await slcModel.findOne({
      _id: req.query.id,
      InstutionCode: profile.code,
    }).lean()
    if (!certificate) {
      return res.status(404).json({ success: false, code: 404, message: 'Leaving certificate not found' })
    }
    await sendPdf(res, profile, certificate)
  } catch (error) {
    sendError(res, error)
  }
}

const mine = async (req, res) => {
  try {
    const resolved = resolveOwnStudentRegistration(req)
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, code: resolved.error.status, message: resolved.error.message })
    }
    if (String(req.user?.UserType || '') !== 'Student') {
      return res.status(403).json({ success: false, code: 403, message: 'Only a student can open their own leaving certificate' })
    }
    const certificate = await slcModel.findOne({
      InstutionCode: req.user.InstutionCode,
      RegistrationNumber: resolved.registrationNumber,
    }).lean()
    res.status(200).json({
      success: true,
      code: 200,
      data: certificate ? publicCertificate(certificate) : null,
    })
  } catch (error) {
    sendError(res, error)
  }
}

const myPdf = async (req, res) => {
  try {
    const resolved = resolveOwnStudentRegistration(req)
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, code: resolved.error.status, message: resolved.error.message })
    }
    if (String(req.user?.UserType || '') !== 'Student') {
      return res.status(403).json({ success: false, code: 403, message: 'Only a student can download their own leaving certificate' })
    }
    const profile = await loadSchoolProfile(req)
    const certificate = await slcModel.findOne({
      InstutionCode: profile.code,
      RegistrationNumber: resolved.registrationNumber,
    }).lean()
    if (!certificate) {
      return res.status(404).json({ success: false, code: 404, message: 'Your school has not issued a leaving certificate yet' })
    }
    await sendPdf(res, profile, certificate)
  } catch (error) {
    sendError(res, error)
  }
}

module.exports = { school, preview, issue, list, pdf, mine, myPdf }
