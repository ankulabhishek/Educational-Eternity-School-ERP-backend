const mongoose = require('mongoose')

const slcCertificateSchema = new mongoose.Schema({
  InstutionCode: { type: String, required: true, index: true },
  SLCNumber: { type: String, required: true },
  RegistrationNumber: { type: String, required: true },
  StudentName: { type: String, required: true },
  FatherName: { type: String, default: '' },
  MotherName: { type: String, default: '' },
  DOB: { type: String, default: '' },
  Gender: { type: String, default: '' },
  Address: { type: String, default: '' },
  ClassName: { type: String, default: '' },
  SectionName: { type: String, default: '' },
  DateOfAdmission: { type: String, default: '' },
  DateOfLeaving: { type: String, required: true },
  Reason: { type: String, required: true },
  Promoted: { type: Boolean, default: false },
  Conduct: { type: String, default: 'Good' },
  WorkingDays: { type: String, default: '' },
  AttendedDays: { type: String, default: '' },
  FeesCleared: { type: Boolean, default: true },
  MarkLeft: { type: Boolean, default: true },
  Remarks: { type: String, default: '' },
  IssuedBy: { type: String, default: '' },
}, { timestamps: true })

slcCertificateSchema.index({ InstutionCode: 1, RegistrationNumber: 1 }, { unique: true })
slcCertificateSchema.index({ InstutionCode: 1, SLCNumber: 1 }, { unique: true })

module.exports = mongoose.model('SlcCertificate', slcCertificateSchema)
