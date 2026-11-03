const mongoose = require('mongoose')

const Schema = mongoose.Schema

const teacherSalarySchema = new Schema(
  {
    InstutionCode: { type: String, required: true, index: true },
    TeacherMemberId: { type: String, required: true, index: true },
    TeacherName: { type: String, required: true },
    Designation: { type: String, default: 'Teacher' },
    JoiningDate: { type: String, default: '' },
    /** First month this salary applies, YYYY-MM */
    EffectiveFrom: { type: String, required: true },
    Basic: { type: Number, default: 0 },
    HRA: { type: Number, default: 0 },
    SpecialAllowance: { type: Number, default: 0 },
    OtherAllowance: { type: Number, default: 0 },
    Bonus: { type: Number, default: 0 },
    ProvidentFund: { type: Number, default: 0 },
    ProfessionalTax: { type: Number, default: 0 },
    Tds: { type: Number, default: 0 },
    OtherDeduction: { type: Number, default: 0 },
    MonthlyGross: { type: Number, default: 0 },
    MonthlyDeduction: { type: Number, default: 0 },
    MonthlyNet: { type: Number, required: true },
    BankName: { type: String, default: '' },
    AccountHolder: { type: String, default: '' },
    AccountNumber: { type: String, default: '' },
    Ifsc: { type: String, default: '' },
    BranchName: { type: String, default: '' },
    UpiId: { type: String, default: '' },
    PanNumber: { type: String, default: '' },
    Note: { type: String, default: '' },
  },
  { timestamps: true }
)

teacherSalarySchema.index({ InstutionCode: 1, TeacherMemberId: 1 }, { unique: true })

const teacherSalaryPaymentSchema = new Schema(
  {
    InstutionCode: { type: String, required: true, index: true },
    TeacherMemberId: { type: String, required: true, index: true },
    TeacherName: { type: String, required: true },
    Designation: { type: String, default: 'Teacher' },
    Month: { type: String, required: true, index: true },
    ReceiptNo: { type: String, required: true },
    SalaryDue: { type: Number, required: true },
    PaidAmount: { type: Number, required: true },
    MonthPaidAfter: { type: Number, default: 0 },
    MonthBalanceAfter: { type: Number, default: 0 },
    PaymentDate: { type: String, required: true },
    PaymentMode: {
      type: String,
      enum: ['Cash', 'Cheque', 'UPI', 'Bank transfer'],
      required: true,
    },
    Reference: { type: String, default: '' },
    Note: { type: String, default: '' },
    PaidByName: { type: String, default: '' },
    Basic: { type: Number, default: 0 },
    HRA: { type: Number, default: 0 },
    SpecialAllowance: { type: Number, default: 0 },
    OtherAllowance: { type: Number, default: 0 },
    Bonus: { type: Number, default: 0 },
    ProvidentFund: { type: Number, default: 0 },
    ProfessionalTax: { type: Number, default: 0 },
    Tds: { type: Number, default: 0 },
    OtherDeduction: { type: Number, default: 0 },
    MonthlyGross: { type: Number, default: 0 },
    MonthlyDeduction: { type: Number, default: 0 },
    MonthlyNet: { type: Number, default: 0 },
    PanNumber: { type: String, default: '' },
    BankName: { type: String, default: '' },
    AccountNumber: { type: String, default: '' },
    Ifsc: { type: String, default: '' },
    UpiId: { type: String, default: '' },
  },
  { timestamps: true }
)

teacherSalaryPaymentSchema.index({ InstutionCode: 1, ReceiptNo: 1 }, { unique: true })
teacherSalaryPaymentSchema.index({ InstutionCode: 1, TeacherMemberId: 1, Month: 1 })

module.exports = {
  TeacherSalary: mongoose.model('TeacherSalary', teacherSalarySchema),
  TeacherSalaryPayment: mongoose.model('TeacherSalaryPayment', teacherSalaryPaymentSchema),
}
