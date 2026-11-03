const express = require('express')
const router = express.Router()
const authenticate = require('../middleware/authenticate')
const onlineExam = require('../controller/onlineExamController')

router.get('/questions', authenticate, onlineExam.getQuestions)
router.post('/questions', authenticate, onlineExam.createQuestion)
router.patch('/questions', authenticate, onlineExam.updateQuestion)
router.delete('/questions', authenticate, onlineExam.deleteQuestion)

router.get('/exams', authenticate, onlineExam.getExams)
router.post('/exams', authenticate, onlineExam.createExam)
router.patch('/exams', authenticate, onlineExam.updateExam)
router.delete('/exams', authenticate, onlineExam.deleteExam)
router.post('/prepare-paper', authenticate, onlineExam.preparePaper)

router.get('/attempts', authenticate, onlineExam.getAttempts)
router.get('/attempt', authenticate, onlineExam.getAttemptDetail)
router.patch('/grade-attempt', authenticate, onlineExam.gradeAttempt)

router.get('/my-exams', authenticate, onlineExam.getMyExams)
router.post('/start', authenticate, onlineExam.startExam)
router.post('/save', authenticate, onlineExam.saveAnswers)
router.post('/submit', authenticate, onlineExam.submitExam)

module.exports = router
