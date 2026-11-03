const express = require('express')
const router = express.Router()
const authenticate = require('../middleware/authenticate')
const { requireSuperAdmin } = require('../middleware/authorize')
const { listAuditLogs, clearAuditLogs } = require('../controller/auditLogController')

router.get('/', authenticate, requireSuperAdmin, listAuditLogs)
router.delete('/', authenticate, requireSuperAdmin, clearAuditLogs)

module.exports = router

