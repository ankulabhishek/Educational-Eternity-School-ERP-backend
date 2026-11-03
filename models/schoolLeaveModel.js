const mongoose = require('mongoose')

const schoolLeaveSchema = new mongoose.Schema({
  InstutionCode: { type: String, required: true, index: true },
  PersonType: { type: String, enum: ['Teacher', 'Student'], required: true, index: true },
  MemberId: { type: String, required: true, index: true },
  Name: { type: String, required: true },
  ClassName: { type: String, default: '' },
  FromDate: { type: String, required: true },
  ToDate: { type: String, required: true },
  Reason: { type: String, required: true },
  Status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending', index: true },
  AdminRemark: { type: String, default: '' },
  DecidedByName: { type: String, default: '' },
  DecidedAt: { type: Date, default: null },
}, { timestamps: true })

schoolLeaveSchema.index({ InstutionCode: 1, PersonType: 1, MemberId: 1, FromDate: 1 })

module.exports = mongoose.model('SchoolLeave', schoolLeaveSchema)
