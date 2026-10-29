const { response } = require('express')
const feeStructureModel = require('../models/feeStructureModel')
const ClassModel = require('../models/classModel')
const {
  STANDARD_FEE_HEADS,
  normalizeFrequency,
  sumHeadsByFrequency,
  buildHeadsFromStructure,
} = require('../utils/feeHeads')
const { serializeOtherFeeSubtypes } = require('../utils/otherFeeSubtypes')

const buildFrequencyPayload = (body, existing = {}) => {
  const payload = {}
  STANDARD_FEE_HEADS.forEach((head) => {
    const freqField = `${head.key}Frequency`
    const raw = body[freqField] !== undefined ? body[freqField] : existing[freqField]
    payload[freqField] = normalizeFrequency(raw, head.defaultFrequency)
  })
  return payload
}

const readStandardAmount = (body, key, fallback = 0) =>
  Number(body[key] !== undefined ? body[key] : fallback) || 0

const resolveOtherFeeJson = (body, existing = null) => {
  if (Array.isArray(body.OtherFeeSubtypes)) {
    return serializeOtherFeeSubtypes(body.OtherFeeSubtypes)
  }
  if (body.OtherFee !== undefined && body.OtherFee !== null && body.OtherFee !== '') {
    const raw = String(body.OtherFee).trim()
    if (raw.startsWith('[') || raw.startsWith('{')) return raw
    return serializeOtherFeeSubtypes([
      {
        name: 'Other Fee',
        amount: Number(body.OtherFee) || 0,
        frequency: body.OtherFeeFrequency || existing?.OtherFeeFrequency || 'monthly',
        key: 'OtherFee',
      },
    ])
  }
  return existing?.OtherFee || '[]'
}

const buildStructurePayload = (body, existing = null) => {
  const tution = readStandardAmount(body, 'TutionFee', existing?.TutionFee ?? 0)
  const library = readStandardAmount(body, 'LibraryFee', existing?.LibraryFee ?? 0)
  const activity = readStandardAmount(body, 'ActivityFee', existing?.ActivityFee ?? 0)
  const exam = readStandardAmount(body, 'ExamFee', existing?.ExamFee ?? 0)
  const uniform = readStandardAmount(body, 'UniformFee', existing?.UniformFee ?? 0)
  const prospectus = readStandardAmount(body, 'ProspectusFee', existing?.ProspectusFee ?? 0)
  const admission = readStandardAmount(body, 'AdmissionFee', existing?.AdmissionFee ?? 0)
  const transport = readStandardAmount(body, 'TransportFee', existing?.TransportFee ?? 0)
  const otherFeeJson = resolveOtherFeeJson(body, existing)
  const frequencyPayload = buildFrequencyPayload(body, existing || {})

  const structureForTotals = {
    TutionFee: tution.toString(),
    LibraryFee: library.toString(),
    ActivityFee: activity.toString(),
    ExamFee: exam.toString(),
    UniformFee: uniform.toString(),
    ProspectusFee: prospectus.toString(),
    AdmissionFee: admission.toString(),
    TransportFee: transport.toString(),
    OtherFee: otherFeeJson,
    ...frequencyPayload,
  }

  const monthlyTotal = sumHeadsByFrequency(structureForTotals, 'monthly')
  const yearlyTotal = sumHeadsByFrequency(structureForTotals, 'yearly')
  const totalfee = buildHeadsFromStructure(structureForTotals).reduce((sum, head) => sum + head.amount, 0)

  return {
    Class: body.Class ?? existing?.Class,
    Section: body.Section !== undefined ? body.Section || '' : existing?.Section || '',
    TutionFee: tution.toString(),
    LibraryFee: library.toString(),
    ActivityFee: activity.toString(),
    ExamFee: exam.toString(),
    UniformFee: uniform.toString(),
    ProspectusFee: prospectus.toString(),
    AdmissionFee: admission.toString(),
    TransportFee: transport.toString(),
    OtherFee: otherFeeJson,
    Total: totalfee.toString(),
    MonthlyTotal: monthlyTotal.toString(),
    YearlyTotal: yearlyTotal.toString(),
    ...frequencyPayload,
  }
}

let feeIndexesReady = false

const ensureFeeStructureIndexes = async () => {
  if (feeIndexesReady) return
  const indexes = await feeStructureModel.collection.indexes()
  const legacyNames = ['Class_1', 'InstutionId_1_Class_1_Section_1']
  for (const name of legacyNames) {
    const index = indexes.find((item) => item.name === name && item.unique)
    if (!index) continue
    await feeStructureModel.collection.dropIndex(name)
  }
  feeIndexesReady = true
}

const resolveSchoolClass = async (instutionCode, classId) => {
  if (!classId) return null
  return ClassModel.findOne({ _id: classId, InstutionCode: instutionCode }).lean()
}

const duplicateFeeMessage = (error) => {
  if (error?.code === 11000) {
    return 'A fee structure already exists for this class and section in your school.'
  }
  return error.message
}

const store = async (req, res) => {
  try {
    await ensureFeeStructureIndexes()
    const instutionCode = req.user.InstutionCode
    const schoolClass = await resolveSchoolClass(instutionCode, req.body.ClassId)
    if (!schoolClass) {
      return res.status(400).json({
        success: false,
        message: 'Select a class from this school.',
        code: 400,
      })
    }
    const payload = buildStructurePayload({
      ...req.body,
      Class: schoolClass.ClassName,
    })
    const feeStructure = await feeStructureModel.create({
      InstutionId: instutionCode,
      ClassId: schoolClass._id,
      ...payload,
    })
    res.status(201).json({
      success: true,
      message: 'Fee structure saved successfully!',
      code: 201,
      data: feeStructure,
    })
  } catch (error) {
    res.status(error?.code === 11000 ? 400 : 500).json({
      success: false,
      message: duplicateFeeMessage(error),
      code: error?.code === 11000 ? 400 : 500,
    })
  }
}

const show = async (req, res, next) => {
  try {
    const filter = {
      InstutionId: req.user.InstutionCode,
    }
    if (req.query.Class) {
      filter.Class = req.query.Class
    }
    if (req.query.Section) {
      filter.Section = req.query.Section
    }

    const feeStructureRecord = await feeStructureModel.find(filter)

    res.status(200).json({
      success: true,
      message: 'Fee structure fetched successfully!',
      code: 200,
      data: feeStructureRecord,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      code: 500,
    })
  }
}

const update = async (req, res) => {
  try {
    const id = req.body._id || req.body.feeStructureId
    if (!id) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: 'Fee structure id (_id) is required',
      })
    }

    const existing = await feeStructureModel.findById(id)
    if (!existing || existing.InstutionId !== req.user.InstutionCode) {
      return res.status(404).json({
        success: false,
        code: 404,
        message: 'Fee structure not found',
      })
    }

    await ensureFeeStructureIndexes()
    const schoolClass = await resolveSchoolClass(req.user.InstutionCode, req.body.ClassId || existing.ClassId)
    if (!schoolClass) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: 'Select a class from this school.',
      })
    }
    const payload = buildStructurePayload({ ...req.body, Class: schoolClass.ClassName }, existing)
    payload.ClassId = schoolClass._id

    const updated = await feeStructureModel.findByIdAndUpdate(
      id,
      { $set: payload },
      { new: true }
    )

    res.status(200).json({
      success: true,
      message: 'Fee structure updated successfully!',
      code: 200,
      data: updated,
    })
  } catch (error) {
    res.status(error?.code === 11000 ? 400 : 500).json({
      success: false,
      message: duplicateFeeMessage(error),
      code: error?.code === 11000 ? 400 : 500,
    })
  }
}

module.exports = {
  store,
  show,
  update,
}
