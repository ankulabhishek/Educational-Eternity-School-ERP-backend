const express = require('express')
const router = express.Router()
const controller = require('../controller/slcCertificateController')
const authenticate = require('../middleware/authenticate')

router.get('/school', authenticate, controller.school)
router.get('/preview', authenticate, controller.preview)
router.get('/list', authenticate, controller.list)
router.get('/pdf', authenticate, controller.pdf)
router.get('/my', authenticate, controller.mine)
router.get('/my-pdf', authenticate, controller.myPdf)
router.post('/issue', authenticate, controller.issue)

module.exports = router
