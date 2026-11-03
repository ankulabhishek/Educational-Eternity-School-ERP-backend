const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const fetch = global.fetch
const StudyChat = require('../models/studyChatModel')
const studentModel = require('../models/studentModel')
const { logger } = require('../utils/logger')

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_SECRET_KEY || process.env.OPENAI_KEY
const IMAGE_DIR = path.join(__dirname, '..', 'uploads', 'mentor')

const ownerId = (req) => String(req.user?.userId || req.user?._id || req.user?.UserName || '').trim()

const systemPrompt = (who) => `You are Study Mentor, a kind school tutor.
You help students from Class 1 to Class 10, and you also help their teachers.
The person you are talking to is ${who}.
Rules:
- Explain in simple words. For Class 1 to 5, use very short sentences and a daily-life example. For Class 6 to 10, show clear steps.
- If they are a teacher, offer a short explanation they can use in class, plus one easy example.
- Teach the method. Do not only hand over a final exam answer.
- Write in Markdown: short headings, numbered steps, and **bold** for the important words.
- When a diagram helps, add one simple mermaid diagram in a fenced block marked mermaid. Use flowchart TD or a mindmap. Keep the labels short.
- When a realistic picture would help a child understand, add one separate line exactly like this: IMAGE: a short safe description of an educational picture
- Reply in the language the person used. Simple Hindi or Hinglish is welcome.
- Stay suitable for children. Do not discuss marks, fees, or private school records.`

const audience = async (req) => {
  if (String(req.user?.UserType || '') !== 'Student') return 'a teacher who teaches Class 1 to Class 10'
  const student = await studentModel.findOne({
    InstutionCode: req.user.InstutionCode,
    Registration_Number: req.user.MemberId,
  }).select('Class First_Name').lean()
  if (!student) return 'a school student between Class 1 and Class 10'
  return `a student in ${student.Class || 'school'}, Class 1 to Class 10 range`
}

const chatWithModel = async (messages) => {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      temperature: 0.6,
      max_tokens: 1200,
      messages,
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    logger.error('OpenAI chat error', { status: response.status, detail: detail.slice(0, 400) })
    throw new Error('The study mentor could not answer just now')
  }
  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

const drawPicture = async (description) => {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || 'dall-e-3',
      prompt: `Simple, friendly educational illustration for a child in school. No words in the picture. ${description}`,
      size: '1024x1024',
      response_format: 'b64_json',
      n: 1,
    }),
  })
  if (!response.ok) return ''
  const data = await response.json()
  const b64 = data.data?.[0]?.b64_json
  if (!b64) return ''
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  const filename = `${crypto.randomBytes(12).toString('hex')}.png`
  fs.writeFileSync(path.join(IMAGE_DIR, filename), Buffer.from(b64, 'base64'))
  return filename
}

const attachPicture = async (content) => {
  const match = content.match(/^IMAGE:\s*(.+)$/m)
  if (!match) return content
  try {
    const filename = await drawPicture(match[1].trim())
    if (!filename) return content.replace(match[0], '')
    return content.replace(match[0], `![${match[1].trim()}](mentor:${filename})`)
  } catch (error) {
    logger.warn('Study mentor image skipped', { message: error.message })
    return content.replace(match[0], '')
  }
}

const history = async (req, res) => {
  const chat = await StudyChat.findOne({ InstutionCode: req.user.InstutionCode, UserId: ownerId(req) }).lean()
  return res.status(200).json({ success: true, data: chat?.messages || [] })
}

const clearHistory = async (req, res) => {
  const chat = await StudyChat.findOne({ InstutionCode: req.user.InstutionCode, UserId: ownerId(req) })
  if (chat) {
    const names = JSON.stringify(chat.messages).match(/mentor:([A-Za-z0-9]+\.png)/g) || []
    names.forEach((token) => {
      fs.unlink(path.join(IMAGE_DIR, token.replace('mentor:', '')), () => {})
    })
    await chat.deleteOne()
  }
  return res.status(200).json({ success: true, message: 'Chat cleared' })
}

const sendMessage = async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ success: false, message: 'The study mentor is not set up yet' })
    const id = ownerId(req)
    if (!id) return res.status(400).json({ success: false, message: 'Your account could not be recognised' })
    const text = String(req.body.text || req.body.message || '').trim()
    if (!text) return res.status(400).json({ success: false, message: 'Type a question first' })
    if (text.length > 4000) return res.status(400).json({ success: false, message: 'Please ask a shorter question' })

    let chat = await StudyChat.findOne({ InstutionCode: req.user.InstutionCode, UserId: id })
    if (!chat) chat = new StudyChat({ InstutionCode: req.user.InstutionCode, UserId: id, messages: [] })
    chat.messages.push({ role: 'user', content: text })
    const recent = chat.messages.slice(-16).map((item) => ({ role: item.role, content: item.content }))
    let answer = await chatWithModel([
      { role: 'system', content: systemPrompt(await audience(req)) },
      ...recent,
    ])
    answer = (await attachPicture(answer)).trim()
    if (!answer) return res.status(500).json({ success: false, message: 'The study mentor sent an empty answer' })
    chat.messages.push({ role: 'assistant', content: answer })
    await chat.save()
    return res.status(200).json({
      success: true,
      data: { message: { role: 'assistant', content: answer } },
    })
  } catch (error) {
    logger.error('Study mentor failed', { message: error.message })
    return res.status(500).json({ success: false, message: error.message || 'Could not reach the study mentor' })
  }
}

const image = async (req, res) => {
  const filename = path.basename(String(req.params.filename || ''))
  if (!/^[a-f0-9]+\.png$/.test(filename)) return res.status(404).json({ success: false, message: 'Picture not found' })
  const full = path.join(IMAGE_DIR, filename)
  if (!fs.existsSync(full)) return res.status(404).json({ success: false, message: 'Picture not found' })
  const chat = await StudyChat.findOne({
    InstutionCode: req.user.InstutionCode,
    UserId: ownerId(req),
    'messages.content': new RegExp(filename),
  }).select('_id').lean()
  if (!chat) return res.status(403).json({ success: false, message: 'You cannot open this picture' })
  res.setHeader('Content-Type', 'image/png')
  return fs.createReadStream(full).pipe(res)
}

module.exports = { history, clearHistory, sendMessage, image }
