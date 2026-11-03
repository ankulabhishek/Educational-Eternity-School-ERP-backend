const { response } = require('express')
const attendenceRecordModel = require('../models/attendenceRecordModel')
const classModel = require('../models/classModel')

const { getPermissionSet } = require('./permissionAssinment');
const studentModel         = require('../models/studentModel')
const StudentEnrollment    = require('../models/studentEnrollmentModel')
const mongoErrorMessages = require('./mongoErrors.json');
const { AcademicYear } = require('../models/academicYearModel')
const { resolveOwnStudentRegistration } = require('../utils/studentPortalAccess')

// Helper to safely parse attendance status
const isPresent = (val) => {
  if (!val) return false
  const v = String(val).toLowerCase()
  return v === 'present' || v === 'p'
}

const dateKey = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const todayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

const interpretations = (val) => {
  const raw = String(val || '').trim()
  if (!raw) return []
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return [new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))]
  const parts = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/)
  if (!parts) {
    const parsed = new Date(raw)
    if (Number.isNaN(parsed.getTime())) return []
    return [new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())]
  }
  const first = Number(parts[1])
  const second = Number(parts[2])
  const year = Number(parts[3])
  const dates = []
  if (second >= 1 && second <= 12 && first >= 1 && first <= 31) dates.push(new Date(year, second - 1, first))
  if (first >= 1 && first <= 12 && second >= 1 && second <= 31) dates.push(new Date(year, first - 1, second))
  return dates.filter((date) => date.getFullYear() === year && date.getMonth() >= 0)
}

const tryParseDate = (val) => interpretations(val)[0] || null

const inRange = (stored, from, to) => interpretations(stored).some((date) => date >= from && date <= to)

const canonicalDate = (stored) => {
  const raw = String(stored || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const parsed = tryParseDate(stored)
  return parsed ? dateKey(parsed) : raw
}

const resolveAcademicYearRange = async (req, fromDate, toDate) => {
  if (fromDate && toDate) {
    const from = tryParseDate(fromDate)
    const to = tryParseDate(toDate)
    if (from && to) return { from, to }
  }

  const academicYearId = req.headers?.['x-academic-year-id']
  if (!academicYearId) return null

  const academicYear = await AcademicYear.findOne({
    InstutionCode: req.user?.InstutionCode,
    _id: academicYearId,
    Status: true,
  }).lean()

  if (!academicYear?.Start_Date || !academicYear?.End_Date) return null
  return { from: academicYear.Start_Date, to: academicYear.End_Date }
}

//Show the list of attendence

const index = async (req, res, next) => {
  const permissionsResult = await getPermissionSet(req)
  const attPerms =
    (permissionsResult.attendenceRecordModels && permissionsResult.attendenceRecordModels.split('-')) || []
  if (!attPerms.includes('RA') && !attPerms.includes('R')) {
    return res.status(403).json({
      code: 403,
      success: false,
      message:
        'You do not have the necessary permissions to access this resource. Please contact your administrator',
    })
  }

    try {
        const page = parseInt(req.query.PageNumber) || 1;
        const limit = parseInt(req.query.PageSize) || 10;
        const skip = (page - 1) * limit;
        const searchText = req.query.SearchText || '';

        let searchCondition = {
            InstutionId: req.user.InstutionCode // Always filter by institution
        };

        // Filter by Class
        if (req.query.ClassCode) {
            searchCondition.Class_Code = req.query.ClassCode;
        }

        // Filter by Date
        if (req.query.Date) {
            // Date can be in various formats, try to match it
            searchCondition.Date = { $regex: req.query.Date, $options: 'i' };
        }

        // Filter by Subject
        if (req.query.Subject) {
            searchCondition.Subject = { $regex: req.query.Subject, $options: 'i' };
        }

        // Filter by Section (need to check if attendance records have section info)
        // For now, we'll filter by checking if any student in the attendance belongs to that section
        // This requires checking the student records, so we'll handle it after fetching

        // Filter by Student Registration Number
        if (req.query.StudentId) {
            // We'll filter this after fetching by checking the Attendence array
            searchCondition['Attendence.StudentId'] = { $regex: req.query.StudentId, $options: 'i' };
        }

        if (req.query.Availability === 'P') {
            searchCondition.Availability = true;
        } else if (req.query.Availability === 'A') {
            searchCondition.Availability = false;
        }

        if (searchText) {
            searchCondition.$or = [
                { Time: { $regex: searchText, $options: 'i' } },
                { Class_Code: { $regex: searchText, $options: 'i' } },
                { Subject: { $regex: searchText, $options: 'i' } },
                { Subject_Teacher: { $regex: searchText, $options: 'i' } },
                { Date: { $regex: searchText, $options: 'i' } }
            ];
        }

        let attendences = await attendenceRecordModel.find(searchCondition).skip(skip).limit(limit).sort({ Date: -1, Time: -1 });
        let totalCount = await attendenceRecordModel.countDocuments(searchCondition);

        // Filter by Section if provided (check students in attendance records)
        if (req.query.Section) {
            const sectionCode = req.query.Section;
            // Get students in this section
            const studentsInSection = await studentModel.find({
                InstutionCode: req.user.InstutionCode,
                SectionCode: sectionCode
            }).select('Registration_Number').lean();

            const sectionStudentIds = studentsInSection.map(s => s.Registration_Number);

            // Filter attendance records to only include those with students from this section
            attendences = attendences.filter(att => {
                if (!att.Attendence || !Array.isArray(att.Attendence)) return false;
                return att.Attendence.some(a => sectionStudentIds.includes(a.StudentId));
            });

            // Re-count after section filter
            totalCount = attendences.length;
        }

        // Filter by Student Registration Number if provided (more precise)
        if (req.query.StudentId && !searchCondition['Attendence.StudentId']) {
            const studentId = req.query.StudentId;
            attendences = attendences.filter(att => {
                if (!att.Attendence || !Array.isArray(att.Attendence)) return false;
                return att.Attendence.some(a => 
                    a.StudentId && a.StudentId.toString().toLowerCase().includes(studentId.toLowerCase())
                );
            });
            totalCount = attendences.length;
        }

        res.status(200).json({
            success: true,
            message: "Data retrieved successfully",
            code: 200,
            totalRecords: totalCount,
            data: attendences.map(attendence => ({
                _id: attendence._id,
                ClassCode: attendence.Class_Code,
                Attendence: attendence.Attendence,
                Subject: attendence.Subject,
                SubjectTeacher: attendence.Subject_Teacher,
                InstutionId: attendence.InstutionId,
                Date: attendence.Date,
                Time: attendence.Time,
            }))
        });
    } catch (error) {
        const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key));
        const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message;
        res.status(500).json({
            success: false,
            message: errorMessage,
            code: 500,
            error: errorMessage
        });
    }
}


// Get single attendence Record

const show = async (req, res, next) => {
  const permissionsResult = await getPermissionSet(req)
  const attPerms =
    (permissionsResult.attendenceRecordModels && permissionsResult.attendenceRecordModels.split('-')) || []
  if (!attPerms.includes('R')) {
    return res.status(403).json({
      code: 403,
      success: false,
      message:
        'You do not have the necessary permissions to access this resource. Please contact your administrator',
    })
  }
    const currentDate = new Date();
    const date = currentDate.toLocaleDateString();  
    const time = currentDate.toLocaleTimeString(); 

 try{

    let formattedRecords = []
  const attendenceRecord = await attendenceRecordModel.find({ Class_Code:req.query.Class, InstutionId: req.user.InstutionCode, Date: date});
  formattedRecords = attendenceRecord.map(stuAttendence => ({
        studentName: stuAttendence.Attendence,           
    }))
    
  res.status(200).json({
    success: true,
    message: "Data retrieved successfully",
    code: 200,
    data:attendenceRecord
})


} catch(error){
    const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key));
    const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message;
    res.status(401).json({
        message: errorMessage,
        status:401
    })
    
}
}

const getAllStudent = async (req, res, next) => {
    const permissionsResult = await getPermissionSet(req);
    const attPerms =
      (permissionsResult.attendenceRecordModels && permissionsResult.attendenceRecordModels.split('-')) || []
    if(attPerms.includes('R')){
        const classKey = req.query.Class || req.query.ClassCode || ''
        const sectionKey = req.query.Section || req.query.SectionCode || ''
        const query = { InstutionCode: req.user.InstutionCode, Status: true }
        const and = []
        if (classKey) and.push({ $or: [{ Class: classKey }, { Class_Code: classKey }] })
        if (sectionKey) and.push({ $or: [{ Section: sectionKey }, { SectionCode: sectionKey }] })
        if (and.length) query.$and = and

        const studentRecord = await studentModel.find(query);

        let formattedRecords = studentRecord.map(student => ({
            StudentName: student.First_Name+' '+student.Last_Name, 
            StudentId: student.Registration_Number,  
            attendance: "Absent"           
        }));

      
        res.status(200).json({
            success: true,
            message: 'Student record retrieved successfully!',
            code: 200,
            data:formattedRecords
        });


     } else{
            res.status(401).json({
                code: 401,
                success: false,
                message: 'You do not have the necessary permissions to access this resource. Please contact your administrator'
            })
        }

}



// Add attendence to dataBase
const store = async (req, res, next) => {
   const permissionsResult = await getPermissionSet(req);
   const attPermsStore =
     (permissionsResult.attendenceRecordModels && permissionsResult.attendenceRecordModels.split('-')) || []
   if(attPermsStore.includes('W')){

        const chosen = tryParseDate(req.body.Date)
        const date = chosen ? dateKey(chosen) : todayKey()
        const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) 

        // Resolve academic year for this attendance batch (optional)
        let academicYearId = null
        let academicYearName = ''
        const academicYearHeaderId = req.headers['x-academic-year-id']
        if (academicYearHeaderId) {
            const yearDoc = await AcademicYear.findOne({
                _id: academicYearHeaderId,
                InstutionCode: req.user.InstutionCode,
                Status: true,
            }).lean()
            if (yearDoc) {
                academicYearId = yearDoc._id.toString()
                academicYearName = yearDoc.Year_Name || ''
            }
        }

        if (!req.body.InstutionId) {
            req.body.InstutionId = req.user.InstutionCode
        }

        if(req.body.TeacherId === ''){
            req.body.TeacherId = req.user.MemberId;
        }

        const marks = (Array.isArray(req.body.Attendance) ? req.body.Attendance : []).map((student) => ({
            StudentId: student.StudentId,
            StudentName: student.StudentName || '',
            attendance: student.attendance === 'Present' || student.attendance === 'P' ? 'Present' : 'Absent',
        }))

        const classCode = req.body.ClassCode || ''
        const subject = req.body.Subject || ''
        const sectionCode = req.body.SectionCode || ''
        const existingRecords = await attendenceRecordModel.find({
            InstutionId: req.body.InstutionId,
            Class_Code: classCode,
            Subject: subject,
        })
        const existing = existingRecords.find((record) => canonicalDate(record.Date) === date && String(record.SectionCode || '') === String(sectionCode))

        const payload = {
            Class_Code: classCode,
            ClassName: req.body.ClassName || '',
            SectionCode: sectionCode,
            SectionName: req.body.SectionName || '',
            Attendence: marks,
            Subject: subject,
            Subject_Teacher: req.body.TeacherId,
            InstutionId: req.body.InstutionId,
            Date: date,
            Time: time,
            AcademicYearId: academicYearId,
            AcademicYearName: academicYearName,
        }

        const saved = existing
            ? attendenceRecordModel.findByIdAndUpdate(existing._id, { $set: payload }, { new: true })
            : new attendenceRecordModel(payload).save()

    saved
        .then(response => {
            res.status(200).json({
                success: true,
                message: 'attendence added successfully!',
                code: 200
            });
        })
        .catch(error => {
            const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key));
            const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message;
            res.status(401).json({
                code: 401,
                success: false,
                message: errorMessage
            });
        });
   }else{
        res.status(403).json({
            code: 403,
            success: false,
            message: 'You do not have the necessary permissions to access this resource. Please contact your administrator'
        })
    }
}


const updateStudentAttendence = async (studentId, attendendClass, totalClass) => {

    let updateData = {
        Attended_Classes : attendendClass,
        Total_Classes    : totalClass
    }

    studentModel.findByIdAndUpdate(studentId, { $set: updateData })
    .then(response => {
       return response;
    })
    .catch(error => {
       return error;
    });
}


// Get attendance records for a specific student
const getStudentAttendance = async (req, res, next) => {
    const permissionsResult = await getPermissionSet(req);
    const attPermsStudent =
      (permissionsResult.attendenceRecordModels && permissionsResult.attendenceRecordModels.split('-')) || []
    if(attPermsStudent.includes('R')){
        try {
            const rawStudentId = req.query.StudentId || req.query.RegistrationNumber;
            const resolved = resolveOwnStudentRegistration(req, rawStudentId);
            if (resolved.error) {
                return res.status(resolved.error.status).json({
                    success: false,
                    code: resolved.error.status,
                    message: resolved.error.message
                });
            }
            const studentId = resolved.registrationNumber;

            if (!studentId) {
                return res.status(400).json({
                    success: false,
                    code: 400,
                    message: 'Student Registration Number is required'
                });
            }

            // Get all attendance records for this institution
            const allRecords = await attendenceRecordModel.find({
                InstutionId: req.user.InstutionCode
            }).sort({ Date: -1, Time: -1 });

            // Filter records that contain this student
            const studentRecords = allRecords.filter(record => {
                if (!record.Attendence || !Array.isArray(record.Attendence)) return false;
                return record.Attendence.some(a => 
                    a.StudentId && a.StudentId.toString().toLowerCase() === studentId.toLowerCase()
                );
            });

            // Extract student's attendance from each record
            const studentAttendance = studentRecords.map(record => {
                const studentAtt = record.Attendence.find(a => 
                    a.StudentId && a.StudentId.toString().toLowerCase() === studentId.toLowerCase()
                );
                return {
                    _id: record._id,
                    Date: canonicalDate(record.Date),
                    Time: record.Time,
                    ClassCode: record.Class_Code,
                    Subject: record.Subject,
                    Attendance: studentAtt ? studentAtt.attendance : 'Absent',
                    SubjectTeacher: record.Subject_Teacher
                };
            });

            // Get student info
            const student = await studentModel.findOne({
                Registration_Number: studentId,
                InstutionCode: req.user.InstutionCode
            }).select('First_Name Last_Name Registration_Number Class Section SectionCode').lean();

            res.status(200).json({
                success: true,
                message: 'Student attendance retrieved successfully!',
                code: 200,
                data: {
                    student: student || null,
                    attendance: studentAttendance,
                    totalRecords: studentAttendance.length,
                    presentCount: studentAttendance.filter(a => a.Attendance === 'Present' || a.Attendance === 'P').length,
                    absentCount: studentAttendance.filter(a => a.Attendance === 'Absent' || a.Attendance === 'A').length
                }
            });

        } catch (error) {
            const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key));
            const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message;
            res.status(500).json({
                success: false,
                message: errorMessage,
                code: 500,
                error: errorMessage
            });
        }
    } else {
        res.status(403).json({
            code: 403,
            success: false,
            message: 'You do not have the necessary permissions to access this resource. Please contact your administrator'
        });
    }
}

// Analytics: institution and class-wise overview
const getAttendanceOverview = async (req, res, next) => {
    try {
        const instutionId = req.user?.InstutionCode
        if (!instutionId) {
            return res.status(401).json({
                success: false,
                code: 401,
                message: 'Institution context not found'
            })
        }

        const { ClassCode, fromDate, toDate } = req.query

        const matchCondition = {
            InstutionId: instutionId
        }

        if (ClassCode) {
            matchCondition.Class_Code = ClassCode
        }

        let records = await attendenceRecordModel.find(matchCondition)

        // Optional: date range filter from query or selected academic year header
        const range = await resolveAcademicYearRange(req, fromDate, toDate)
        if (range) {
          records = records.filter((rec) => inRange(rec.Date, range.from, range.to))
        }

        let totalMarks = 0
        let presentMarks = 0

        const classStats = new Map()

        records.forEach(rec => {
            const cls = rec.Class_Code || 'Unknown'
            const list = Array.isArray(rec.Attendence) ? rec.Attendence : []

            if (!classStats.has(cls)) {
                classStats.set(cls, {
                    totalMarks: 0,
                    presentMarks: 0,
                    sessions: 0
                })
            }
            const stat = classStats.get(cls)

            list.forEach(a => {
                stat.totalMarks += 1
                totalMarks += 1
                if (isPresent(a.attendance)) {
                    stat.presentMarks += 1
                    presentMarks += 1
                }
            })
            stat.sessions += 1
        })

        const overallPercent = totalMarks ? (presentMarks * 100) / totalMarks : 0

        const classSummary = Array.from(classStats.entries()).map(([classCode, stat]) => {
            const percent = stat.totalMarks ? (stat.presentMarks * 100) / stat.totalMarks : 0
            return {
                classCode,
                sessions: stat.sessions,
                totalMarks: stat.totalMarks,
                presentMarks: stat.presentMarks,
                absentMarks: stat.totalMarks - stat.presentMarks,
                attendancePercent: parseFloat(percent.toFixed(1))
            }
        })

        res.status(200).json({
            success: true,
            code: 200,
            message: 'Attendance overview fetched successfully',
            data: {
                institution: {
                    totalMarks,
                    presentMarks,
                    absentMarks: totalMarks - presentMarks,
                    attendancePercent: parseFloat(overallPercent.toFixed(1))
                },
                classes: classSummary
            }
        })
    } catch (error) {
        const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key))
        const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message
        res.status(500).json({
            success: false,
            message: errorMessage,
            code: 500,
            error: errorMessage
        })
    }
}

// Analytics: student-wise summary including subject breakdown
const getStudentAttendanceSummary = async (req, res, next) => {
    try {
        const instutionId = req.user?.InstutionCode
        if (!instutionId) {
            return res.status(401).json({
                success: false,
                code: 401,
                message: 'Institution context not found'
            })
        }

        const rawStudentId = req.query.StudentId || req.query.RegistrationNumber
        const resolved = resolveOwnStudentRegistration(req, rawStudentId)
        if (resolved.error) {
            return res.status(resolved.error.status).json({
                success: false,
                code: resolved.error.status,
                message: resolved.error.message
            })
        }
        const studentId = resolved.registrationNumber
        if (!studentId) {
            return res.status(400).json({
                success: false,
                code: 400,
                message: 'Student Registration Number is required'
            })
        }

        const allRecords = await attendenceRecordModel.find({
            InstutionId: instutionId
        }).sort({ Date: -1, Time: -1 })

        // Optional: filter by selected academic year header or fromDate/toDate
        const range = await resolveAcademicYearRange(
          req,
          req.query.fromDate,
          req.query.toDate
        )
        const filteredRecords = range
          ? allRecords.filter((rec) => inRange(rec.Date, range.from, range.to))
          : allRecords

        const studentRecords = filteredRecords.filter(record => {
            if (!record.Attendence || !Array.isArray(record.Attendence)) return false
            return record.Attendence.some(a =>
                a.StudentId && a.StudentId.toString().toLowerCase() === studentId.toLowerCase()
            )
        })

        let totalSessions = 0
        let presentCount = 0
        let absentCount = 0
        let leaveCount = 0
        const subjectMap = new Map()

        const attendanceList = studentRecords.map(record => {
            const studentAtt = record.Attendence.find(a =>
                a.StudentId && a.StudentId.toString().toLowerCase() === studentId.toLowerCase()
            )
            const status = studentAtt ? studentAtt.attendance : 'Absent'
            const present = isPresent(status)
            const onLeave = String(status || '').toLowerCase() === 'leave'

            totalSessions += 1
            if (present) presentCount += 1
            else if (onLeave) leaveCount += 1
            else absentCount += 1

            const subject = record.Subject || 'Unknown'
            if (!subjectMap.has(subject)) {
                subjectMap.set(subject, { total: 0, present: 0, absent: 0 })
            }
            const s = subjectMap.get(subject)
            s.total += 1
            if (present) s.present += 1
            else if (!onLeave) s.absent += 1

            return {
                _id: record._id,
                Date: canonicalDate(record.Date),
                Time: record.Time,
                ClassCode: record.Class_Code,
                Subject: record.Subject,
                Attendance: status,
                SubjectTeacher: record.Subject_Teacher
            }
        })

        const subjectWise = Array.from(subjectMap.entries()).map(([subject, stat]) => {
            const percent = stat.total ? (stat.present * 100) / stat.total : 0
            return {
                subject,
                totalSessions: stat.total,
                present: stat.present,
                absent: stat.absent,
                attendancePercent: parseFloat(percent.toFixed(1))
            }
        })

        const student = await studentModel.findOne({
            Registration_Number: studentId,
            InstutionCode: instutionId
        }).select('First_Name Last_Name Registration_Number Class Section SectionCode').lean()

        // In academic-year view, student enrollment may have changed.
        // We show the class code from attendance records to avoid confusion.
        const displayClassCode = studentRecords[0]?.Class_Code
        if (student && displayClassCode) {
            student.Class = displayClassCode
        }

        const overallPercent = totalSessions ? (presentCount * 100) / totalSessions : 0

        res.status(200).json({
            success: true,
            code: 200,
            message: 'Student attendance summary fetched successfully',
            data: {
                student: student || null,
                overall: {
                    totalSessions,
                    presentCount,
                    absentCount,
                    leaveCount,
                    attendancePercent: parseFloat(overallPercent.toFixed(1))
                },
                subjectWise,
                records: attendanceList
            }
        })
    } catch (error) {
        const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key))
        const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message
        res.status(500).json({
            success: false,
            message: errorMessage,
            code: 500,
            error: errorMessage
        })
    }
}

const canReadAttendance = async (req) => {
  const permissions = await getPermissionSet(req)
  const parts = String(permissions?.attendenceRecordModels || '').split('-')
  return parts.includes('R') || parts.includes('RA')
}

const getRegister = async (req, res) => {
  try {
    if (!(await canReadAttendance(req))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot view attendance' })
    }
    const instutionId = req.user.InstutionCode
    let from
    let to
    if (req.query.date) {
      from = tryParseDate(req.query.date)
      to = from
    } else if (/^\d{4}-\d{2}$/.test(String(req.query.month || ''))) {
      const [year, month] = req.query.month.split('-').map(Number)
      from = new Date(year, month - 1, 1)
      to = new Date(year, month, 0)
    } else if (req.query.fromDate && req.query.toDate) {
      from = tryParseDate(req.query.fromDate)
      to = tryParseDate(req.query.toDate)
    } else {
      const today = tryParseDate(todayKey())
      from = new Date(today.getFullYear(), today.getMonth(), 1)
      to = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    }
    if (!from || !to) {
      return res.status(400).json({ success: false, code: 400, message: 'Choose a valid day, month, or date range' })
    }

    const classKey = String(req.query.ClassCode || '').trim()
    const sectionKey = String(req.query.SectionCode || '').trim()
    const studentKey = String(req.query.student || '').trim().toLowerCase()
    const classRecord = classKey
      ? await classModel.findOne({ InstutionCode: instutionId, $or: [{ ClassCode: classKey }, { ClassName: classKey }] }).lean()
      : null

    const studentQuery = { InstutionCode: instutionId, Status: true }
    const and = []
    if (classRecord || classKey) {
      and.push({
        $or: [
          { Class_Code: classRecord?.ClassCode || classKey },
          { Class: classRecord?.ClassName || classKey },
        ],
      })
    }
    if (and.length) studentQuery.$and = and
    let students = await studentModel.find(studentQuery)
      .select('First_Name Last_Name Registration_Number Class Class_Code Section SectionCode')
      .lean()
    if (sectionKey) {
      students = students.filter((student) => student.SectionCode === sectionKey || student.Section === sectionKey)
    }
    if (studentKey) {
      students = students.filter((student) => {
        const name = `${student.First_Name || ''} ${student.Last_Name || ''}`.toLowerCase()
        return name.includes(studentKey) || String(student.Registration_Number || '').toLowerCase().includes(studentKey)
      })
    }

    const classCodes = new Set([classKey, classRecord?.ClassCode, classRecord?.ClassName].filter(Boolean))
    let records = await attendenceRecordModel.find({ InstutionId: instutionId }).lean()
    records = records.filter((record) => inRange(record.Date, from, to))
    if (classCodes.size) {
      records = records.filter((record) => classCodes.has(record.Class_Code) || classCodes.has(record.ClassName))
    }
    const studentIds = new Set(students.map((student) => String(student.Registration_Number || '').toLowerCase()))
    if (sectionKey) {
      records = records.filter((record) => {
        if (record.SectionCode && record.SectionCode === sectionKey) return true
        if (record.SectionName && record.SectionName === sectionKey) return true
        return (record.Attendence || []).some((mark) => studentIds.has(String(mark.StudentId || '').toLowerCase()))
      })
    }

    const sessions = records.map((record) => {
      const list = Array.isArray(record.Attendence) ? record.Attendence : []
      const present = list.filter((mark) => isPresent(mark.attendance)).length
      return {
        id: record._id,
        date: canonicalDate(record.Date),
        subject: record.Subject || '',
        present,
        absent: list.length - present,
        total: list.length,
      }
    }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.subject).localeCompare(String(b.subject)))

    const studentRows = students.map((student) => {
      const reg = String(student.Registration_Number || '').toLowerCase()
      const days = []
      records.forEach((record) => {
        const mark = (record.Attendence || []).find((item) => String(item.StudentId || '').toLowerCase() === reg)
        if (!mark) return
        const rawStatus = String(mark.attendance || '')
        days.push({
          recordId: record._id,
          date: canonicalDate(record.Date),
          subject: record.Subject || '',
          status: isPresent(rawStatus) ? 'Present' : rawStatus.toLowerCase() === 'leave' ? 'Leave' : 'Absent',
        })
      })
      const present = days.filter((day) => day.status === 'Present').length
      const conducted = days.length
      return {
        registrationNumber: student.Registration_Number,
        name: `${student.First_Name || ''} ${student.Last_Name || ''}`.trim(),
        className: student.Class || classRecord?.ClassName || '',
        section: student.Section || '',
        present,
        conducted,
        absent: conducted - present,
        percent: conducted ? Math.round((present * 1000) / conducted) / 10 : 0,
        days,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))

    const presentMarks = sessions.reduce((sum, session) => sum + session.present, 0)
    const totalMarks = sessions.reduce((sum, session) => sum + session.total, 0)
    res.status(200).json({
      success: true,
      code: 200,
      data: {
        from: dateKey(from),
        to: dateKey(to),
        singleDay: dateKey(from) === dateKey(to),
        conducted: sessions.length,
        presentMarks,
        absentMarks: totalMarks - presentMarks,
        percent: totalMarks ? Math.round((presentMarks * 1000) / totalMarks) / 10 : 0,
        sessions,
        students: studentRows,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, code: 500, message: 'Could not load the attendance register' })
  }
}

const isSuperAdminUser = (user) =>
  String(user?.UserType || '').trim().toLowerCase().replace(/\s+/g, '') === 'superadmin'

const updateStudentMark = async (req, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ success: false, message: 'Only a super admin can change an attendance record' })
    }
    const recordId = String(req.body.recordId || '').trim()
    const studentId = String(req.body.studentId || '').trim()
    const attendance = String(req.body.attendance || '').trim()
    if (!['Present', 'Absent', 'Leave'].includes(attendance)) {
      return res.status(400).json({ success: false, message: 'Choose Present, Absent, or Leave' })
    }
    const record = await attendenceRecordModel.findOne({ _id: recordId, InstutionId: req.user.InstutionCode })
    if (!record) return res.status(404).json({ success: false, message: 'Attendance record not found for this school' })
    const mark = (record.Attendence || []).find((item) => String(item.StudentId || '').toLowerCase() === studentId.toLowerCase())
    if (!mark) return res.status(404).json({ success: false, message: 'This student is not on that attendance record' })
    mark.attendance = attendance
    record.markModified('Attendence')
    await record.save()
    return res.status(200).json({ success: true, message: 'Attendance updated' })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not update the attendance record' })
  }
}

const deleteStudentMark = async (req, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ success: false, message: 'Only a super admin can delete an attendance record' })
    }
    const recordId = String(req.body.recordId || '').trim()
    const studentId = String(req.body.studentId || '').trim()
    const record = await attendenceRecordModel.findOne({ _id: recordId, InstutionId: req.user.InstutionCode })
    if (!record) return res.status(404).json({ success: false, message: 'Attendance record not found for this school' })
    const before = Array.isArray(record.Attendence) ? record.Attendence.length : 0
    record.Attendence = (record.Attendence || []).filter((item) => String(item.StudentId || '').toLowerCase() !== studentId.toLowerCase())
    if (record.Attendence.length === before) {
      return res.status(404).json({ success: false, message: 'This student is not on that attendance record' })
    }
    if (!record.Attendence.length) await record.deleteOne()
    else {
      record.markModified('Attendence')
      await record.save()
    }
    return res.status(200).json({ success: true, message: 'Attendance record deleted' })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not delete the attendance record' })
  }
}

const getSession = async (req, res) => {
  try {
    if (!(await canReadAttendance(req))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot view attendance' })
    }
    const date = canonicalDate(req.query.date || todayKey())
    const classCode = String(req.query.ClassCode || '')
    const subject = String(req.query.Subject || '')
    const sectionCode = String(req.query.SectionCode || '')
    const records = await attendenceRecordModel.find({
      InstutionId: req.user.InstutionCode,
      Class_Code: classCode,
      Subject: subject,
    }).lean()
    const match = records.find((record) => canonicalDate(record.Date) === date && String(record.SectionCode || '') === sectionCode)
    res.status(200).json({ success: true, code: 200, data: match || null })
  } catch (error) {
    res.status(500).json({ success: false, code: 500, message: 'Could not load this attendance' })
  }
}

module.exports = {
    index,
    show,
    store,
    getAllStudent,
    getStudentAttendance,
    getAttendanceOverview,
    getStudentAttendanceSummary,
    getRegister,
    getSession,
    updateStudentMark,
    deleteStudentMark,
}