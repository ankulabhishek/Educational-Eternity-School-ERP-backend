const mongoose = require('mongoose')

const optionSchema = new mongoose.Schema(
  {
    Key: { type: String, required: true },
    Text: { type: String, required: true },
  },
  { _id: false }
)

const questionSchema = new mongoose.Schema(
  {
    InstutionCode: { type: String, required: true, index: true },
    Class: { type: String, required: true },
    ClassCode: { type: String, default: '' },
    Subject: { type: String, required: true },
    QuestionText: { type: String, required: true },
    Type: { type: String, enum: ['mcq', 'long'], required: true },
    Options: { type: [optionSchema], default: [] },
    CorrectOption: { type: String, default: '' },
    Marks: { type: Number, default: 1 },
    Status: { type: Boolean, default: true },
  },
  { timestamps: true }
)

questionSchema.index({ InstutionCode: 1, Class: 1, Subject: 1, Type: 1, Status: 1 })

const examSchema = new mongoose.Schema(
  {
    InstutionCode: { type: String, required: true, index: true },
    Title: { type: String, required: true },
    Class: { type: String, required: true },
    ClassCode: { type: String, default: '' },
    Section: { type: String, default: '' },
    Subject: { type: String, required: true },
    QuestionType: { type: String, enum: ['mcq', 'long', 'mixed'], default: 'mixed' },
    DurationMinutes: { type: Number, default: 30 },
    QuestionCount: { type: Number, default: 10 },
    ShuffleQuestions: { type: Boolean, default: true },
    Instructions: { type: String, default: '' },
    Mode: { type: String, enum: ['online', 'offline', 'both'], default: 'both' },
    Status: { type: String, enum: ['Draft', 'Published', 'Closed'], default: 'Draft' },
    StartsAt: { type: Date, default: null },
    EndsAt: { type: Date, default: null },
    OfflineQuestionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OnlineExamQuestion' }],
  },
  { timestamps: true }
)

const answerSchema = new mongoose.Schema(
  {
    Question_Id: { type: mongoose.Schema.Types.ObjectId, required: true },
    SelectedOption: { type: String, default: '' },
    LongAnswer: { type: String, default: '' },
    AwardedMarks: { type: Number, default: 0 },
  },
  { _id: false }
)

const attemptSchema = new mongoose.Schema(
  {
    InstutionCode: { type: String, required: true, index: true },
    Exam_Id: { type: mongoose.Schema.Types.ObjectId, ref: 'OnlineExam', required: true },
    Registration_Number: { type: String, required: true },
    StudentName: { type: String, default: '' },
    Class: { type: String, default: '' },
    QuestionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OnlineExamQuestion' }],
    Answers: { type: [answerSchema], default: [] },
    StartedAt: { type: Date, default: Date.now },
    EndsAt: { type: Date, required: true },
    SubmittedAt: { type: Date, default: null },
    Status: { type: String, enum: ['InProgress', 'Submitted', 'AutoSubmitted'], default: 'InProgress' },
    McqScore: { type: Number, default: 0 },
    LongScore: { type: Number, default: 0 },
    TotalScore: { type: Number, default: 0 },
    MaxScore: { type: Number, default: 0 },
  },
  { timestamps: true }
)

attemptSchema.index({ Exam_Id: 1, Registration_Number: 1 }, { unique: true })

const OnlineExamQuestion = mongoose.model('OnlineExamQuestion', questionSchema)
const OnlineExam = mongoose.model('OnlineExam', examSchema)
const OnlineExamAttempt = mongoose.model('OnlineExamAttempt', attemptSchema)

module.exports = {
  OnlineExamQuestion,
  OnlineExam,
  OnlineExamAttempt,
}
