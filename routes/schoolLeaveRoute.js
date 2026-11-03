const express = require('express')
const router = express.Router()
const authenticate = require('../middleware/authenticate')
const leave = require('../controller/schoolLeaveController')

router.post('/apply', authenticate, leave.apply)
router.get('/mine', authenticate, leave.mine)
router.get('/', authenticate, leave.list)
router.patch('/:id/decision', authenticate, leave.decide)

module.exports = router
