const examScheduleModel = require('../models/examScheduleModel')
const { getPermissionSet } = require('./permissionAssinment')
const mongoErrorMessages = require('./mongoErrors.json')
const classModel = require('../models/classModel')
const studentModel = require('../models/studentModel')
const { resolveAcademicYearScope } = require('../utils/academicYearScope')
const { resolveOwnStudentRegistration } = require('../utils/studentPortalAccess')

const todayKey = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())

const examDayKey = (value) => {
    const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)
    if (match) return match[1]
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date)
}

const statusForExamDay = (dayKey, requested = '') => {
    if (requested === 'Cancelled') return 'Cancelled'
    if (!dayKey) return 'Upcoming'
    return dayKey < todayKey() ? 'Completed' : 'Upcoming'
}

const minutesOfClock = (label) => {
    const match = String(label || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i)
    if (!match) return null
    let hours = Number(match[1])
    const minutes = Number(match[2])
    const meridiem = String(match[3] || '').toUpperCase()
    if (meridiem === 'PM' && hours < 12) hours += 12
    if (meridiem === 'AM' && hours === 12) hours = 0
    if (hours > 23 || minutes > 59) return null
    return hours * 60 + minutes
}

const buildExamRecord = (body, school, classRecord) => {
    const dayKey = examDayKey(body.ExamDate)
    const examDate = dayKey ? new Date(`${dayKey}T00:00:00.000Z`) : new Date(body.ExamDate)
    return {
        InstutionCode: school,
        ClassCode: body.ClassCode || classRecord.ClassCode,
        ClassName: body.ClassName || classRecord.ClassName,
        SectionCode: body.SectionCode || '',
        SectionName: body.SectionName || '',
        ExamName: String(body.ExamName || '').trim(),
        ExamType: String(body.ExamType || '').trim(),
        Subject: String(body.Subject || '').trim(),
        ExamDate: examDate,
        StartTime: String(body.StartTime || '').trim(),
        EndTime: String(body.EndTime || '').trim(),
        Duration: body.Duration || '',
        MaxMarks: Number(body.MaxMarks) > 0 ? Number(body.MaxMarks) : 100,
        Venue: String(body.Venue || '').trim() || 'Classroom',
        Status: statusForExamDay(dayKey, body.Status),
        Instructions: body.Instructions || '',
        TeacherName: body.TeacherName || '',
        TeacherId: body.TeacherId || '',
    }
}

const paperProblem = (paper) => {
    if (!String(paper.Subject || '').trim()) return 'Each paper needs a subject'
    if (!examDayKey(paper.ExamDate)) return `Choose a date for ${paper.Subject || 'each subject'}`
    const start = minutesOfClock(paper.StartTime)
    const end = minutesOfClock(paper.EndTime)
    if (start == null || end == null) return `Choose a start and end time for ${paper.Subject}`
    if (end <= start) return `End time should be after the start time for ${paper.Subject}`
    return ''
}

// Get all exam schedules with filters
const index = async (req, res, next) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            })
        }

        const permissionsResult = await getPermissionSet(req)
        const schedulePermissions = typeof permissionsResult.scheduleClass === 'string' 
            ? permissionsResult.scheduleClass 
            : (permissionsResult.scheduleClass?.toString() || 'R-W-E-D-RA')

        if (!schedulePermissions.split('-').includes('RA') && !schedulePermissions.split('-').includes('R')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to access this resource. Please contact your administrator'
            })
        }

        const page = parseInt(req.query.PageNumber) || 1
        const limit = parseInt(req.query.PageSize) || 10
        const skip = (page - 1) * limit
        const searchText = req.query.SearchText || ''

        let searchCondition = {
            InstutionCode: req.user.InstutionCode
        }

        // Filter by ClassCode
        if (req.query.ClassCode) {
            searchCondition.ClassCode = req.query.ClassCode
        }

        // Filter by SectionCode
        if (req.query.SectionCode) {
            searchCondition.SectionCode = req.query.SectionCode
        }

        // Filter by ExamType
        if (req.query.ExamType) {
            searchCondition.ExamType = req.query.ExamType
        }

        // Filter by Subject
        if (req.query.Subject) {
            searchCondition.Subject = { $regex: req.query.Subject, $options: 'i' }
        }

        // Filter by Status
        if (req.query.Status) {
            searchCondition.Status = req.query.Status
        }

        // Filter by date range (query override)
        if (req.query.StartDate || req.query.EndDate) {
            searchCondition.ExamDate = {}
            if (req.query.StartDate) {
                searchCondition.ExamDate.$gte = new Date(req.query.StartDate)
            }
            if (req.query.EndDate) {
                const end = new Date(req.query.EndDate)
                end.setUTCHours(23, 59, 59, 999)
                searchCondition.ExamDate.$lte = end
            }
        } else {
            // Academic year view filter
            const scope = await resolveAcademicYearScope(req)
            if (scope?.from && scope?.to) {
              searchCondition.ExamDate = { $gte: scope.from, $lte: scope.to }
            }
        }

        // Search text filter
        if (searchText) {
            searchCondition.$or = [
                { ExamName: { $regex: searchText, $options: 'i' } },
                { Subject: { $regex: searchText, $options: 'i' } },
                { ClassName: { $regex: searchText, $options: 'i' } },
                { Venue: { $regex: searchText, $options: 'i' } }
            ]
        }

        const [exams, totalCount] = await Promise.all([
            examScheduleModel.find(searchCondition)
                .sort({ ExamDate: 1, StartTime: 1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            examScheduleModel.countDocuments(searchCondition)
        ])

        res.status(200).json({
            success: true,
            message: 'Exam schedules retrieved successfully',
            code: 200,
            totalRecords: totalCount,
            data: exams
        })
    } catch (error) {
        console.error('Error fetching exam schedules:', error)
        const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key))
        const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message

        res.status(500).json({
            success: false,
            message: errorMessage || 'Failed to fetch exam schedules',
            code: 500,
            error: error.message
        })
    }
}

// Get single exam schedule by ID
const show = async (req, res, next) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            })
        }

        const permissionsResult = await getPermissionSet(req)
        const schedulePermissions = typeof permissionsResult.scheduleClass === 'string' 
            ? permissionsResult.scheduleClass 
            : (permissionsResult.scheduleClass?.toString() || 'R-W-E-D-RA')

        if (!schedulePermissions.split('-').includes('RA') && !schedulePermissions.split('-').includes('R')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to access this resource. Please contact your administrator'
            })
        }

        const examId = req.query.examId || req.params.id

        if (!examId) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: 'Exam ID is required'
            })
        }

        const exam = await examScheduleModel.findOne({
            _id: examId,
            InstutionCode: req.user.InstutionCode
        }).lean()

        if (!exam) {
            return res.status(404).json({
                code: 404,
                success: false,
                message: 'Exam schedule not found'
            })
        }

        res.status(200).json({
            success: true,
            message: 'Exam schedule retrieved successfully',
            code: 200,
            data: exam
        })
    } catch (error) {
        console.error('Error fetching exam schedule:', error)
        const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key))
        const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message

        res.status(500).json({
            success: false,
            message: errorMessage || 'Failed to fetch exam schedule',
            code: 500,
            error: error.message
        })
    }
}

// Create new exam schedule
const store = async (req, res, next) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            })
        }

        const permissionsResult = await getPermissionSet(req)
        const schedulePermissions = typeof permissionsResult.scheduleClass === 'string' 
            ? permissionsResult.scheduleClass 
            : (permissionsResult.scheduleClass?.toString() || 'R-W-E-D-RA')

        if (!schedulePermissions.split('-').includes('W')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to create exam schedules. Please contact your administrator'
            })
        }

        if (Array.isArray(req.body.papers)) {
            if (!req.body.papers.length) {
                return res.status(400).json({
                    code: 400,
                    success: false,
                    message: 'Add at least one subject',
                })
            }
            if (!req.body.ClassCode || !req.body.ExamName || !req.body.ExamType) {
                return res.status(400).json({
                    code: 400,
                    success: false,
                    message: 'Exam name, exam type, and class are required',
                })
            }
            const classRecord = await classModel.findOne({
                ClassCode: req.body.ClassCode,
                InstutionCode: req.user.InstutionCode,
            })
            if (!classRecord) {
                return res.status(404).json({
                    code: 404,
                    success: false,
                    message: 'Class not found or does not belong to your institution',
                })
            }
            for (const paper of req.body.papers) {
                const problem = paperProblem({ ...req.body, ...paper })
                if (problem) {
                    return res.status(400).json({ code: 400, success: false, message: problem })
                }
            }
            const created = []
            try {
                for (const paper of req.body.papers) {
                    created.push(await examScheduleModel.create(buildExamRecord({
                        ...req.body,
                        ...paper,
                    }, req.user.InstutionCode, classRecord)))
                }
            } catch (createError) {
                if (created.length) {
                    await examScheduleModel.deleteMany({ _id: { $in: created.map((row) => row._id) } })
                }
                throw createError
            }
            return res.status(201).json({
                success: true,
                message: 'Exam dates saved',
                code: 201,
                data: created,
            })
        }

        // Validate required fields
        const requiredFields = ['ClassCode', 'ClassName', 'ExamName', 'ExamType', 'Subject', 'ExamDate', 'StartTime', 'EndTime']
        const missingFields = requiredFields.filter(field => !req.body[field])

        if (missingFields.length > 0) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: `Missing required fields: ${missingFields.join(', ')}`
            })
        }

        // Verify class exists and belongs to institution
        const classRecord = await classModel.findOne({
            ClassCode: req.body.ClassCode,
            InstutionCode: req.user.InstutionCode
        })

        if (!classRecord) {
            return res.status(404).json({
                code: 404,
                success: false,
                message: 'Class not found or does not belong to your institution'
            })
        }

        // Parse ExamDate
        let examDate
        if (typeof req.body.ExamDate === 'string') {
            examDate = new Date(req.body.ExamDate)
        } else {
            examDate = req.body.ExamDate
        }

        if (isNaN(examDate.getTime())) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: 'Invalid exam date format'
            })
        }

        const timingProblem = paperProblem(req.body)
        if (timingProblem) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: timingProblem,
            })
        }

        const examSchedule = new examScheduleModel(
            buildExamRecord(req.body, req.user.InstutionCode, classRecord)
        )

        await examSchedule.save()

        res.status(201).json({
            success: true,
            message: 'Exam schedule created successfully',
            code: 201,
            data: examSchedule
        })
    } catch (error) {
        console.error('Error creating exam schedule:', error)
        const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key))
        const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message

        res.status(500).json({
            success: false,
            message: errorMessage || 'Failed to create exam schedule',
            code: 500,
            error: error.message
        })
    }
}

// Update exam schedule
const update = async (req, res, next) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            })
        }

        const permissionsResult = await getPermissionSet(req)
        const schedulePermissions = typeof permissionsResult.scheduleClass === 'string' 
            ? permissionsResult.scheduleClass 
            : (permissionsResult.scheduleClass?.toString() || 'R-W-E-D-RA')

        if (!schedulePermissions.split('-').includes('E')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to update exam schedules. Please contact your administrator'
            })
        }

        const examId = req.body.examId || req.params.id

        if (!examId) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: 'Exam ID is required'
            })
        }

        // Verify exam exists and belongs to institution
        const existingExam = await examScheduleModel.findOne({
            _id: examId,
            InstutionCode: req.user.InstutionCode
        })

        if (!existingExam) {
            return res.status(404).json({
                code: 404,
                success: false,
                message: 'Exam schedule not found or does not belong to your institution'
            })
        }

        // Prepare update data
        const updateData = {}

        if (req.body.ClassCode) {
            // Verify new class exists
            const classRecord = await classModel.findOne({
                ClassCode: req.body.ClassCode,
                InstutionCode: req.user.InstutionCode
            })

            if (!classRecord) {
                return res.status(404).json({
                    code: 404,
                    success: false,
                    message: 'Class not found or does not belong to your institution'
                })
            }
            updateData.ClassCode = req.body.ClassCode
        }

        if (req.body.ClassName) updateData.ClassName = req.body.ClassName
        if (req.body.SectionCode !== undefined) updateData.SectionCode = req.body.SectionCode
        if (req.body.SectionName !== undefined) updateData.SectionName = req.body.SectionName
        if (req.body.ExamName) updateData.ExamName = req.body.ExamName
        if (req.body.ExamType) updateData.ExamType = req.body.ExamType
        if (req.body.Subject) updateData.Subject = req.body.Subject
        if (req.body.StartTime) updateData.StartTime = req.body.StartTime
        if (req.body.EndTime) updateData.EndTime = req.body.EndTime
        if (req.body.Duration !== undefined) updateData.Duration = req.body.Duration
        if (req.body.MaxMarks) updateData.MaxMarks = req.body.MaxMarks
        if (req.body.Venue) updateData.Venue = req.body.Venue
        if (req.body.Status) updateData.Status = req.body.Status
        if (req.body.Instructions !== undefined) updateData.Instructions = req.body.Instructions
        if (req.body.TeacherName !== undefined) updateData.TeacherName = req.body.TeacherName
        if (req.body.TeacherId !== undefined) updateData.TeacherId = req.body.TeacherId

        // Handle ExamDate
        if (req.body.ExamDate) {
            let examDate
            if (typeof req.body.ExamDate === 'string') {
                examDate = new Date(req.body.ExamDate)
            } else {
                examDate = req.body.ExamDate
            }

            if (isNaN(examDate.getTime())) {
                return res.status(400).json({
                    code: 400,
                    success: false,
                    message: 'Invalid exam date format'
                })
            }

            updateData.ExamDate = examDate

            // Update status based on new date if not explicitly set
            if (!req.body.Status || req.body.Status !== 'Cancelled') {
                updateData.Status = statusForExamDay(examDayKey(examDate))
            }
        }

        const timingProblem = paperProblem({
            Subject: updateData.Subject || existingExam.Subject,
            ExamDate: updateData.ExamDate || existingExam.ExamDate,
            StartTime: updateData.StartTime || existingExam.StartTime,
            EndTime: updateData.EndTime || existingExam.EndTime,
        })
        if (timingProblem) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: timingProblem,
            })
        }

        const updatedExam = await examScheduleModel.findByIdAndUpdate(
            examId,
            { $set: updateData },
            { new: true, runValidators: true }
        )

        res.status(200).json({
            success: true,
            message: 'Exam schedule updated successfully',
            code: 200,
            data: updatedExam
        })
    } catch (error) {
        console.error('Error updating exam schedule:', error)
        const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key))
        const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message

        res.status(500).json({
            success: false,
            message: errorMessage || 'Failed to update exam schedule',
            code: 500,
            error: error.message
        })
    }
}

// Delete exam schedule
const destroy = async (req, res, next) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            })
        }

        const permissionsResult = await getPermissionSet(req)
        const schedulePermissions = typeof permissionsResult.scheduleClass === 'string' 
            ? permissionsResult.scheduleClass 
            : (permissionsResult.scheduleClass?.toString() || 'R-W-E-D-RA')

        if (!schedulePermissions.split('-').includes('D')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to delete exam schedules. Please contact your administrator'
            })
        }

        const examId = req.body.examId || req.params.id

        if (!examId) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: 'Exam ID is required'
            })
        }

        // Verify exam exists and belongs to institution
        const exam = await examScheduleModel.findOne({
            _id: examId,
            InstutionCode: req.user.InstutionCode
        })

        if (!exam) {
            return res.status(404).json({
                code: 404,
                success: false,
                message: 'Exam schedule not found or does not belong to your institution'
            })
        }

        await examScheduleModel.findByIdAndDelete(examId)

        res.status(200).json({
            success: true,
            message: 'Exam schedule deleted successfully',
            code: 200
        })
    } catch (error) {
        console.error('Error deleting exam schedule:', error)
        const matchedKey = Object.keys(mongoErrorMessages).find(key => error.message.includes(key))
        const errorMessage = matchedKey ? mongoErrorMessages[matchedKey] : error.message

        res.status(500).json({
            success: false,
            message: errorMessage || 'Failed to delete exam schedule',
            code: 500,
            error: error.message
        })
    }
}

const myTimetable = async (req, res) => {
    try {
        if (!req.user?.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required',
            })
        }
        const resolved = resolveOwnStudentRegistration(req)
        if (resolved.error) {
            return res.status(resolved.error.status).json({
                code: resolved.error.status,
                success: false,
                message: resolved.error.message,
            })
        }
        if (String(req.user.UserType || '').trim() !== 'Student') {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'This timetable is for students',
            })
        }
        const student = await studentModel.findOne({
            InstutionCode: req.user.InstutionCode,
            Registration_Number: resolved.registrationNumber,
        }).select('Class Class_Code Section SectionCode Status').lean()
        if (!student || student.Status === false) {
            return res.status(404).json({
                code: 404,
                success: false,
                message: 'Student record was not found',
            })
        }
        const classValues = [student.Class, student.Class_Code].map((value) => String(value || '').trim()).filter(Boolean)
        const exams = await examScheduleModel.find({
            InstutionCode: req.user.InstutionCode,
            Status: { $ne: 'Cancelled' },
            $or: [
                { ClassName: { $in: classValues } },
                { ClassCode: { $in: classValues } },
            ],
        }).sort({ ExamDate: 1, StartTime: 1 }).lean()
        const sectionValues = [student.Section, student.SectionCode]
            .map((value) => String(value || '').trim().toLowerCase())
            .filter(Boolean)
        const visible = exams.filter((exam) => {
            const examSection = String(exam.SectionName || exam.SectionCode || '').trim().toLowerCase()
            return !examSection || sectionValues.includes(examSection)
        })
        return res.status(200).json({
            success: true,
            message: 'Exam timetable retrieved successfully',
            code: 200,
            data: visible,
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            code: 500,
            message: error.message || 'Failed to fetch the exam timetable',
        })
    }
}

module.exports = {
    index,
    show,
    store,
    update,
    destroy,
    myTimetable,
}

