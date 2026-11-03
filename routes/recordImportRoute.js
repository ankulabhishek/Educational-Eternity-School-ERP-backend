const express = require('express')
const router = express.Router()
const controller = require('../controller/recordImportController')
const authenticate = require('../middleware/authenticate')

router.post('/classes', authenticate, controller.importClasses)
router.post('/teachers', authenticate, controller.importTeachers)
router.post('/students', authenticate, controller.importStudents)

module.exports = router
