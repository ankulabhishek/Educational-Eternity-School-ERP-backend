const express = require('express')
const router = express.Router()
const authenticate = require('../middleware/authenticate')
const admitCardController = require('../controller/admitCardController')

router.get('/preview', authenticate, admitCardController.preview)
router.get('/mine', authenticate, admitCardController.mine)
router.get('/student', authenticate, admitCardController.generateStudentAdmitCard)
router.get('/class', authenticate, admitCardController.generateClassAdmitCards)

module.exports = router
