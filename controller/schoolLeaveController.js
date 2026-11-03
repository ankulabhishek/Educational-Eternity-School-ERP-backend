const SchoolLeave = require('../models/schoolLeaveModel')
const TeacherAttendance = require('../models/teacherAttendanceModel')
const studentModel = require('../models/studentModel')
const attendenceRecordModel = require('../models/attendenceRecordModel')

const roleOf = (userType) => String(userType || '').trim().toLowerCase().replace(/\s+/g, '')
const isAdmin = (user) => ['admin', 'superadmin'].includes(roleOf(user?.UserType))
const personTypeOf = (user) => (roleOf(user?.UserType) === 'student' ? 'Student' : 'Teacher')

const eachDate = (from, to) => {
  const days = []
  const [y, m, d] = from.split('-').map(Number)
  const cursor = new Date(Date.UTC(y, m - 1, d))
  const end = new Date(`${to}T00:00:00Z`)
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10)
    if (cursor.getUTCDay() !== 0) days.push(key)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

const stampTeacherLeave = async (leave) => {
  const days = eachDate(leave.FromDate, leave.ToDate)
  for (const day of days) {
    const existing = await TeacherAttendance.findOne({
      InstutionCode: leave.InstutionCode,
      TeacherMemberId: leave.MemberId,
      AttendanceDate: day,
    })
    if (existing?.RequestStatus === 'Approved' && existing.FinalAttendanceStatus === 'Present') continue
    await TeacherAttendance.findOneAndUpdate(
      { InstutionCode: leave.InstutionCode, TeacherMemberId: leave.MemberId, AttendanceDate: day },
      {
        $set: {
          InstutionCode: leave.InstutionCode,
          TeacherMemberId: leave.MemberId,
          TeacherName: leave.Name,
          AttendanceDate: day,
          PunchInAt: existing?.PunchInAt || new Date(`${day}T09:00:00+05:30`),
          RequestedDayType: 'Full Day',
          RequestStatus: 'Approved',
          FinalAttendanceStatus: 'Leave',
          ApprovedDayType: 'Full Day',
          MarkedBy: 'Leave',
          TeacherRemark: leave.Reason,
          AdminRemark: 'Approved leave',
          ApprovedByName: leave.DecidedByName,
          ApprovedAt: new Date(),
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    )
  }
}

const stampStudentLeave = async (leave) => {
  const student = await studentModel.findOne({
    InstutionCode: leave.InstutionCode,
    Registration_Number: leave.MemberId,
  }).select('Class_Code Class SectionCode First_Name Last_Name').lean()
  if (!student) return
  const days = eachDate(leave.FromDate, leave.ToDate)
  for (const day of days) {
    const records = await attendenceRecordModel.find({
      InstutionId: leave.InstutionCode,
      Class_Code: student.Class_Code || student.Class,
    })
    for (const record of records) {
      const stored = String(record.Date || '')
      if (!stored.startsWith(day) && stored !== day) continue
      const subject = String(record.Subject || '')
      if (subject && !/whole day/i.test(subject)) continue
      const list = Array.isArray(record.Attendence) ? record.Attendence : []
      const index = list.findIndex((mark) => String(mark.StudentId || '').toLowerCase() === leave.MemberId.toLowerCase())
      const current = index >= 0 ? String(list[index].attendance || '').toLowerCase() : ''
      if (current === 'present' || current === 'p') continue
      const entry = {
        StudentId: leave.MemberId,
        StudentName: leave.Name,
        attendance: 'Leave',
      }
      if (index >= 0) list[index] = { ...list[index], ...entry }
      else list.push(entry)
      record.Attendence = list
      record.markModified('Attendence')
      await record.save()
    }
  }
}

const apply = async (req, res) => {
  try {
    const type = personTypeOf(req.user)
    if (type === 'Teacher' && !['teacher', 'mentor'].includes(roleOf(req.user.UserType))) {
      return res.status(403).json({ success: false, message: 'Use a student or teacher login to apply for leave' })
    }
    const from = String(req.body.from || '').trim()
    const to = String(req.body.to || from).trim()
    const reason = String(req.body.reason || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return res.status(400).json({ success: false, message: 'Choose a valid start and end date' })
    }
    if (eachDate(from, to).length > 31) {
      return res.status(400).json({ success: false, message: 'Leave can cover up to 31 school days at a time' })
    }
    if (reason.length < 5) return res.status(400).json({ success: false, message: 'Write a short reason for the leave' })
    const memberId = String(req.user.MemberId || '').trim()
    if (!memberId) return res.status(400).json({ success: false, message: 'Your account has no member id' })
    const clash = await SchoolLeave.findOne({
      InstutionCode: req.user.InstutionCode,
      PersonType: type,
      MemberId: memberId,
      Status: { $in: ['Pending', 'Approved'] },
      FromDate: { $lte: to },
      ToDate: { $gte: from },
    }).lean()
    if (clash) return res.status(409).json({ success: false, message: 'You already have leave covering these dates' })
    let className = ''
    if (type === 'Student') {
      const student = await studentModel.findOne({
        InstutionCode: req.user.InstutionCode,
        Registration_Number: memberId,
      }).select('Class').lean()
      className = student?.Class || ''
    }
    const leave = await SchoolLeave.create({
      InstutionCode: req.user.InstutionCode,
      PersonType: type,
      MemberId: memberId,
      Name: `${req.user.FirstName || ''} ${req.user.LastName || ''}`.trim() || memberId,
      ClassName: className,
      FromDate: from,
      ToDate: to,
      Reason: reason,
      Status: 'Pending',
    })
    return res.status(201).json({ success: true, message: 'Leave sent to the admin', data: leave })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not apply for leave' })
  }
}

const mine = async (req, res) => {
  const rows = await SchoolLeave.find({
    InstutionCode: req.user.InstutionCode,
    PersonType: personTypeOf(req.user),
    MemberId: String(req.user.MemberId || ''),
  }).sort({ createdAt: -1 }).limit(200).lean()
  const approved = rows.filter((row) => row.Status === 'Approved')
  const days = approved.reduce((sum, row) => sum + eachDate(row.FromDate, row.ToDate).length, 0)
  return res.status(200).json({ success: true, data: rows, summary: { approvedDays: days, pending: rows.filter((row) => row.Status === 'Pending').length } })
}

const list = async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ success: false, message: 'Only admin can see leave requests' })
  const filter = { InstutionCode: req.user.InstutionCode }
  if (req.query.personType) filter.PersonType = req.query.personType
  if (req.query.status) filter.Status = req.query.status
  const rows = await SchoolLeave.find(filter).sort({ createdAt: -1 }).limit(300).lean()
  return res.status(200).json({ success: true, data: rows })
}

const decide = async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, message: 'Only admin can decide leave' })
    const leave = await SchoolLeave.findOne({ _id: req.params.id, InstutionCode: req.user.InstutionCode })
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' })
    if (leave.Status !== 'Pending') return res.status(400).json({ success: false, message: 'This leave is already decided' })
    const approve = String(req.body.decision || '').toLowerCase() === 'approve'
    leave.Status = approve ? 'Approved' : 'Rejected'
    leave.AdminRemark = String(req.body.remark || '').trim()
    leave.DecidedByName = `${req.user.FirstName || ''} ${req.user.LastName || ''}`.trim()
    leave.DecidedAt = new Date()
    await leave.save()
    if (approve) {
      if (leave.PersonType === 'Teacher') await stampTeacherLeave(leave)
      else await stampStudentLeave(leave)
    }
    return res.status(200).json({ success: true, message: approve ? 'Leave approved' : 'Leave rejected', data: leave })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not update this leave' })
  }
}

module.exports = { apply, mine, list, decide }
