const mongoose = require('mongoose')
const teacherModel = require('../models/teacherModel')
const { TeacherSalary, TeacherSalaryPayment } = require('../models/teacherSalaryModel')
const { loadSchoolProfile } = require('../utils/schoolProfile')

const currentMonthKey = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)

const roleOf = (user) => String(user?.UserType || '').trim().toLowerCase().replace(/\s+/g, '')

const isPayrollUser = (user) =>
  ['admin', 'superadmin', 'accountant', 'accountscoordinator', 'accountcoordinator'].includes(roleOf(user))

const isTeacherUser = (user) => ['teacher', 'mentor'].includes(roleOf(user))

const isSuperAdminUser = (user) => roleOf(user) === 'superadmin'

const money = (value) => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return 0
  return Math.round(amount * 100) / 100
}

const monthKeyOk = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''))

const addMonths = (month, count) => {
  const [year, mon] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, mon - 1 + count, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

const monthsFrom = (start, end) => {
  if (!monthKeyOk(start) || !monthKeyOk(end) || start > end) return []
  const months = []
  let cursor = start
  while (cursor <= end && months.length < 240) {
    months.push(cursor)
    cursor = addMonths(cursor, 1)
  }
  return months
}

const componentsFrom = (body) => {
  const earnings = {
    Basic: money(body.Basic),
    HRA: money(body.HRA),
    SpecialAllowance: money(body.SpecialAllowance),
    OtherAllowance: money(body.OtherAllowance),
    Bonus: money(body.Bonus),
  }
  const deductions = {
    ProvidentFund: money(body.ProvidentFund),
    ProfessionalTax: money(body.ProfessionalTax),
    Tds: money(body.Tds),
    OtherDeduction: money(body.OtherDeduction),
  }
  const MonthlyGross = Object.values(earnings).reduce((sum, value) => sum + value, 0)
  const MonthlyDeduction = Object.values(deductions).reduce((sum, value) => sum + value, 0)
  return {
    ...earnings,
    ...deductions,
    MonthlyGross: money(MonthlyGross),
    MonthlyDeduction: money(MonthlyDeduction),
    MonthlyNet: money(MonthlyGross - MonthlyDeduction),
  }
}

const paidByMonth = (payments) => {
  const map = new Map()
  payments.forEach((payment) => {
    const month = payment.Month
    map.set(month, money((map.get(month) || 0) + money(payment.PaidAmount)))
  })
  return map
}

const buildSummary = (structure, payments, asOf = currentMonthKey()) => {
  if (!structure) {
    return {
      defined: false,
      currentMonth: asOf,
      monthlyNet: 0,
      currentMonthDue: 0,
      currentMonthPaid: 0,
      currentMonthPending: 0,
      previousPending: 0,
      totalDue: 0,
      months: [],
    }
  }
  const paid = paidByMonth(payments)
  const months = monthsFrom(structure.EffectiveFrom, asOf).map((month) => {
    const due = money(structure.MonthlyNet)
    const paidAmount = money(paid.get(month) || 0)
    const pending = money(Math.max(0, due - paidAmount))
    return {
      month,
      due,
      paid: paidAmount,
      pending,
      status: pending === 0 ? 'Paid' : paidAmount > 0 ? 'Partial' : 'Pending',
    }
  })
  const current = months.find((row) => row.month === asOf) || { due: 0, paid: 0, pending: 0 }
  const previousPending = money(months.filter((row) => row.month < asOf).reduce((sum, row) => sum + row.pending, 0))
  return {
    defined: true,
    currentMonth: asOf,
    monthlyNet: money(structure.MonthlyNet),
    currentMonthDue: money(current.due),
    currentMonthPaid: money(current.paid),
    currentMonthPending: money(current.pending),
    previousPending,
    totalDue: money(previousPending + current.pending),
    months,
  }
}

const findOwnTeacher = async (req) => {
  const code = req.user.InstutionCode
  const memberId = String(req.user.MemberId || '').trim()
  if (memberId) {
    const byCode = await teacherModel.findOne({ InstutionCode: code, Staff_Code: memberId, Status: true }).lean()
    if (byCode) return byCode
  }
  const email = String(req.user.Email || req.user.UserName || '').trim()
  if (!email) return null
  return teacherModel.findOne({ InstutionCode: code, Email: email, Status: true }).lean()
}

const assertTeacher = async (req, memberId) => {
  const teacher = await teacherModel.findOne({
    InstutionCode: req.user.InstutionCode,
    Staff_Code: memberId,
  }).lean()
  return teacher
}

const publicStructure = (row) => {
  if (!row) return null
  return {
    TeacherMemberId: row.TeacherMemberId,
    TeacherName: row.TeacherName,
    Designation: row.Designation,
    JoiningDate: row.JoiningDate,
    EffectiveFrom: row.EffectiveFrom,
    Basic: row.Basic,
    HRA: row.HRA,
    SpecialAllowance: row.SpecialAllowance,
    OtherAllowance: row.OtherAllowance,
    Bonus: row.Bonus,
    ProvidentFund: row.ProvidentFund,
    ProfessionalTax: row.ProfessionalTax,
    Tds: row.Tds,
    OtherDeduction: row.OtherDeduction,
    MonthlyGross: row.MonthlyGross,
    MonthlyDeduction: row.MonthlyDeduction,
    MonthlyNet: row.MonthlyNet,
    BankName: row.BankName,
    AccountHolder: row.AccountHolder,
    AccountNumber: row.AccountNumber,
    Ifsc: row.Ifsc,
    BranchName: row.BranchName,
    UpiId: row.UpiId,
    PanNumber: row.PanNumber,
    Note: row.Note,
  }
}

const teacherPack = async (code, memberId, asOf) => {
  const [structure, payments] = await Promise.all([
    TeacherSalary.findOne({ InstutionCode: code, TeacherMemberId: memberId }).lean(),
    TeacherSalaryPayment.find({ InstutionCode: code, TeacherMemberId: memberId }).sort({ PaymentDate: -1, createdAt: -1 }).lean(),
  ])
  return {
    structure: publicStructure(structure),
    summary: buildSummary(structure, payments, asOf),
    payments,
  }
}

const overview = async (req, res) => {
  try {
    if (!isPayrollUser(req.user)) return res.status(403).json({ success: false, message: 'You cannot view salary for the school' })
    const code = req.user.InstutionCode
    const asOf = monthKeyOk(req.query.month) ? req.query.month : currentMonthKey()
    const [teachers, structures, payments] = await Promise.all([
      teacherModel.find({ InstutionCode: code, Status: true }).sort({ First_Name: 1 }).lean(),
      TeacherSalary.find({ InstutionCode: code }).lean(),
      TeacherSalaryPayment.find({ InstutionCode: code, Month: { $lte: asOf } }).lean(),
    ])
    const structureByTeacher = new Map(structures.map((row) => [row.TeacherMemberId, row]))
    const paymentsByTeacher = new Map()
    payments.forEach((payment) => {
      if (!paymentsByTeacher.has(payment.TeacherMemberId)) paymentsByTeacher.set(payment.TeacherMemberId, [])
      paymentsByTeacher.get(payment.TeacherMemberId).push(payment)
    })
    const rows = teachers.map((teacher) => {
      const structure = structureByTeacher.get(teacher.Staff_Code)
      const summary = buildSummary(structure, paymentsByTeacher.get(teacher.Staff_Code) || [], asOf)
      return {
        TeacherMemberId: teacher.Staff_Code,
        TeacherName: `${teacher.First_Name || ''} ${teacher.Last_Name || ''}`.trim(),
        Designation: structure?.Designation || 'Teacher',
        defined: summary.defined,
        monthlyNet: summary.monthlyNet,
        EffectiveFrom: structure?.EffectiveFrom || '',
        Basic: structure?.Basic || 0,
        HRA: structure?.HRA || 0,
        SpecialAllowance: structure?.SpecialAllowance || 0,
        OtherAllowance: structure?.OtherAllowance || 0,
        Bonus: structure?.Bonus || 0,
        ProvidentFund: structure?.ProvidentFund || 0,
        ProfessionalTax: structure?.ProfessionalTax || 0,
        Tds: structure?.Tds || 0,
        OtherDeduction: structure?.OtherDeduction || 0,
        MonthlyGross: structure?.MonthlyGross || 0,
        MonthlyDeduction: structure?.MonthlyDeduction || 0,
        BankName: structure?.BankName || '',
        AccountNumber: structure?.AccountNumber || '',
        Ifsc: structure?.Ifsc || '',
        UpiId: structure?.UpiId || '',
        PanNumber: structure?.PanNumber || '',
        previousPending: summary.previousPending,
        currentMonthDue: summary.currentMonthDue,
        currentMonthPaid: summary.currentMonthPaid,
        currentMonthPending: summary.currentMonthPending,
        totalDue: summary.totalDue,
      }
    })
    const totals = rows.reduce((sum, row) => ({
      monthlyNet: money(sum.monthlyNet + row.monthlyNet),
      previousPending: money(sum.previousPending + row.previousPending),
      currentMonthDue: money(sum.currentMonthDue + row.currentMonthDue),
      currentMonthPaid: money(sum.currentMonthPaid + row.currentMonthPaid),
      currentMonthPending: money(sum.currentMonthPending + row.currentMonthPending),
      totalDue: money(sum.totalDue + row.totalDue),
    }), { monthlyNet: 0, previousPending: 0, currentMonthDue: 0, currentMonthPaid: 0, currentMonthPending: 0, totalDue: 0 })
    return res.status(200).json({ success: true, data: { month: asOf, rows, totals } })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load salary' })
  }
}

const detail = async (req, res) => {
  try {
    if (!isPayrollUser(req.user)) return res.status(403).json({ success: false, message: 'You cannot view this salary' })
    const memberId = String(req.params.memberId || '').trim()
    const teacher = await assertTeacher(req, memberId)
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found in this school' })
    const asOf = monthKeyOk(req.query.month) ? req.query.month : currentMonthKey()
    const pack = await teacherPack(req.user.InstutionCode, memberId, asOf)
    return res.status(200).json({
      success: true,
      data: {
        teacher: {
          TeacherMemberId: teacher.Staff_Code,
          TeacherName: `${teacher.First_Name || ''} ${teacher.Last_Name || ''}`.trim(),
          JoiningDate: teacher.joining_Date || '',
        },
        ...pack,
      },
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load this teacher salary' })
  }
}

const mine = async (req, res) => {
  try {
    if (!isTeacherUser(req.user) && !isPayrollUser(req.user)) {
      return res.status(403).json({ success: false, message: 'You cannot view salary' })
    }
    const teacher = isPayrollUser(req.user) && req.query.memberId
      ? await assertTeacher(req, String(req.query.memberId))
      : await findOwnTeacher(req)
    if (!teacher) return res.status(404).json({ success: false, message: 'No teacher profile is linked to this login' })
    const pack = await teacherPack(req.user.InstutionCode, teacher.Staff_Code, currentMonthKey())
    return res.status(200).json({
      success: true,
      data: {
        teacher: {
          TeacherMemberId: teacher.Staff_Code,
          TeacherName: `${teacher.First_Name || ''} ${teacher.Last_Name || ''}`.trim(),
          JoiningDate: teacher.joining_Date || '',
        },
        ...pack,
      },
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load your salary' })
  }
}

const saveStructure = async (req, res) => {
  try {
    if (!isPayrollUser(req.user)) return res.status(403).json({ success: false, message: 'You cannot set a salary' })
    const memberId = String(req.body.TeacherMemberId || '').trim()
    const teacher = await assertTeacher(req, memberId)
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found in this school' })
    if (!monthKeyOk(req.body.EffectiveFrom)) {
      return res.status(400).json({ success: false, message: 'Choose the month this salary starts' })
    }
    const amounts = componentsFrom(req.body)
    if (amounts.MonthlyNet <= 0) {
      return res.status(400).json({ success: false, message: 'Monthly salary after deductions must be more than zero' })
    }
    const saved = await TeacherSalary.findOneAndUpdate(
      { InstutionCode: req.user.InstutionCode, TeacherMemberId: memberId },
      {
        $set: {
          InstutionCode: req.user.InstutionCode,
          TeacherMemberId: memberId,
          TeacherName: `${teacher.First_Name || ''} ${teacher.Last_Name || ''}`.trim(),
          Designation: String(req.body.Designation || 'Teacher').trim() || 'Teacher',
          JoiningDate: teacher.joining_Date || '',
          EffectiveFrom: req.body.EffectiveFrom,
          ...amounts,
          BankName: String(req.body.BankName || '').trim(),
          AccountHolder: String(req.body.AccountHolder || '').trim(),
          AccountNumber: String(req.body.AccountNumber || '').trim(),
          Ifsc: String(req.body.Ifsc || '').trim().toUpperCase(),
          BranchName: String(req.body.BranchName || '').trim(),
          UpiId: String(req.body.UpiId || '').trim(),
          PanNumber: String(req.body.PanNumber || '').trim().toUpperCase(),
          Note: String(req.body.Note || '').trim(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean()
    return res.status(200).json({ success: true, message: 'Salary saved', data: publicStructure(saved) })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not save the salary' })
  }
}

const pay = async (req, res) => {
  try {
    if (!isPayrollUser(req.user)) return res.status(403).json({ success: false, message: 'You cannot record a salary payment' })
    const memberId = String(req.body.TeacherMemberId || '').trim()
    const month = String(req.body.Month || '').trim()
    const paidAmount = money(req.body.PaidAmount)
    const mode = String(req.body.PaymentMode || '').trim()
    const paymentDate = String(req.body.PaymentDate || '').trim()
    if (!['Cash', 'Cheque', 'UPI', 'Bank transfer'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Choose cash, cheque, UPI, or bank transfer' })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      return res.status(400).json({ success: false, message: 'Choose the payment date' })
    }
    if (!monthKeyOk(month) || month > currentMonthKey()) {
      return res.status(400).json({ success: false, message: 'Choose a salary month up to the current month' })
    }
    if (paidAmount <= 0) return res.status(400).json({ success: false, message: 'Enter the amount paid' })
    const structure = await TeacherSalary.findOne({ InstutionCode: req.user.InstutionCode, TeacherMemberId: memberId }).lean()
    if (!structure) return res.status(400).json({ success: false, message: 'Set this teacher’s salary before recording a payment' })
    if (month < structure.EffectiveFrom) {
      return res.status(400).json({ success: false, message: 'This month is before the salary start month' })
    }
    const existing = await TeacherSalaryPayment.find({
      InstutionCode: req.user.InstutionCode,
      TeacherMemberId: memberId,
      Month: month,
    }).lean()
    const already = money(existing.reduce((sum, row) => sum + money(row.PaidAmount), 0))
    const due = money(structure.MonthlyNet)
    const remaining = money(due - already)
    if (paidAmount - remaining > 0.001) {
      return res.status(400).json({ success: false, message: `Only Rs. ${remaining} is still due for ${month}` })
    }
    const receiptNo = `SAL-${String(req.user.InstutionCode).replace(/[^A-Za-z0-9]/g, '')}-${month.replace('-', '')}-${Date.now().toString().slice(-8)}`
    const monthPaidAfter = money(already + paidAmount)
    const payment = await TeacherSalaryPayment.create({
      InstutionCode: req.user.InstutionCode,
      TeacherMemberId: memberId,
      TeacherName: structure.TeacherName,
      Designation: structure.Designation,
      Month: month,
      ReceiptNo: receiptNo,
      SalaryDue: due,
      PaidAmount: paidAmount,
      MonthPaidAfter: monthPaidAfter,
      MonthBalanceAfter: money(due - monthPaidAfter),
      PaymentDate: paymentDate,
      PaymentMode: mode,
      Reference: String(req.body.Reference || '').trim(),
      Note: String(req.body.Note || '').trim(),
      PaidByName: `${req.user.FirstName || ''} ${req.user.LastName || ''}`.trim() || req.user.UserName || 'School',
      Basic: structure.Basic,
      HRA: structure.HRA,
      SpecialAllowance: structure.SpecialAllowance,
      OtherAllowance: structure.OtherAllowance,
      Bonus: structure.Bonus,
      ProvidentFund: structure.ProvidentFund,
      ProfessionalTax: structure.ProfessionalTax,
      Tds: structure.Tds,
      OtherDeduction: structure.OtherDeduction,
      MonthlyGross: structure.MonthlyGross,
      MonthlyDeduction: structure.MonthlyDeduction,
      MonthlyNet: structure.MonthlyNet,
      PanNumber: structure.PanNumber,
      BankName: structure.BankName,
      AccountNumber: structure.AccountNumber,
      Ifsc: structure.Ifsc,
      UpiId: structure.UpiId,
    })
    return res.status(200).json({ success: true, message: 'Salary payment recorded', data: payment })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not record the salary payment' })
  }
}

const listPayments = async (req, res) => {
  try {
    if (!isPayrollUser(req.user)) return res.status(403).json({ success: false, message: 'You cannot view salary payments' })
    const from = monthKeyOk(req.query.from) ? req.query.from : addMonths(currentMonthKey(), -11)
    const to = monthKeyOk(req.query.to) ? req.query.to : currentMonthKey()
    const filter = { InstutionCode: req.user.InstutionCode, Month: { $gte: from, $lte: to } }
    const memberId = String(req.query.teacher || '').trim()
    if (memberId) filter.TeacherMemberId = memberId
    const payments = await TeacherSalaryPayment.find(filter).sort({ Month: -1, PaymentDate: -1 }).lean()
    return res.status(200).json({ success: true, data: payments })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load salary payments' })
  }
}

const slip = async (req, res) => {
  try {
    const payment = await TeacherSalaryPayment.findOne({
      _id: req.params.id,
      InstutionCode: req.user.InstutionCode,
    }).lean()
    if (!payment) return res.status(404).json({ success: false, message: 'Salary slip not found' })
    if (!isPayrollUser(req.user)) {
      if (!isTeacherUser(req.user)) return res.status(403).json({ success: false, message: 'You cannot open this salary slip' })
      const teacher = await findOwnTeacher(req)
      if (!teacher || teacher.Staff_Code !== payment.TeacherMemberId) {
        return res.status(403).json({ success: false, message: 'You can download only your own salary slip' })
      }
    }
    let school
    try {
      school = await loadSchoolProfile(req)
    } catch (error) {
      const message = String(error.message || '').includes('school name')
        ? 'Add the school name in Settings before a salary slip can be issued'
        : error.message
      return res.status(error.status || 400).json({ success: false, message })
    }
    return res.status(200).json({ success: true, data: { school, payment } })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not prepare the salary slip' })
  }
}

const recomputeMonth = async (code, memberId, month) => {
  if (!month) return
  const structure = await TeacherSalary.findOne({ InstutionCode: code, TeacherMemberId: memberId }).lean()
  const payments = await TeacherSalaryPayment.find({
    InstutionCode: code,
    TeacherMemberId: memberId,
    Month: month,
  }).sort({ PaymentDate: 1, createdAt: 1 })
  let running = 0
  for (const payment of payments) {
    const due = money(structure?.MonthlyNet ?? payment.SalaryDue)
    running = money(running + money(payment.PaidAmount))
    payment.SalaryDue = due
    payment.MonthPaidAfter = running
    payment.MonthBalanceAfter = money(due - running)
    await payment.save()
  }
}

const updatePayment = async (req, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ success: false, message: 'Only Super Admin can change a salary payment' })
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Payment not found' })
    }
    const payment = await TeacherSalaryPayment.findOne({
      _id: req.params.id,
      InstutionCode: req.user.InstutionCode,
    })
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' })
    const previousMonth = payment.Month
    const month = monthKeyOk(req.body.Month) ? String(req.body.Month) : payment.Month
    if (month > currentMonthKey()) {
      return res.status(400).json({ success: false, message: 'Choose a salary month up to the current month' })
    }
    const paidAmount = req.body.PaidAmount === undefined ? money(payment.PaidAmount) : money(req.body.PaidAmount)
    if (paidAmount <= 0) return res.status(400).json({ success: false, message: 'Enter the amount paid' })
    const mode = req.body.PaymentMode ? String(req.body.PaymentMode).trim() : payment.PaymentMode
    if (!['Cash', 'Cheque', 'UPI', 'Bank transfer'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Choose cash, cheque, UPI, or bank transfer' })
    }
    const paymentDate = req.body.PaymentDate ? String(req.body.PaymentDate).trim() : payment.PaymentDate
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      return res.status(400).json({ success: false, message: 'Choose the payment date' })
    }
    const structure = await TeacherSalary.findOne({
      InstutionCode: req.user.InstutionCode,
      TeacherMemberId: payment.TeacherMemberId,
    }).lean()
    if (structure && month < structure.EffectiveFrom) {
      return res.status(400).json({ success: false, message: 'This month is before the salary start month' })
    }
    const others = await TeacherSalaryPayment.find({
      InstutionCode: req.user.InstutionCode,
      TeacherMemberId: payment.TeacherMemberId,
      Month: month,
      _id: { $ne: payment._id },
    }).lean()
    const already = money(others.reduce((sum, row) => sum + money(row.PaidAmount), 0))
    const due = money(structure?.MonthlyNet ?? payment.SalaryDue)
    const remaining = money(due - already)
    const reducing = month === previousMonth && paidAmount + 0.001 < money(payment.PaidAmount)
    if (structure && paidAmount - remaining > 0.001 && !reducing) {
      return res.status(400).json({
        success: false,
        message: remaining > 0
          ? `Only Rs. ${remaining} is still due for ${month}`
          : 'This month is already fully paid. Lower this amount before saving.',
      })
    }
    payment.Month = month
    payment.PaidAmount = paidAmount
    payment.PaymentMode = mode
    payment.PaymentDate = paymentDate
    if (req.body.Reference !== undefined) payment.Reference = String(req.body.Reference || '').trim()
    if (req.body.Note !== undefined) payment.Note = String(req.body.Note || '').trim()
    await payment.save()
    await recomputeMonth(req.user.InstutionCode, payment.TeacherMemberId, month)
    if (previousMonth !== month) await recomputeMonth(req.user.InstutionCode, payment.TeacherMemberId, previousMonth)
    const fresh = await TeacherSalaryPayment.findById(payment._id).lean()
    return res.status(200).json({ success: true, message: 'Salary payment updated', data: fresh })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not update the salary payment' })
  }
}

const removePayment = async (req, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ success: false, message: 'Only Super Admin can delete a salary payment' })
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Payment not found' })
    }
    const payment = await TeacherSalaryPayment.findOneAndDelete({
      _id: req.params.id,
      InstutionCode: req.user.InstutionCode,
    }).lean()
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' })
    await recomputeMonth(req.user.InstutionCode, payment.TeacherMemberId, payment.Month)
    return res.status(200).json({ success: true, message: 'Salary payment deleted' })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not delete the salary payment' })
  }
}

const removeStructure = async (req, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ success: false, message: 'Only Super Admin can delete a salary' })
    }
    const memberId = String(req.params.memberId || '').trim()
    const removed = await TeacherSalary.findOneAndDelete({
      InstutionCode: req.user.InstutionCode,
      TeacherMemberId: memberId,
    }).lean()
    if (!removed) return res.status(404).json({ success: false, message: 'No salary is set for this teacher' })
    return res.status(200).json({ success: true, message: 'Salary removed. Payment history is still kept until you delete each payment.' })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not delete the salary' })
  }
}

module.exports = {
  overview,
  detail,
  mine,
  saveStructure,
  pay,
  listPayments,
  slip,
  updatePayment,
  removePayment,
  removeStructure,
}
