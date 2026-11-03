const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const assignment = require('../controller/assignmentController');

const acceptFiles = (req, res, next) => {
  assignment.upload.array('files', 5)(req, res, (error) => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Each file must be under 8 MB'
      : (error.message || 'Could not read the file');
    return res.status(400).json({ success: false, message });
  });
};

router.get('/mine', authenticate, assignment.mine);
router.get('/file/:storedName', authenticate, assignment.download);
router.get('/', authenticate, assignment.index);
router.post('/', authenticate, acceptFiles, assignment.create);
router.get('/:id/roster', authenticate, assignment.roster);
router.post('/:id/submit', authenticate, acceptFiles, assignment.submit);
router.patch('/:id/status', authenticate, assignment.setStatus);
router.patch('/:id', authenticate, acceptFiles, assignment.update);
router.delete('/:id', authenticate, assignment.destroy);
router.post('/submission/:id/grade', authenticate, assignment.grade);
router.post('/submission/:id/return', authenticate, assignment.sendBack);

module.exports = router;
