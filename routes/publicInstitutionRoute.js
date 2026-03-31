const express = require('express')
const { getPublicInstitutionStatus } = require('../controller/publicInstitutionController')

const router = express.Router()

router.get('/institution-status', getPublicInstitutionStatus)

module.exports = router
