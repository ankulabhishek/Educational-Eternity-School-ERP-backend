const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')
const mongoose = require('mongoose')
const Institution = require('../models/InstutionModel')
const User = require('../models/User')
const AuditLog = require('../models/auditLogModel')
const studentModel = require('../models/studentModel')
const classModel = require('../models/classModel')
const teacherModel = require('../models/teacherModel')
const feePaymentModel = require('../models/feePaymentModel')
const feeStructureModel = require('../models/feeStructureModel')
const studentFeeDetailsModel = require('../models/studentFeeDetailsModel')
const bankInfoModel = require('../models/instutionBankInfo')
const { HostelFeePayment } = require('../models/hostelModel')
const { logger } = require('../utils/logger')
const { FEATURE_KEYS, normalizeFeatures } = require('../utils/schoolFeatures')

const safeUser = (user) => {
  if (!user) return null
  const row = typeof user.toObject === 'function' ? user.toObject() : { ...user }
  delete row.Password
  return row
}

const findInstitution = async (code) => {
  const institutionCode = String(code || '').trim()
  if (!institutionCode) return null
  return Institution.findOne({ Instution_Id: institutionCode })
}

const loadAllModels = () => {
  const dir = path.join(__dirname, '..', 'models')
  fs.readdirSync(dir)
    .filter((file) => file.endsWith('.js'))
    .forEach((file) => {
      try {
        require(path.join(dir, file))
      } catch (error) {
        if (!String(error.message || '').includes('Cannot overwrite')) throw error
      }
    })
}

const detail = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const code = institution.Instution_Id
    const [admins, users, students, classes, teachers, feePayments, feeStructures, hostelFees, studentFeeRows, bankDetails, logins] = await Promise.all([
      User.find({ InstutionCode: code, UserType: 'Admin' }).select('-Password').sort({ createdAt: 1 }).lean(),
      User.countDocuments({ InstutionCode: code }),
      studentModel.countDocuments({ InstutionCode: code }),
      classModel.countDocuments({ InstutionCode: code }),
      teacherModel.countDocuments({ InstutionCode: code }),
      feePaymentModel.countDocuments({ InstutionId: code }),
      feeStructureModel.countDocuments({ InstutionId: code }),
      HostelFeePayment.countDocuments({ InstutionCode: code }),
      studentFeeDetailsModel.countDocuments({ InstutionCode: code }),
      bankInfoModel.countDocuments({ InstutionId: code }),
      AuditLog.find({
        InstutionCode: code,
        EventType: { $in: ['LOGIN', 'LOGIN_FAILED'] },
      }).sort({ ActionAt: -1 }).limit(30).lean(),
    ])
    return res.status(200).json({
      success: true,
      data: {
        institution,
        admins,
        counts: {
          users,
          students,
          classes,
          teachers,
          admins: admins.length,
          feePayments,
          feeStructures,
          hostelFees,
          studentFeeRows,
          bankDetails,
        },
        logins,
      },
    })
  } catch (error) {
    logger.error('Institution detail failed', { message: error.message })
    return res.status(500).json({ success: false, message: 'Could not open this school' })
  }
}

const updateInstitution = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const body = req.body || {}
    const next = {
      Instution_Name: String(body.Instution_Name || institution.Instution_Name || '').trim(),
      Email: String(body.Email || '').trim().toLowerCase(),
      Contact_Number: String(body.Contact_Number || '').trim(),
      Secondary_Contact: String(body.Secondary_Contact || '').trim(),
      Address: String(body.Address || '').trim(),
      State: String(body.State || '').trim(),
      District: String(body.District || '').trim(),
      Url: String(body.Url || '').trim().replace(/\/$/, ''),
      ChairMan_Name: String(body.ChairMan_Name || '').trim(),
      Director_Name: String(body.Director_Name || '').trim(),
      Registar_Name: String(body.Registar_Name || '').trim(),
      Registration_Id: String(body.Registration_Id || '').trim(),
      Affiliation: String(body.Affiliation || '').trim(),
      instution_Type: String(body.instution_Type || 'School').trim(),
    }
    if (next.Instution_Name.length < 3) return res.status(400).json({ success: false, message: 'School name is too short' })
    if (!next.Email || !next.Contact_Number || !next.Address || !next.State || !next.District || !next.Url) {
      return res.status(400).json({ success: false, message: 'Name, email, phone, address, state, district, and website are required' })
    }
    const members = String(body.Management_Member || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    next.Management_Member = members.length ? members : institution.Management_Member
    const clash = await Institution.findOne({
      _id: { $ne: institution._id },
      $or: [{ Email: next.Email }, { Contact_Number: next.Contact_Number }, { Url: next.Url }],
    }).select('Email Contact_Number Url').lean()
    if (clash) return res.status(409).json({ success: false, message: 'Email, phone, or website is already used by another school' })
    Object.assign(institution, next)
    await institution.save()
    if (institution.Instution_Name) {
      await User.updateMany(
        { InstutionCode: institution.Instution_Id },
        { $set: { InstutionName: institution.Instution_Name } }
      )
    }
    return res.status(200).json({ success: true, message: 'School details saved', data: institution })
  } catch (error) {
    logger.error('Institution update failed', { message: error.message })
    return res.status(500).json({ success: false, message: 'Could not save the school' })
  }
}

const removeInstitution = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const confirm = String(req.body.confirmCode || req.query.confirmCode || '').trim()
    if (confirm !== institution.Instution_Id) {
      return res.status(400).json({ success: false, message: 'Type the school code to confirm delete' })
    }
    const code = institution.Instution_Id
    loadAllModels()
    const fields = ['InstutionCode', 'InstutionId', 'Instution_Id', 'Instution_Code']
    const removed = []
    for (const name of Object.keys(mongoose.models)) {
      if (name === 'Instution') continue
      const model = mongoose.models[name]
      const or = fields.filter((field) => model.schema.path(field)).map((field) => ({ [field]: code }))
      if (!or.length) continue
      const filter = name === 'User'
        ? { $and: [{ $or: or }, { UserType: { $ne: 'SuperAdmin' } }] }
        : { $or: or }
      const result = await model.deleteMany(filter)
      if (result.deletedCount) removed.push({ collection: name, deleted: result.deletedCount })
    }
    await Institution.deleteOne({ _id: institution._id })
    return res.status(200).json({
      success: true,
      message: 'School and its records were deleted',
      data: { removed },
    })
  } catch (error) {
    logger.error('Institution delete failed', { message: error.message })
    return res.status(500).json({ success: false, message: 'Could not delete this school' })
  }
}

const listUsers = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const q = String(req.query.q || '').trim()
    const filter = { InstutionCode: institution.Instution_Id, UserType: { $ne: 'SuperAdmin' } }
    if (q) {
      filter.$or = [
        { FirstName: { $regex: q, $options: 'i' } },
        { LastName: { $regex: q, $options: 'i' } },
        { Email: { $regex: q, $options: 'i' } },
        { UserName: { $regex: q, $options: 'i' } },
        { UserType: { $regex: q, $options: 'i' } },
        { MemberId: { $regex: q, $options: 'i' } },
      ]
    }
    const users = await User.find(filter).select('-Password').sort({ UserType: 1, FirstName: 1 }).limit(500).lean()
    return res.status(200).json({ success: true, data: users })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load users' })
  }
}

const createAdmin = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const first = String(req.body.FirstName || '').trim()
    const last = String(req.body.LastName || '').trim()
    const email = String(req.body.Email || '').trim().toLowerCase()
    const phone = String(req.body.Phone || '').trim()
    const username = String(req.body.UserName || email).trim()
    const password = String(req.body.Password || '')
    if (first.length < 2 || last.length < 2) return res.status(400).json({ success: false, message: 'Enter the admin first and last name' })
    if (!email.includes('@') || phone.length < 10) return res.status(400).json({ success: false, message: 'Enter a valid email and a 10-digit phone' })
    if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' })
    const existing = await User.findOne({ $or: [{ Email: email }, { UserName: username }] }).select('_id').lean()
    if (existing) return res.status(409).json({ success: false, message: 'Email or username is already used' })
    const admin = await User.create({
      FirstName: first,
      LastName: last,
      Email: email,
      Phone: phone,
      UserName: username,
      Password: await bcrypt.hash(password, 10),
      InstutionCode: institution.Instution_Id,
      InstutionName: institution.Instution_Name,
      MemberId: `${institution.Instution_Id}-ADMIN-${Date.now().toString().slice(-6)}`,
      UserType: 'Admin',
      PermissionSet: 'all',
      Verified: true,
      Active: true,
    })
    return res.status(201).json({ success: true, message: 'Admin created', data: safeUser(admin) })
  } catch (error) {
    logger.error('Create admin failed', { message: error.message })
    return res.status(500).json({ success: false, message: 'Could not create the admin' })
  }
}

const updateAdmin = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const admin = await User.findOne({
      _id: req.params.userId,
      InstutionCode: institution.Instution_Id,
      UserType: 'Admin',
    })
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' })
    const first = String(req.body.FirstName || admin.FirstName).trim()
    const last = String(req.body.LastName || admin.LastName).trim()
    const email = String(req.body.Email || admin.Email).trim().toLowerCase()
    const phone = String(req.body.Phone || admin.Phone).trim()
    const username = String(req.body.UserName || admin.UserName).trim()
    const clash = await User.findOne({
      _id: { $ne: admin._id },
      $or: [{ Email: email }, { UserName: username }],
    }).select('_id').lean()
    if (clash) return res.status(409).json({ success: false, message: 'Email or username is already used' })
    admin.FirstName = first
    admin.LastName = last
    admin.Email = email
    admin.Phone = phone
    admin.UserName = username
    if (typeof req.body.Active === 'boolean') admin.Active = req.body.Active
    await admin.save()
    return res.status(200).json({ success: true, message: 'Admin updated', data: safeUser(admin) })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not update the admin' })
  }
}

const deleteAdmin = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const admin = await User.findOneAndDelete({
      _id: req.params.userId,
      InstutionCode: institution.Instution_Id,
      UserType: 'Admin',
    })
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' })
    return res.status(200).json({ success: true, message: 'Admin deleted' })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not delete the admin' })
  }
}

const resetPassword = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const password = String(req.body.password || '')
    if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' })
    const user = await User.findOne({
      _id: req.params.userId,
      InstutionCode: institution.Instution_Id,
      UserType: { $ne: 'SuperAdmin' },
    })
    if (!user) return res.status(404).json({ success: false, message: 'User not found in this school' })
    user.Password = await bcrypt.hash(password, 10)
    await user.save()
    return res.status(200).json({
      success: true,
      message: `Password updated for ${user.FirstName} ${user.LastName}`.trim(),
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not update the password' })
  }
}

const FEE_RECORD_KINDS = ['payments', 'structures', 'hostelFees', 'studentFeeRows', 'bank', 'balances']

const clearFeeRecords = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const confirm = String(req.body.confirmCode || '').trim()
    if (confirm !== institution.Instution_Id) {
      return res.status(400).json({ success: false, message: 'Type the school code to confirm' })
    }
    const kinds = [...new Set((Array.isArray(req.body.kinds) ? req.body.kinds : []).filter((kind) => FEE_RECORD_KINDS.includes(kind)))]
    if (!kinds.length) {
      return res.status(400).json({ success: false, message: 'Choose at least one kind of fee record' })
    }
    const code = institution.Instution_Id
    const removed = {}

    if (kinds.includes('payments')) {
      const result = await feePaymentModel.deleteMany({ InstutionId: code })
      removed.payments = result.deletedCount || 0
    }
    if (kinds.includes('structures')) {
      const result = await feeStructureModel.deleteMany({ InstutionId: code })
      removed.structures = result.deletedCount || 0
    }
    if (kinds.includes('hostelFees')) {
      const result = await HostelFeePayment.deleteMany({ InstutionCode: code })
      removed.hostelFees = result.deletedCount || 0
    }
    if (kinds.includes('studentFeeRows')) {
      const result = await studentFeeDetailsModel.deleteMany({ InstutionCode: code })
      removed.studentFeeRows = result.deletedCount || 0
    }
    if (kinds.includes('bank')) {
      const result = await bankInfoModel.deleteMany({ InstutionId: code })
      removed.bank = result.deletedCount || 0
    }
    if (kinds.includes('balances') || kinds.includes('payments')) {
      const result = await studentModel.updateMany(
        { InstutionCode: code },
        { $set: { OutstandingAmount: '0', AdvanceFeeCredit: '0' } }
      )
      removed.balances = result.modifiedCount || 0
    }

    return res.status(200).json({
      success: true,
      message: 'Fee records for this school were deleted',
      data: removed,
    })
  } catch (error) {
    logger.error('Fee record delete failed', { message: error.message })
    return res.status(500).json({ success: false, message: 'Could not delete the fee records' })
  }
}

const getMyFeatures = async (req, res) => {
  try {
    const code = String(req.user?.InstutionCode || '').trim()
    if (!code) return res.status(200).json({ success: true, data: normalizeFeatures(null) })
    const institution = await Institution.findOne({ Instution_Id: code }).select('Features').lean()
    return res.status(200).json({ success: true, data: normalizeFeatures(institution?.Features) })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load school features' })
  }
}

const updateFeatures = async (req, res) => {
  try {
    const institution = await findInstitution(req.params.code)
    if (!institution) return res.status(404).json({ success: false, message: 'School not found' })
    const incoming = req.body?.features && typeof req.body.features === 'object' ? req.body.features : req.body || {}
    const current = normalizeFeatures(institution.Features)
    FEATURE_KEYS.forEach((key) => {
      if (typeof incoming[key] === 'boolean') current[key] = incoming[key]
    })
    institution.Features = current
    institution.markModified('Features')
    await institution.save()
    return res.status(200).json({ success: true, message: 'Features updated', data: current })
  } catch (error) {
    logger.error('Feature update failed', { message: error.message })
    return res.status(500).json({ success: false, message: 'Could not update features' })
  }
}

module.exports = {
  detail,
  updateInstitution,
  removeInstitution,
  getMyFeatures,
  updateFeatures,
  listUsers,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  resetPassword,
  clearFeeRecords,
}
