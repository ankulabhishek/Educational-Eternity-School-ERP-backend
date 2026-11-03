const bcrypt = require('bcryptjs')
const classModel = require('../models/classModel')
const sectionModel = require('../models/sectionModel')
const teacherModel = require('../models/teacherModel')
const studentModel = require('../models/studentModel')
const userModel = require('../models/User')
const { getPermissionSet } = require('./permissionAssinment')
const { generateRegistrationNumber } = require('./studentController')

const text = (value) => String(value ?? '').trim()

const dateOnly = (value) => {
  if (!value) return ''
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${value.getFullYear()}-${month}-${day}`
  }
  const raw = text(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const parts = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/)
  if (parts) return `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`
  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) {
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const day = String(parsed.getDate()).padStart(2, '0')
    return `${parsed.getFullYear()}-${month}-${day}`
  }
  return ''
}

const rowsOf = (body) => (Array.isArray(body?.rows) ? body.rows : null)

const requireWrite = async (req, key) => {
  const permissions = await getPermissionSet(req)
  return Boolean(permissions?.[key] && String(permissions[key]).split('-').includes('W'))
}

const schoolName = (req) => text(req.user?.InstutionName) || 'School'

const importClasses = async (req, res) => {
  try {
    if (!(await requireWrite(req, 'classes'))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot add classes' })
    }
    const rows = rowsOf(req.body)
    if (!rows) return res.status(400).json({ success: false, code: 400, message: 'The Excel sheet has no records' })
    if (rows.length > 500) return res.status(400).json({ success: false, code: 400, message: 'Import up to 500 classes at a time' })

    const code = req.user.InstutionCode
    const year = new Date().getFullYear().toString().slice(-2)
    let created = 0
    let unchanged = 0
    const errors = []

    for (const row of rows) {
      const line = row.row || ''
      const className = text(row.className)
      const session = text(row.session)
      try {
        if (!className || !session) {
          errors.push({ row: line, message: 'Class name and session are required' })
          continue
        }
        const cleanName = className.replace(/\s+/g, '').toLowerCase()
        const classCode = `${code}-${cleanName}-${year}`
        let classRecord = await classModel.findOne({ ClassCode: classCode, InstutionCode: code })
        if (!classRecord) {
          classRecord = await classModel.create({
            ClassCode: classCode,
            InstutionCode: code,
            ClassName: className,
            Session: session,
            Session_Start_Day: dateOnly(row.sessionStart) || undefined,
            Session_End_Day: dateOnly(row.sessionEnd) || undefined,
          })
          created += 1
        } else {
          unchanged += 1
        }

        const sectionNames = text(row.sections).split(/[,;/|]/).map((name) => name.trim()).filter(Boolean)
        for (const sectionName of sectionNames) {
          const sectionCode = `${classRecord.ClassCode}_${sectionName}`
          const existing = await sectionModel.findOne({ SectionCode: sectionCode, InstutionCode: code })
          if (existing) continue
          await sectionModel.create({
            ClassCode: classRecord.ClassCode,
            InstutionCode: code,
            SectionCode: sectionCode,
            SectionName: sectionName,
            NumberOfStudent: 0,
            SessionTeacherName: 'Not assigned',
          })
        }

        const subjectNames = text(row.subjects).split(/[,;/|]/).map((name) => name.trim()).filter(Boolean)
        if (subjectNames.length) {
          const existingSubjects = Array.isArray(classRecord.Subject_List_Teacher_Code)
            ? classRecord.Subject_List_Teacher_Code
            : []
          const known = new Set(existingSubjects.map((item) => text(item.Subject).toLowerCase()))
          const additions = []
          subjectNames.forEach((name) => {
            const key = name.toLowerCase()
            if (known.has(key)) return
            known.add(key)
            additions.push({
              Subject: name,
              Teacher_Code: '',
              Teacher_Name: '',
              Teacher_Id: null,
            })
          })
          if (additions.length) {
            classRecord.Subject_List_Teacher_Code = [...existingSubjects, ...additions]
            await classRecord.save()
          }
        }
      } catch (error) {
        errors.push({ row: line, message: error.code === 11000 ? `${className} already exists` : 'Could not add this class' })
      }
    }

    res.status(200).json({
      success: true,
      code: 200,
      message: `Added ${created} class${created === 1 ? '' : 'es'}`,
      data: { created, unchanged, errors },
    })
  } catch (error) {
    res.status(500).json({ success: false, code: 500, message: 'Could not import classes' })
  }
}

const importTeachers = async (req, res) => {
  try {
    if (!(await requireWrite(req, 'teachers'))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot add teachers' })
    }
    const rows = rowsOf(req.body)
    if (!rows) return res.status(400).json({ success: false, code: 400, message: 'The Excel sheet has no records' })
    if (rows.length > 500) return res.status(400).json({ success: false, code: 400, message: 'Import up to 500 teachers at a time' })

    const code = req.user.InstutionCode
    const institutionName = schoolName(req)
    let created = 0
    const errors = []
    const seenEmail = new Set()
    const seenAadhaar = new Set()

    for (const row of rows) {
      const line = row.row || ''
      const firstName = text(row.firstName)
      const lastName = text(row.lastName)
      const email = text(row.email).toLowerCase()
      const phone = text(row.phone)
      const subject = text(row.subject)
      const qualification = text(row.qualification)
      const experience = text(row.experience)
      const address = text(row.address)
      const state = text(row.state)
      const district = text(row.district)
      const aadhaar = text(row.aadhaar)
      const dob = dateOnly(row.dob)
      const joining = dateOnly(row.joiningDate) || new Date().toISOString().slice(0, 10)
      try {
        if (!firstName || !lastName || !email || !phone || !subject || !qualification || !experience || !address || !state || !district || !aadhaar || !dob) {
          errors.push({ row: line, message: 'Fill every column for this teacher, including date of birth' })
          continue
        }
        if (!email.includes('@')) {
          errors.push({ row: line, message: 'Email is not valid' })
          continue
        }
        if (seenEmail.has(email) || seenAadhaar.has(aadhaar)) {
          errors.push({ row: line, message: 'This teacher is repeated in the sheet' })
          continue
        }
        seenEmail.add(email)
        seenAadhaar.add(aadhaar)
        const existing = await teacherModel.findOne({
          InstutionCode: code,
          $or: [{ Email: email }, { Adhar: aadhaar }],
        }).lean()
        if (existing) {
          errors.push({ row: line, message: `${firstName} ${lastName} is already in the school` })
          continue
        }
        const staffCode = await generateStaffCode(code)
        const teacher = await teacherModel.create({
          Staff_Code: staffCode,
          First_Name: firstName,
          Last_Name: lastName,
          Email: email,
          Specialised_Subject: subject,
          Contact_Number: phone,
          Address: address,
          Qualification: qualification,
          joining_Date: joining,
          DOB: dob,
          State: state,
          District: district,
          Experience: experience,
          InstutionCode: code,
          Status: true,
          Adhar: aadhaar,
        })
        try {
          const existingUser = await userModel.findOne({ Email: email })
          if (!existingUser) {
            await userModel.create({
              FirstName: firstName,
              LastName: lastName,
              Email: email,
              Phone: phone,
              UserName: email,
              Password: await bcrypt.hash('Teacher@123', 10),
              UserType: 'Teacher',
              MemberId: staffCode,
              InstutionCode: code,
              InstutionName: institutionName,
              Verified: true,
            })
          }
        } catch (userError) {
          await teacherModel.deleteOne({ _id: teacher._id })
          throw userError
        }
        created += 1
      } catch (error) {
        errors.push({ row: line, message: error.code === 11000 ? 'This email or Aadhaar is already used' : 'Could not add this teacher' })
      }
    }

    res.status(200).json({
      success: true,
      code: 200,
      message: `Added ${created} teacher${created === 1 ? '' : 's'}`,
      data: { created, unchanged: 0, errors },
    })
  } catch (error) {
    res.status(500).json({ success: false, code: 500, message: 'Could not import teachers' })
  }
}

const generateStaffCode = async (instutionCode) => {
  const teachers = await teacherModel.find({ InstutionCode: instutionCode }).select('Staff_Code').lean()
  const maxNumber = teachers.reduce((max, teacher) => {
    const parts = String(teacher.Staff_Code || '').split('_')
    const number = parts[1] ? parseInt(parts[1], 10) : 0
    return Number.isFinite(number) && number > max ? number : max
  }, 0)
  return `${instutionCode}_${String(maxNumber + 1).padStart(3, '0')}`
}

const importStudents = async (req, res) => {
  try {
    if (!(await requireWrite(req, 'students'))) {
      return res.status(403).json({ success: false, code: 403, message: 'You cannot add students' })
    }
    const rows = rowsOf(req.body)
    if (!rows) return res.status(400).json({ success: false, code: 400, message: 'The Excel sheet has no records' })
    if (rows.length > 500) return res.status(400).json({ success: false, code: 400, message: 'Import up to 500 students at a time' })

    const code = req.user.InstutionCode
    const institutionName = schoolName(req)
    const classes = await classModel.find({ InstutionCode: code }).select('ClassCode ClassName').lean()
    const sections = await sectionModel.find({ InstutionCode: code }).select('SectionCode SectionName ClassCode').lean()
    let created = 0
    const errors = []
    const seenEmail = new Set()
    const seenAadhaar = new Set()

    for (const row of rows) {
      const line = row.row || ''
      const firstName = text(row.firstName)
      const lastName = text(row.lastName)
      const email = text(row.email).toLowerCase()
      const phone = text(row.phone)
      const className = text(row.className)
      const sectionName = text(row.section)
      const dob = dateOnly(row.dob)
      const aadhaar = text(row.aadhaar)
      const state = text(row.state)
      const district = text(row.district)
      const totalDue = text(row.totalDue).replace(/,/g, '')
      try {
        if (!firstName || !lastName || !email || !phone || !className || !dob || !aadhaar || !state || !district) {
          errors.push({ row: line, message: 'Fill the name, email, phone, class, date of birth, Aadhaar, state and district' })
          continue
        }
        if (!email.includes('@')) {
          errors.push({ row: line, message: 'Email is not valid' })
          continue
        }
        if (totalDue && !/^\d+(\.\d{1,2})?$/.test(totalDue)) {
          errors.push({ row: line, message: 'Total due must be a number, such as 0 or 1500' })
          continue
        }
        if (seenEmail.has(email) || seenAadhaar.has(aadhaar)) {
          errors.push({ row: line, message: 'This student is repeated in the sheet' })
          continue
        }
        seenEmail.add(email)
        seenAadhaar.add(aadhaar)
        const classRecord = classes.find((item) => text(item.ClassName).toLowerCase() === className.toLowerCase())
        if (!classRecord) {
          errors.push({ row: line, message: `Class "${className}" is not in the school yet. Import the class first.` })
          continue
        }
        let section = sections.find((item) => item.ClassCode === classRecord.ClassCode && text(item.SectionName).toLowerCase() === sectionName.toLowerCase())
        if (sectionName && !section) {
          section = await sectionModel.create({
            ClassCode: classRecord.ClassCode,
            InstutionCode: code,
            SectionCode: `${classRecord.ClassCode}_${sectionName}`,
            SectionName: sectionName,
            NumberOfStudent: 0,
            SessionTeacherName: 'Not assigned',
          })
          sections.push(section)
        }
        const registration = await generateRegistrationNumber(code, classRecord.ClassCode, section?.SectionName || '')
        const plainPassword = `${firstName}@${registration}`
        const student = await studentModel.create({
          First_Name: firstName,
          Last_Name: lastName,
          Email: email,
          Contact_Number: phone,
          Registration_Number: registration,
          Class: classRecord.ClassName,
          Class_Code: classRecord.ClassCode,
          Section: section?.SectionName || '',
          SectionCode: section?.SectionCode || '',
          DOB: dob,
          Gender: text(row.gender),
          Adhar: aadhaar,
          State: state,
          District: district,
          Father_Name: text(row.fatherName),
          Mother_Name: text(row.motherName),
          Address: text(row.address),
          OutstandingAmount: totalDue || '0',
          UsesTransport: false,
          Status: true,
          InstutionCode: code,
          Password: await bcrypt.hash(plainPassword, 10),
        })
        try {
          await userModel.create({
            FirstName: firstName,
            LastName: lastName,
            Email: email,
            Phone: phone,
            UserName: registration,
            Password: student.Password,
            UserType: 'Student',
            MemberId: registration,
            InstutionCode: code,
            InstutionName: institutionName,
            Verified: true,
          })
        } catch (userError) {
          await studentModel.deleteOne({ _id: student._id })
          throw userError
        }
        created += 1
      } catch (error) {
        errors.push({ row: line, message: error.code === 11000 ? 'This email, Aadhaar or roll number is already used' : 'Could not add this student' })
      }
    }

    res.status(200).json({
      success: true,
      code: 200,
      message: `Added ${created} student${created === 1 ? '' : 's'}`,
      data: { created, unchanged: 0, errors },
    })
  } catch (error) {
    res.status(500).json({ success: false, code: 500, message: 'Could not import students' })
  }
}

module.exports = { importClasses, importTeachers, importStudents }
