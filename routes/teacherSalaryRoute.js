const express = require('express')
const router = express.Router()
const authenticate = require('../middleware/authenticate')
const teacherSalary = require('../controller/teacherSalaryController')

router.get('/overview', authenticate, teacherSalary.overview)
router.get('/me', authenticate, teacherSalary.mine)
router.get('/payments', authenticate, teacherSalary.listPayments)
router.get('/slip/:id', authenticate, teacherSalary.slip)
router.get('/teacher/:memberId', authenticate, teacherSalary.detail)
router.post('/structure', authenticate, teacherSalary.saveStructure)
router.post('/pay', authenticate, teacherSalary.pay)
router.patch('/payment/:id', authenticate, teacherSalary.updatePayment)
router.delete('/payment/:id', authenticate, teacherSalary.removePayment)
router.delete('/structure/:memberId', authenticate, teacherSalary.removeStructure)

module.exports = router
