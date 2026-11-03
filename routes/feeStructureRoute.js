const express       = require('express')
const router        = express.Router()

const feeStructureController = require('../controller/feeStructureController')
const authenticate       = require('../middleware/authenticate')

router.get('/get-fee-structure', authenticate, feeStructureController.show)
router.post('/add-fee-structure', authenticate, feeStructureController.store)
router.patch('/update-fee-structure', authenticate, feeStructureController.update)
router.delete('/delete-fee-structure', authenticate, feeStructureController.remove)
// router.delete('/delete-announcement', authenticate, announcementController.destroy)

module.exports = router