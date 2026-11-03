const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  OriginalName: String,
  StoredName: String,
  MimeType: String,
  Size: Number,
  Kind: { type: String, enum: ['image', 'pdf'] },
}, { _id: false });

const attemptSchema = new mongoose.Schema({
  TextAnswer: { type: String, default: '' },
  Files: [fileSchema],
  SubmittedAt: Date,
  Timing: { type: String, enum: ['On time', 'Late'] },
  Marks: Number,
  Feedback: { type: String, default: '' },
  Status: { type: String, enum: ['Submitted', 'Graded', 'Returned'] },
}, { timestamps: false });

const assignmentSchema = new mongoose.Schema({
  InstutionCode: { type: String, required: true, index: true },
  Title: { type: String, required: true },
  Instructions: { type: String, required: true },
  ClassCode: { type: String, required: true, index: true },
  ClassName: { type: String, required: true },
  SectionCode: { type: String, default: '' },
  SectionName: { type: String, default: '' },
  Subject: { type: String, required: true },
  DueAt: { type: Date, required: true },
  TotalMarks: { type: Number, default: 10 },
  SubmitBy: [{ type: String, enum: ['text', 'image', 'pdf'] }],
  AllowLate: { type: Boolean, default: true },
  Status: { type: String, enum: ['Open', 'Closed'], default: 'Open', index: true },
  ReferenceFiles: [fileSchema],
  AssignedBy: { type: String, default: '' },
}, { timestamps: true });

const submissionSchema = new mongoose.Schema({
  InstutionCode: { type: String, required: true, index: true },
  AssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolAssignment', required: true, index: true },
  RegistrationNumber: { type: String, required: true, index: true },
  StudentName: { type: String, default: '' },
  TextAnswer: { type: String, default: '' },
  Files: [fileSchema],
  SubmittedAt: Date,
  Timing: { type: String, enum: ['On time', 'Late'] },
  Status: { type: String, enum: ['Submitted', 'Graded', 'Returned'], default: 'Submitted' },
  Marks: Number,
  Feedback: { type: String, default: '' },
  GradedBy: { type: String, default: '' },
  GradedAt: Date,
  Attempts: [attemptSchema],
}, { timestamps: true });

submissionSchema.index({ InstutionCode: 1, AssignmentId: 1, RegistrationNumber: 1 }, { unique: true });

module.exports = {
  SchoolAssignment: mongoose.model('SchoolAssignment', assignmentSchema),
  AssignmentSubmission: mongoose.model('AssignmentSubmission', submissionSchema),
};
