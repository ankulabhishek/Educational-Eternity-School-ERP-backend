const mongoose = require('mongoose')
const studentModel = require('../models/studentModel')
const { OnlineExamQuestion, OnlineExam, OnlineExamAttempt } = require('../models/onlineExamModel')
const { pickQuestions, publicQuestion, scoreAnswers } = require('../utils/onlineExamPaper')
const { resolveOwnStudentRegistration } = require('../utils/studentPortalAccess')
const { successResponse, errorResponse } = require('../utils/response')

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F']

const isStudent = (req) => String(req.user?.UserType || '').trim().toLowerCase() === 'student'

const schoolOf = (req) => String(req.user?.InstutionCode || '').trim()

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const requireStaff = (req, res) => {
  if (!schoolOf(req)) {
    errorResponse(res, 'Institution context not found', 401)
    return false
  }
  if (isStudent(req)) {
    errorResponse(res, 'Students cannot manage exams', 403)
    return false
  }
  return true
}

const normalizeOptions = (options) =>
  (Array.isArray(options) ? options : [])
    .map((option, index) => ({
      Key: String(option?.Key || OPTION_KEYS[index] || '').trim().toUpperCase(),
      Text: String(option?.Text || '').trim(),
    }))
    .filter((option) => option.Key && option.Text)
    .slice(0, 6)

const questionPayload = (body, existing = {}) => {
  const type = String(body.Type || existing.Type || '').trim().toLowerCase()
  const options = type === 'mcq' ? normalizeOptions(body.Options ?? existing.Options) : []
  const correct = type === 'mcq'
    ? String(body.CorrectOption ?? existing.CorrectOption ?? '').trim().toUpperCase()
    : ''
  return {
    Class: String(body.Class ?? existing.Class ?? '').trim(),
    ClassCode: String(body.ClassCode ?? existing.ClassCode ?? '').trim(),
    Subject: String(body.Subject ?? existing.Subject ?? '').trim(),
    QuestionText: String(body.QuestionText ?? existing.QuestionText ?? '').trim(),
    Type: type,
    Options: options,
    CorrectOption: correct,
    Marks: Math.max(1, Number(body.Marks ?? existing.Marks) || 1),
  }
}

const validateQuestion = (payload) => {
  if (!payload.Class || !payload.Subject || !payload.QuestionText) {
    return 'Class, subject, and question text are required'
  }
  if (!['mcq', 'long'].includes(payload.Type)) return 'Question type must be MCQ or long answer'
  if (payload.Type === 'mcq') {
    if (payload.Options.length < 2) return 'An MCQ needs at least two options'
    if (!payload.Options.some((option) => option.Key === payload.CorrectOption)) {
      return 'Choose the correct option'
    }
  }
  return ''
}

const classMatch = (exam, student) => {
  const studentValues = [student?.Class, student?.Class_Code]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  const examValues = [exam?.Class, exam?.ClassCode]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  return examValues.some((value) => studentValues.includes(value))
}

const sectionMatch = (exam, student) => {
  const examSection = String(exam?.Section || '').trim().toLowerCase()
  if (!examSection) return true
  const studentSections = [student?.Section, student?.SectionCode]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  return studentSections.includes(examSection)
}

const poolQuery = (exam) => {
  const classes = [exam.Class, exam.ClassCode].map((value) => String(value || '').trim()).filter(Boolean)
  return {
    InstutionCode: exam.InstutionCode,
    Status: true,
    Subject: new RegExp(`^${escapeRegex(exam.Subject)}$`, 'i'),
    $or: [
      { Class: { $in: classes } },
      { ClassCode: { $in: classes } },
    ],
    ...(exam.QuestionType === 'mixed' ? {} : { Type: exam.QuestionType }),
  }
}

const loadQuestionsByIds = (ids) =>
  OnlineExamQuestion.find({ _id: { $in: ids } }).then((rows) => {
    const byId = new Map(rows.map((row) => [String(row._id), row]))
    return ids.map((id) => byId.get(String(id))).filter(Boolean)
  })

const mergeStudentAnswers = (existing, incoming, questionIds) => {
  const allowed = new Set(questionIds.map((id) => String(id)))
  const previous = new Map((existing || []).map((answer) => [String(answer.Question_Id), answer]))
  ;(Array.isArray(incoming) ? incoming : []).forEach((answer) => {
    const id = String(answer?.Question_Id || '')
    if (!allowed.has(id)) return
    const prior = previous.get(id)
    previous.set(id, {
      Question_Id: answer.Question_Id,
      SelectedOption: String(answer.SelectedOption || '').trim().toUpperCase().slice(0, 2),
      LongAnswer: String(answer.LongAnswer || '').slice(0, 8000),
      AwardedMarks: Number(prior?.AwardedMarks) || 0,
    })
  })
  return [...previous.values()]
}

const finishAttempt = async (attempt, questions, answers) => {
  const scored = scoreAnswers(questions, answers)
  attempt.Answers = answers
  attempt.McqScore = scored.mcqScore
  attempt.LongScore = scored.longScore
  attempt.TotalScore = scored.totalScore
  attempt.MaxScore = scored.maxScore
  attempt.Status = attempt.Status === 'InProgress'
    ? (new Date(attempt.EndsAt).getTime() <= Date.now() ? 'AutoSubmitted' : 'Submitted')
    : attempt.Status
  if (!attempt.SubmittedAt) attempt.SubmittedAt = new Date()
  await attempt.save()
  return scored
}

const attemptView = (attempt, questions, { includeAnswers = false } = {}) => ({
  attemptId: attempt._id,
  status: attempt.Status,
  startedAt: attempt.StartedAt,
  endsAt: attempt.EndsAt,
  submittedAt: attempt.SubmittedAt,
  serverNow: new Date().toISOString(),
  answers: (attempt.Answers || []).map((answer) => ({
    Question_Id: answer.Question_Id,
    SelectedOption: answer.SelectedOption,
    LongAnswer: answer.LongAnswer,
    ...(includeAnswers ? { AwardedMarks: answer.AwardedMarks } : {}),
  })),
  questions: questions.map((question) => (
    includeAnswers
      ? {
          ...publicQuestion(question),
          CorrectOption: question.CorrectOption || '',
        }
      : publicQuestion(question)
  )),
  mcqScore: attempt.McqScore,
  longScore: attempt.LongScore,
  totalScore: attempt.TotalScore,
  maxScore: attempt.MaxScore,
})

const getQuestions = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const rows = await OnlineExamQuestion.find({ InstutionCode: schoolOf(req), Status: true })
      .sort({ createdAt: -1 })
      .lean()
    return successResponse(res, rows, 'Questions retrieved successfully')
  } catch (error) {
    return errorResponse(res, 'Failed to fetch questions', 500)
  }
}

const createQuestion = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const payload = questionPayload(req.body)
    const problem = validateQuestion(payload)
    if (problem) return errorResponse(res, problem, 400)
    const question = await OnlineExamQuestion.create({
      ...payload,
      InstutionCode: schoolOf(req),
    })
    return successResponse(res, question, 'Question added', 201)
  } catch (error) {
    return errorResponse(res, 'Failed to add question', 500)
  }
}

const updateQuestion = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const question = await OnlineExamQuestion.findOne({
      _id: req.body.questionId,
      InstutionCode: schoolOf(req),
    })
    if (!question) return errorResponse(res, 'Question not found', 404)
    const payload = questionPayload(req.body, question)
    const problem = validateQuestion(payload)
    if (problem) return errorResponse(res, problem, 400)
    Object.assign(question, payload)
    await question.save()
    return successResponse(res, question, 'Question updated')
  } catch (error) {
    return errorResponse(res, 'Failed to update question', 500)
  }
}

const deleteQuestion = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const questionId = req.body.questionId || req.query.questionId
    const question = await OnlineExamQuestion.findOneAndUpdate(
      { _id: questionId, InstutionCode: schoolOf(req) },
      { Status: false },
      { new: true }
    )
    if (!question) return errorResponse(res, 'Question not found', 404)
    return successResponse(res, null, 'Question removed')
  } catch (error) {
    return errorResponse(res, 'Failed to remove question', 500)
  }
}

const examPayload = (body, existing = {}) => ({
  Title: String(body.Title ?? existing.Title ?? '').trim(),
  Class: String(body.Class ?? existing.Class ?? '').trim(),
  ClassCode: String(body.ClassCode ?? existing.ClassCode ?? '').trim(),
  Section: String(body.Section ?? existing.Section ?? '').trim(),
  Subject: String(body.Subject ?? existing.Subject ?? '').trim(),
  QuestionType: ['mcq', 'long', 'mixed'].includes(body.QuestionType) ? body.QuestionType : (existing.QuestionType || 'mixed'),
  DurationMinutes: Math.max(1, Number(body.DurationMinutes ?? existing.DurationMinutes) || 30),
  QuestionCount: Math.max(1, Number(body.QuestionCount ?? existing.QuestionCount) || 1),
  ShuffleQuestions: body.ShuffleQuestions === undefined ? existing.ShuffleQuestions !== false : body.ShuffleQuestions === true,
  Instructions: String(body.Instructions ?? existing.Instructions ?? '').trim(),
  Mode: ['online', 'offline', 'both'].includes(body.Mode) ? body.Mode : (existing.Mode || 'both'),
  Status: ['Draft', 'Published', 'Closed'].includes(body.Status) ? body.Status : (existing.Status || 'Draft'),
  StartsAt: body.StartsAt ? new Date(body.StartsAt) : (body.StartsAt === null ? null : existing.StartsAt || null),
  EndsAt: body.EndsAt ? new Date(body.EndsAt) : (body.EndsAt === null ? null : existing.EndsAt || null),
})

const getExams = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const exams = await OnlineExam.find({ InstutionCode: schoolOf(req) }).sort({ createdAt: -1 }).lean()
    return successResponse(res, exams, 'Exams retrieved successfully')
  } catch (error) {
    return errorResponse(res, 'Failed to fetch exams', 500)
  }
}

const createExam = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const payload = examPayload(req.body)
    if (!payload.Title || !payload.Class || !payload.Subject) {
      return errorResponse(res, 'Title, class, and subject are required', 400)
    }
    const exam = await OnlineExam.create({ ...payload, InstutionCode: schoolOf(req) })
    return successResponse(res, exam, 'Exam created', 201)
  } catch (error) {
    return errorResponse(res, 'Failed to create exam', 500)
  }
}

const updateExam = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const exam = await OnlineExam.findOne({ _id: req.body.examId, InstutionCode: schoolOf(req) })
    if (!exam) return errorResponse(res, 'Exam not found', 404)
    const payload = examPayload(req.body, exam)
    if (!payload.Title || !payload.Class || !payload.Subject) {
      return errorResponse(res, 'Title, class, and subject are required', 400)
    }
    const poolChanged = payload.Class !== exam.Class
      || payload.Subject !== exam.Subject
      || payload.QuestionType !== exam.QuestionType
      || payload.QuestionCount !== exam.QuestionCount
      || payload.ShuffleQuestions !== exam.ShuffleQuestions
    Object.assign(exam, payload)
    if (poolChanged) exam.OfflineQuestionIds = []
    await exam.save()
    return successResponse(res, exam, 'Exam updated')
  } catch (error) {
    return errorResponse(res, 'Failed to update exam', 500)
  }
}

const deleteExam = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const examId = req.body.examId || req.query.examId
    const exam = await OnlineExam.findOneAndDelete({ _id: examId, InstutionCode: schoolOf(req) })
    if (!exam) return errorResponse(res, 'Exam not found', 404)
    return successResponse(res, null, 'Exam removed')
  } catch (error) {
    return errorResponse(res, 'Failed to remove exam', 500)
  }
}

const preparePaper = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const exam = await OnlineExam.findOne({ _id: req.body.examId, InstutionCode: schoolOf(req) })
    if (!exam) return errorResponse(res, 'Exam not found', 404)
    const pool = await OnlineExamQuestion.find(poolQuery(exam)).sort({ createdAt: 1 })
    if (pool.length < exam.QuestionCount) {
      return errorResponse(
        res,
        `This paper needs ${exam.QuestionCount} questions, but only ${pool.length} match this class and subject`,
        400
      )
    }
    let ids = exam.OfflineQuestionIds || []
    if (req.body.reshuffle === true || !ids.length) {
      ids = pickQuestions(pool, exam.QuestionCount, { shuffleQuestions: exam.ShuffleQuestions }).map((question) => question._id)
      exam.OfflineQuestionIds = ids
      await exam.save()
    }
    const questions = await loadQuestionsByIds(ids)
    const includeAnswers = req.body.includeAnswers === true
    return successResponse(res, {
      exam: {
        _id: exam._id,
        Title: exam.Title,
        Class: exam.Class,
        Section: exam.Section,
        Subject: exam.Subject,
        DurationMinutes: exam.DurationMinutes,
        Instructions: exam.Instructions,
        QuestionCount: questions.length,
      },
      questions: questions.map((question) => (
        includeAnswers
          ? { ...publicQuestion(question), CorrectOption: question.CorrectOption || '' }
          : publicQuestion(question)
      )),
      totalMarks: questions.reduce((sum, question) => sum + (Number(question.Marks) || 0), 0),
    }, 'Question paper prepared')
  } catch (error) {
    return errorResponse(res, 'Failed to prepare the question paper', 500)
  }
}

const getAttempts = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const examId = req.query.examId
    if (!examId) return errorResponse(res, 'Exam is required', 400)
    const attempts = await OnlineExamAttempt.find({
      InstutionCode: schoolOf(req),
      Exam_Id: examId,
    }).sort({ createdAt: -1 }).lean()
    return successResponse(res, attempts, 'Attempts retrieved successfully')
  } catch (error) {
    return errorResponse(res, 'Failed to fetch attempts', 500)
  }
}

const getAttemptDetail = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const attempt = await OnlineExamAttempt.findOne({
      _id: req.query.attemptId,
      InstutionCode: schoolOf(req),
    })
    if (!attempt) return errorResponse(res, 'Attempt not found', 404)
    const questions = await loadQuestionsByIds(attempt.QuestionIds)
    return successResponse(res, attemptView(attempt, questions, { includeAnswers: true }), 'Attempt retrieved')
  } catch (error) {
    return errorResponse(res, 'Failed to fetch the attempt', 500)
  }
}

const gradeAttempt = async (req, res) => {
  try {
    if (!requireStaff(req, res)) return null
    const attempt = await OnlineExamAttempt.findOne({
      _id: req.body.attemptId,
      InstutionCode: schoolOf(req),
    })
    if (!attempt) return errorResponse(res, 'Attempt not found', 404)
    if (attempt.Status === 'InProgress') return errorResponse(res, 'This exam is still in progress', 400)
    const questions = await loadQuestionsByIds(attempt.QuestionIds)
    const awards = new Map(
      (Array.isArray(req.body.awards) ? req.body.awards : []).map((award) => [
        String(award.questionId),
        Math.max(0, Number(award.awardedMarks) || 0),
      ])
    )
    const answers = (attempt.Answers || []).map((answer) => ({
      Question_Id: answer.Question_Id,
      SelectedOption: answer.SelectedOption,
      LongAnswer: answer.LongAnswer,
      AwardedMarks: answer.AwardedMarks,
    }))
    questions.forEach((question) => {
      if (question.Type !== 'long') return
      if (!awards.has(String(question._id))) return
      const marks = Math.min(Number(question.Marks) || 0, awards.get(String(question._id)))
      const existing = answers.find((answer) => String(answer.Question_Id) === String(question._id))
      if (existing) existing.AwardedMarks = marks
      else {
        answers.push({
          Question_Id: question._id,
          SelectedOption: '',
          LongAnswer: '',
          AwardedMarks: marks,
        })
      }
    })
    const scored = scoreAnswers(questions, answers)
    attempt.Answers = answers
    attempt.McqScore = scored.mcqScore
    attempt.LongScore = scored.longScore
    attempt.TotalScore = scored.totalScore
    attempt.MaxScore = scored.maxScore
    await attempt.save()
    return successResponse(res, attemptView(attempt, questions, { includeAnswers: true }), 'Marks saved')
  } catch (error) {
    return errorResponse(res, 'Failed to save marks', 500)
  }
}

const loadOwnStudent = async (req) => {
  const resolved = resolveOwnStudentRegistration(req, req.query.registrationNumber || req.body.registrationNumber)
  if (resolved.error) return { error: resolved.error }
  const student = await studentModel.findOne({
    InstutionCode: schoolOf(req),
    Registration_Number: resolved.registrationNumber,
  }).select('First_Name Last_Name Class Class_Code Section SectionCode Registration_Number Status')
  if (!student || student.Status === false) {
    return { error: { status: 404, message: 'Student record was not found' } }
  }
  return { student }
}

const examIsOpen = (exam) => {
  const now = Date.now()
  if (exam.StartsAt && new Date(exam.StartsAt).getTime() > now) return false
  if (exam.EndsAt && new Date(exam.EndsAt).getTime() < now) return false
  return true
}

const getMyExams = async (req, res) => {
  try {
    if (!schoolOf(req)) return errorResponse(res, 'Institution context not found', 401)
    const loaded = await loadOwnStudent(req)
    if (loaded.error) return errorResponse(res, loaded.error.message, loaded.error.status)
    const { student } = loaded
    const exams = await OnlineExam.find({
      InstutionCode: schoolOf(req),
      Status: 'Published',
      Mode: { $in: ['online', 'both'] },
    }).sort({ createdAt: -1 }).lean()
    const visible = exams.filter((exam) => classMatch(exam, student) && sectionMatch(exam, student))
    const attempts = await OnlineExamAttempt.find({
      InstutionCode: schoolOf(req),
      Registration_Number: student.Registration_Number,
      Exam_Id: { $in: visible.map((exam) => exam._id) },
    }).lean()
    const attemptByExam = new Map(attempts.map((attempt) => [String(attempt.Exam_Id), attempt]))
    return successResponse(res, visible.map((exam) => {
      const attempt = attemptByExam.get(String(exam._id))
      return {
        _id: exam._id,
        Title: exam.Title,
        Class: exam.Class,
        Section: exam.Section,
        Subject: exam.Subject,
        QuestionType: exam.QuestionType,
        DurationMinutes: exam.DurationMinutes,
        QuestionCount: exam.QuestionCount,
        Instructions: exam.Instructions,
        StartsAt: exam.StartsAt,
        EndsAt: exam.EndsAt,
        open: examIsOpen(exam),
        attempt: attempt
          ? {
              attemptId: attempt._id,
              status: attempt.Status,
              endsAt: attempt.EndsAt,
              totalScore: attempt.TotalScore,
              maxScore: attempt.MaxScore,
              mcqScore: attempt.McqScore,
              longScore: attempt.LongScore,
            }
          : null,
      }
    }), 'Exams retrieved successfully')
  } catch (error) {
    return errorResponse(res, 'Failed to fetch exams', 500)
  }
}

const buildOnlineSet = async (exam) => {
  const pool = await OnlineExamQuestion.find(poolQuery(exam)).sort({ createdAt: 1 })
  if (pool.length < exam.QuestionCount) {
    return { error: `This exam needs ${exam.QuestionCount} questions, but only ${pool.length} are available` }
  }
  const picked = pickQuestions(pool, exam.QuestionCount, { shuffleQuestions: exam.ShuffleQuestions })
  return { questions: picked }
}

const startExam = async (req, res) => {
  try {
    if (!schoolOf(req)) return errorResponse(res, 'Institution context not found', 401)
    const loaded = await loadOwnStudent(req)
    if (loaded.error) return errorResponse(res, loaded.error.message, loaded.error.status)
    const { student } = loaded
    if (!mongoose.Types.ObjectId.isValid(req.body.examId)) return errorResponse(res, 'Exam not found', 404)
    const exam = await OnlineExam.findOne({
      _id: req.body.examId,
      InstutionCode: schoolOf(req),
      Status: 'Published',
    })
    if (!exam || !['online', 'both'].includes(exam.Mode)) return errorResponse(res, 'This exam is not available online', 404)
    if (!classMatch(exam, student) || !sectionMatch(exam, student)) {
      return errorResponse(res, 'This exam is not assigned to your class', 403)
    }

    let attempt = await OnlineExamAttempt.findOne({
      Exam_Id: exam._id,
      Registration_Number: student.Registration_Number,
    })

    if (attempt && attempt.Status !== 'InProgress') {
      const questions = await loadQuestionsByIds(attempt.QuestionIds)
      return successResponse(res, {
        examTitle: exam.Title,
        subject: exam.Subject,
        instructions: exam.Instructions,
        ...attemptView(attempt, questions),
      }, 'Exam already submitted')
    }

    if (attempt && new Date(attempt.EndsAt).getTime() <= Date.now()) {
      const questions = await loadQuestionsByIds(attempt.QuestionIds)
      await finishAttempt(attempt, questions, attempt.Answers)
      return successResponse(res, {
        examTitle: exam.Title,
        subject: exam.Subject,
        instructions: exam.Instructions,
        ...attemptView(attempt, questions),
      }, 'Time is up. Your exam has been submitted')
    }

    if (!attempt) {
      if (!examIsOpen(exam)) return errorResponse(res, 'This exam is not open right now', 400)
      const built = await buildOnlineSet(exam)
      if (built.error) return errorResponse(res, built.error, 400)
      const endsAt = new Date(Date.now() + exam.DurationMinutes * 60 * 1000)
      try {
        attempt = await OnlineExamAttempt.create({
          InstutionCode: schoolOf(req),
          Exam_Id: exam._id,
          Registration_Number: student.Registration_Number,
          StudentName: `${student.First_Name || ''} ${student.Last_Name || ''}`.trim(),
          Class: student.Class || '',
          QuestionIds: built.questions.map((question) => question._id),
          Answers: [],
          StartedAt: new Date(),
          EndsAt: endsAt,
          Status: 'InProgress',
          MaxScore: built.questions.reduce((sum, question) => sum + (Number(question.Marks) || 0), 0),
        })
      } catch (error) {
        if (error?.code !== 11000) throw error
        attempt = await OnlineExamAttempt.findOne({
          Exam_Id: exam._id,
          Registration_Number: student.Registration_Number,
        })
      }
    }

    const questions = await loadQuestionsByIds(attempt.QuestionIds)
    return successResponse(res, {
      examTitle: exam.Title,
      subject: exam.Subject,
      instructions: exam.Instructions,
      durationMinutes: exam.DurationMinutes,
      ...attemptView(attempt, questions),
    }, 'Exam started')
  } catch (error) {
    return errorResponse(res, 'Failed to start the exam', 500)
  }
}

const saveOrSubmit = async (req, res, forceSubmit) => {
  try {
    if (!schoolOf(req)) return errorResponse(res, 'Institution context not found', 401)
    const loaded = await loadOwnStudent(req)
    if (loaded.error) return errorResponse(res, loaded.error.message, loaded.error.status)
    const attempt = await OnlineExamAttempt.findOne({
      _id: req.body.attemptId,
      InstutionCode: schoolOf(req),
      Registration_Number: loaded.student.Registration_Number,
    })
    if (!attempt) return errorResponse(res, 'Exam attempt not found', 404)
    const questions = await loadQuestionsByIds(attempt.QuestionIds)
    if (attempt.Status !== 'InProgress') {
      return successResponse(res, attemptView(attempt, questions), 'Exam already submitted')
    }
    const answers = mergeStudentAnswers(attempt.Answers, req.body.answers, attempt.QuestionIds)
    const expired = new Date(attempt.EndsAt).getTime() <= Date.now()
    if (forceSubmit || expired) {
      await finishAttempt(attempt, questions, answers)
      return successResponse(
        res,
        attemptView(attempt, questions),
        expired ? 'Time is up. Your answers were saved and the exam has ended' : 'Exam submitted'
      )
    }
    attempt.Answers = answers
    await attempt.save()
    return successResponse(res, {
      saved: true,
      serverNow: new Date().toISOString(),
      endsAt: attempt.EndsAt,
    }, 'Answers saved')
  } catch (error) {
    return errorResponse(res, 'Failed to save the exam', 500)
  }
}

const saveAnswers = (req, res) => saveOrSubmit(req, res, false)
const submitExam = (req, res) => saveOrSubmit(req, res, true)

module.exports = {
  getQuestions,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  getExams,
  createExam,
  updateExam,
  deleteExam,
  preparePaper,
  getAttempts,
  getAttemptDetail,
  gradeAttempt,
  getMyExams,
  startExam,
  saveAnswers,
  submitExam,
}
