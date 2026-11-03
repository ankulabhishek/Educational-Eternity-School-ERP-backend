const express = require('express')
const router = express.Router()
const authenticate = require('../middleware/authenticate')
const aiChat = require('../controller/aiChatController')

router.get('/history', authenticate, aiChat.history)
router.delete('/history', authenticate, aiChat.clearHistory)
router.post('/message', authenticate, aiChat.sendMessage)
router.get('/image/:filename', authenticate, aiChat.image)

module.exports = router
