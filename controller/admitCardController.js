const studentModel = require('../models/studentModel')
const classModel = require('../models/classModel')
const examScheduleModel = require('../models/examScheduleModel')
const { loadSchoolProfile } = require('../utils/schoolProfile')
const { resolveOwnStudentRegistration } = require('../utils/studentPortalAccess')
const PDFDocument = require('pdfkit')

const STAFF = new Set(['admin', 'superadmin', 'examination staff', 'mentor', 'teacher'])

const isStaff = (req) => STAFF.has(String(req.user?.UserType || '').trim().toLowerCase())

const studentName = (student) => `${student.First_Name || ''} ${student.Last_Name || ''}`.trim() || student.Registration_Number

const formatDate = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

const paperView = (exam) => ({
  subject: exam.Subject || '',
  date: formatDate(exam.ExamDate),
  start: exam.StartTime || '',
  end: exam.EndTime || '',
  room: exam.Venue || '',
  section: exam.SectionName || '',
})

const loadPapers = async (instutionCode, classCode, sectionCode, examName) => {
  const rows = await examScheduleModel.find({
    InstutionCode: instutionCode,
    ClassCode: classCode,
    Status: { $ne: 'Cancelled' },
    $or: [{ ExamName: examName }, { ExamType: examName }],
  }).sort({ ExamDate: 1, StartTime: 1 }).lean()

  return rows.filter((row) => {
    const section = String(row.SectionCode || '').trim()
    if (!section) return true
    if (!sectionCode) return true
    return section === sectionCode || row.SectionName === sectionCode
  })
}

const papersForStudent = (papers, student) => papers.filter((row) => {
  const section = String(row.SectionCode || '').trim()
  if (!section) return true
  return section === student.SectionCode || row.SectionName === student.Section
})

const loadStudents = async (instutionCode, classCode, className, sectionCode) => {
  const rows = await studentModel.find({
    InstutionCode: instutionCode,
    Status: true,
    $or: [{ Class_Code: classCode }, { Class: className || classCode }, { Class: classCode }],
  }).select('First_Name Last_Name Registration_Number Class Class_Code Section SectionCode Father_Name').lean()

  const matched = sectionCode
    ? rows.filter((student) => student.SectionCode === sectionCode || student.Section === sectionCode)
    : rows
  return matched.sort((a, b) => studentName(a).localeCompare(studentName(b)))
}

const schoolOrError = async (req, res) => {
  try {
    return await loadSchoolProfile(req)
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: 'Add the school name in Settings before printing admit cards.',
    })
    return null
  }
}

const drawCard = (doc, school, student, examName, papers) => {
  const left = 36
  const width = doc.page.width - 72
  doc.rect(24, 24, doc.page.width - 48, doc.page.height - 48).stroke()
  doc.font('Helvetica-Bold').fontSize(16).text(school.name, left, 40, { width, align: 'center' })
  if (school.addressLine) {
    doc.font('Helvetica').fontSize(9).text(school.addressLine, left, doc.y + 2, { width, align: 'center' })
  }
  doc.moveDown(0.4)
  doc.font('Helvetica-Bold').fontSize(13).text('ADMIT CARD', { width, align: 'center' })
  doc.font('Helvetica').fontSize(11).text(examName, { width, align: 'center' })
  doc.moveDown(0.6)

  const details = [
    ['Student', studentName(student)],
    ['Roll number', student.Registration_Number || ''],
    ['Class', student.Class || student.Class_Code || ''],
    ['Section', student.Section || 'All'],
    ['Father', student.Father_Name || ''],
  ]
  details.forEach(([label, value]) => {
    doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, left, doc.y, { continued: true, width })
    doc.font('Helvetica').text(value || '—')
  })

  doc.moveDown(0.8)
  const columns = [90, 160, 130, width - 380]
  const headers = ['Date', 'Subject', 'Time', 'Room']
  const headerY = doc.y
  doc.rect(left, headerY, width, 18).fill('#1e3a8a')
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
  let x = left + 4
  headers.forEach((header, index) => {
    doc.text(header, x, headerY + 4, { width: columns[index] - 6 })
    x += columns[index]
  })
  doc.fillColor('#000000')
  let y = headerY + 18

  papers.forEach((paper, index) => {
    if (y > doc.page.height - 120) {
      doc.addPage()
      y = 48
    }
    const rowHeight = 20
    if (index % 2 === 0) {
      doc.rect(left, y, width, rowHeight).fill('#f8fafc')
      doc.fillColor('#000000')
    }
    const cells = [
      paper.date,
      paper.subject,
      [paper.start, paper.end].filter(Boolean).join(' - '),
      paper.room,
    ]
    doc.font('Helvetica').fontSize(9)
    x = left + 4
    cells.forEach((cell, cellIndex) => {
      doc.fillColor('#000000').text(cell || '—', x, y + 5, { width: columns[cellIndex] - 6, height: rowHeight - 4 })
      x += columns[cellIndex]
    })
    y += rowHeight
  })

  doc.y = Math.max(y + 16, doc.page.height - 150)
  doc.font('Helvetica').fontSize(9).fillColor('#000000')
  doc.text('Bring this card to every exam. Reach the room 15 minutes early. Phones are not allowed.', left, doc.y, { width })
  doc.moveDown(2)
  const signY = doc.y
  doc.text('Student', left, signY)
  doc.text('Class teacher', left + 180, signY)
  doc.text('Principal', left + 360, signY)
}

const sendPdf = async (res, filename, cards) => {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
  const doc = new PDFDocument({ size: 'A4', margin: 36 })
  doc.pipe(res)
  cards.forEach((card, index) => {
    if (index > 0) doc.addPage()
    drawCard(doc, card.school, card.student, card.examName, card.papers.map(paperView))
  })
  doc.end()
}

const preview = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot open admit cards' })
    const classCode = String(req.query.ClassCode || '').trim()
    const examName = String(req.query.examName || '').trim()
    const sectionCode = String(req.query.SectionCode || '').trim()
    if (!classCode || !examName) {
      return res.status(400).json({ success: false, message: 'Choose the class and the exam' })
    }
    const classInfo = await classModel.findOne({ InstutionCode: req.user.InstutionCode, ClassCode: classCode }).select('ClassName').lean()
    if (!classInfo) return res.status(404).json({ success: false, message: 'Class not found' })
    const papers = await loadPapers(req.user.InstutionCode, classCode, sectionCode, examName)
    const students = await loadStudents(req.user.InstutionCode, classCode, classInfo.ClassName, sectionCode)
    return res.status(200).json({
      success: true,
      data: {
        className: classInfo.ClassName,
        examName,
        papers: papers.map(paperView),
        students: students.map((student) => ({
          registrationNumber: student.Registration_Number,
          name: studentName(student),
          section: student.Section || '',
        })),
      },
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load the admit card details' })
  }
}

const generateStudentAdmitCard = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot print admit cards' })
    const school = await schoolOrError(req, res)
    if (!school) return
    const registrationNumber = String(req.query.registrationNumber || '').trim()
    const examName = String(req.query.examName || req.query.examType || '').trim()
    if (!registrationNumber || !examName) {
      return res.status(400).json({ success: false, message: 'Choose the student and the exam' })
    }
    const student = await studentModel.findOne({
      InstutionCode: req.user.InstutionCode,
      Registration_Number: registrationNumber,
      Status: true,
    }).lean()
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' })
    const classCode = student.Class_Code || req.query.ClassCode
    const papers = papersForStudent(
      await loadPapers(req.user.InstutionCode, classCode, student.SectionCode || '', examName),
      student
    )
    if (!papers.length) return res.status(404).json({ success: false, message: 'No exam dates found for this student' })
    await sendPdf(res, `AdmitCard_${registrationNumber}.pdf`, [{ school, student, examName, papers }])
  } catch (error) {
    if (!res.headersSent) return res.status(500).json({ success: false, message: 'Could not create the admit card' })
  }
}

const generateClassAdmitCards = async (req, res) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ success: false, message: 'You cannot print admit cards' })
    const school = await schoolOrError(req, res)
    if (!school) return
    const classCode = String(req.query.ClassCode || '').trim()
    const sectionCode = String(req.query.SectionCode || '').trim()
    const examName = String(req.query.examName || req.query.examType || '').trim()
    if (!classCode || !examName) {
      return res.status(400).json({ success: false, message: 'Choose the class and the exam' })
    }
    const classInfo = await classModel.findOne({ InstutionCode: req.user.InstutionCode, ClassCode: classCode }).select('ClassName').lean()
    if (!classInfo) return res.status(404).json({ success: false, message: 'Class not found' })
    const papers = await loadPapers(req.user.InstutionCode, classCode, sectionCode, examName)
    const students = await loadStudents(req.user.InstutionCode, classCode, classInfo.ClassName, sectionCode)
    const cards = students.map((student) => ({
      school,
      student,
      examName,
      papers: papersForStudent(papers, student),
    })).filter((card) => card.papers.length)
    if (!cards.length) return res.status(404).json({ success: false, message: 'No students or exam dates found for this class' })
    await sendPdf(res, `AdmitCards_${classInfo.ClassName}.pdf`, cards)
  } catch (error) {
    if (!res.headersSent) return res.status(500).json({ success: false, message: 'Could not create the admit cards' })
  }
}

const mine = async (req, res) => {
  try {
    const resolved = resolveOwnStudentRegistration(req)
    if (resolved.error) return res.status(resolved.error.status).json({ success: false, message: resolved.error.message })
    if (String(req.user?.UserType || '') !== 'Student') {
      return res.status(403).json({ success: false, message: 'Only a student can open their own admit card' })
    }
    const student = await studentModel.findOne({
      InstutionCode: req.user.InstutionCode,
      Registration_Number: resolved.registrationNumber,
      Status: true,
    }).lean()
    if (!student) return res.status(404).json({ success: false, message: 'Student record not found' })
    const classCode = student.Class_Code
    const exams = await examScheduleModel.find({
      InstutionCode: req.user.InstutionCode,
      Status: { $ne: 'Cancelled' },
      $or: [{ ClassCode: classCode }, { ClassName: student.Class || '' }],
    }).sort({ ExamDate: 1 }).lean()
    const visible = exams.filter((exam) => {
      const section = String(exam.SectionCode || '').trim()
      return !section || section === student.SectionCode || exam.SectionName === student.Section
    })
    const names = [...new Set(visible.map((exam) => exam.ExamName).filter(Boolean))]
    const examName = String(req.query.examName || '').trim()
    if (!examName) {
      return res.status(200).json({
        success: true,
        data: {
          className: student.Class || '',
          sectionName: student.Section || '',
          exams: names.map((name) => ({
            examName: name,
            papers: visible.filter((exam) => exam.ExamName === name).map(paperView),
          })),
        },
      })
    }
    const school = await schoolOrError(req, res)
    if (!school) return
    const papers = visible.filter((exam) => exam.ExamName === examName || exam.ExamType === examName)
    if (!papers.length) return res.status(404).json({ success: false, message: 'No exam dates found' })
    await sendPdf(res, `AdmitCard_${student.Registration_Number}.pdf`, [{ school, student, examName, papers }])
  } catch (error) {
    if (!res.headersSent) return res.status(500).json({ success: false, message: 'Could not open your admit card' })
  }
}

module.exports = {
  preview,
  generateStudentAdmitCard,
  generateClassAdmitCards,
  mine,
}
