const mongoose = require('mongoose')

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
}, { timestamps: true })

const studyChatSchema = new mongoose.Schema({
  InstutionCode: { type: String, required: true, index: true },
  UserId: { type: String, required: true, index: true },
  messages: [messageSchema],
}, { timestamps: true })

studyChatSchema.index({ InstutionCode: 1, UserId: 1 }, { unique: true })

module.exports = mongoose.model('StudyChat', studyChatSchema)
