const Timetable = require('../models/timetableModel');
const classModel = require('../models/classModel');
const studentModel = require('../models/studentModel');
const { resolveOwnStudentRegistration } = require('../utils/studentPortalAccess');
const { getPermissionSet } = require('./permissionAssinment');
const cache = require('../utils/cache');
const { logger } = require('../utils/logger');
const mongoose = require('mongoose');

/**
 * Get all timetables with pagination and filters
 */
const index = async (req, res) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            });
        }

        let permissionsResult;
        try {
            permissionsResult = await getPermissionSet(req);
        } catch (permError) {
            logger.error('Error getting permissions:', permError);
            permissionsResult = { timetable: 'R-W-E-D-RA' };
        }

        if (!permissionsResult || !permissionsResult.timetable) {
            permissionsResult = { timetable: 'R-W-E-D-RA' };
        }

        const timetablePermissions = typeof permissionsResult.timetable === 'string' 
            ? permissionsResult.timetable 
            : (permissionsResult.timetable?.toString() || 'R-W-E-D-RA');

        if (!timetablePermissions.split("-").includes('RA') && !timetablePermissions.split("-").includes('R')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to view timetables'
            });
        }

        const instutionCode = req.user.InstutionCode;
        const { 
            PageNumber = 1, 
            PageSize = 10,
            ClassCode,
            SectionCode,
            Day,
            Session
        } = req.query;

        const page = parseInt(PageNumber);
        const limit = parseInt(PageSize);
        const skip = (page - 1) * limit;

        // Build query
        const query = { InstutionCode: instutionCode };
        if (ClassCode) query.ClassCode = ClassCode;
        if (SectionCode) query.SectionCode = SectionCode;
        if (Day) query.Day = Day;
        if (Session) query.Session = Session;

        // Check cache
        const cacheKey = `timetable:${instutionCode}:${JSON.stringify(query)}:${page}:${limit}`;
        const cached = cache.get(cacheKey);
        if (cached) {
            return res.status(200).json({
                code: 200,
                success: true,
                data: cached.data,
                pagination: cached.pagination,
                message: 'Timetable fetched successfully'
            });
        }

        const [timetables, total] = await Promise.all([
            Timetable.find(query)
                .sort({ Day: 1, Period: 1, ClassCode: 1, SectionCode: 1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Timetable.countDocuments(query)
        ]);

        const pagination = {
            current: page,
            pageSize: limit,
            total: total,
            totalPages: Math.ceil(total / limit)
        };

        const result = {
            data: timetables,
            pagination
        };

        cache.set(cacheKey, result, 300); // Cache for 5 minutes

        return res.status(200).json({
            code: 200,
            success: true,
            data: timetables,
            pagination,
            message: 'Timetable fetched successfully'
        });
    } catch (error) {
        logger.error('Error fetching timetables:', error);
        return res.status(500).json({
            code: 500,
            success: false,
            message: 'Error fetching timetables',
            error: error.message
        });
    }
};

/**
 * Get timetable by class and section (for weekly view)
 */
const getByClassSection = async (req, res) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            });
        }

        const instutionCode = req.user.InstutionCode;
        const { ClassCode, SectionCode, Session } = req.query;

        if (!ClassCode) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: 'ClassCode is required'
            });
        }

        const query = { 
            InstutionCode: instutionCode,
            ClassCode: ClassCode,
            Status: true
        };

        if (SectionCode) {
            query.SectionCode = SectionCode;
        }

        if (Session) {
            query.Session = Session;
        }

        const timetables = await Timetable.find(query)
            .sort({ updatedAt: -1, Day: 1, Period: 1 })
            .lean();

        const groupedByDay = groupLatest(timetables);

        return res.status(200).json({
            code: 200,
            success: true,
            data: groupedByDay,
            message: 'Timetable fetched successfully'
        });
    } catch (error) {
        logger.error('Error fetching timetable by class/section:', error);
        return res.status(500).json({
            code: 500,
            success: false,
            message: 'Error fetching timetable',
            error: error.message
        });
    }
};

/**
 * Create new timetable entry
 */
const store = async (req, res) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            });
        }

        let permissionsResult;
        try {
            permissionsResult = await getPermissionSet(req);
        } catch (permError) {
            logger.error('Error getting permissions:', permError);
            permissionsResult = { timetable: 'R-W-E-D-RA' };
        }

        if (!permissionsResult || !permissionsResult.timetable) {
            permissionsResult = { timetable: 'R-W-E-D-RA' };
        }

        const timetablePermissions = typeof permissionsResult.timetable === 'string' 
            ? permissionsResult.timetable 
            : (permissionsResult.timetable?.toString() || 'R-W-E-D-RA');

        if (!timetablePermissions.split("-").includes('W')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to create timetables'
            });
        }

        const instutionCode = req.user.InstutionCode;
        const {
            ClassCode,
            ClassName,
            SectionCode,
            SectionName,
            Day,
            Period,
            StartTime,
            EndTime,
            Subject,
            Teacher_Code,
            Teacher_Name,
            Teacher_Id,
            Room,
            Session
        } = req.body;

        // Validate required fields
        const classInfo = await classModel.findOne({
            InstutionCode: instutionCode,
            ClassCode: ClassCode,
        }).select('ClassName Session').lean();
        const sessionValue = (Session && String(Session).trim()) || classInfo?.Session || `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
        const classNameValue = (ClassName && String(ClassName).trim()) || classInfo?.ClassName || '';

        if (!ClassCode || !classNameValue || !Day || !Period || !StartTime || !EndTime || !Subject) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: 'Choose the class, day, period, time and subject'
            });
        }

        // Check for duplicate
        const periodNumber = parseInt(Period);
        if (isNaN(periodNumber) || periodNumber < 1 || periodNumber > 12) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: 'Period must be a number between 1 and 12'
            });
        }

        const duplicateQuery = {
            InstutionCode: instutionCode,
            ClassCode: ClassCode.trim(),
            Day: Day,
            Period: periodNumber,
            Status: true
        };

        if (SectionCode && SectionCode.trim() !== '') {
            duplicateQuery.SectionCode = SectionCode;
        } else {
            duplicateQuery.$or = [
                { SectionCode: { $exists: false } },
                { SectionCode: null },
                { SectionCode: '' }
            ];
        }

        const existing = await Timetable.findOne(duplicateQuery);
        if (existing) {
            return res.status(409).json({
                code: 409,
                success: false,
                message: `A timetable entry already exists for ${Day}, Period ${Period}`
            });
        }

        // Prepare Teacher_Id - convert empty string to null for ObjectId
        let teacherIdValue = null;
        if (Teacher_Id && Teacher_Id.trim() !== '' && mongoose.Types.ObjectId.isValid(Teacher_Id)) {
            teacherIdValue = new mongoose.Types.ObjectId(Teacher_Id);
        }

        const timetableData = {
            InstutionCode: instutionCode,
            ClassCode: ClassCode.trim(),
            ClassName: classNameValue,
            SectionCode: (SectionCode && SectionCode.trim() !== '') ? SectionCode.trim() : '',
            SectionName: (SectionName && SectionName.trim() !== '') ? SectionName.trim() : '',
            Day: Day,
            Period: parseInt(Period),
            StartTime: StartTime.trim(),
            EndTime: EndTime.trim(),
            Subject: Subject.trim(),
            Teacher_Code: (Teacher_Code && Teacher_Code.trim() !== '') ? Teacher_Code.trim() : '',
            Teacher_Name: (Teacher_Name && Teacher_Name.trim() !== '') ? Teacher_Name.trim() : '',
            Teacher_Id: teacherIdValue,
            Room: (Room && Room.trim() !== '') ? Room.trim() : '',
            Session: sessionValue,
            Status: true
        };

        const timetable = new Timetable(timetableData);
        await timetable.save();

        // Clear cache
        cache.clear();

        return res.status(201).json({
            code: 201,
            success: true,
            data: timetable,
            message: 'Timetable created successfully'
        });
    } catch (error) {
        logger.error('Error creating timetable:', error);
        console.error('Timetable creation error details:', {
            error: error.message,
            stack: error.stack,
            body: req.body
        });
        
        if (error.code === 11000) {
            return res.status(409).json({
                code: 409,
                success: false,
                message: 'Duplicate timetable entry. A period already exists for this class/section/day combination'
            });
        }

        // Handle validation errors
        if (error.name === 'ValidationError') {
            const validationErrors = Object.keys(error.errors).map(key => ({
                field: key,
                message: error.errors[key].message
            }));
            return res.status(400).json({
                code: 400,
                success: false,
                message: 'Validation error',
                errors: validationErrors,
                error: error.message
            });
        }

        return res.status(500).json({
            code: 500,
            success: false,
            message: 'Error creating timetable',
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

/**
 * Update timetable entry
 */
const update = async (req, res) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            });
        }

        let permissionsResult;
        try {
            permissionsResult = await getPermissionSet(req);
        } catch (permError) {
            logger.error('Error getting permissions:', permError);
            permissionsResult = { timetable: 'R-W-E-D-RA' };
        }

        if (!permissionsResult || !permissionsResult.timetable) {
            permissionsResult = { timetable: 'R-W-E-D-RA' };
        }

        const timetablePermissions = typeof permissionsResult.timetable === 'string' 
            ? permissionsResult.timetable 
            : (permissionsResult.timetable?.toString() || 'R-W-E-D-RA');

        if (!timetablePermissions.split("-").includes('E')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to update timetables'
            });
        }

        const { id } = req.params;
        const instutionCode = req.user.InstutionCode;

        const timetable = await Timetable.findOne({ _id: id, InstutionCode: instutionCode });
        if (!timetable) {
            return res.status(404).json({
                code: 404,
                success: false,
                message: 'Timetable not found'
            });
        }

        const updateData = { ...req.body };
        delete updateData.InstutionCode; // Prevent changing institution
        delete updateData._id; // Prevent changing ID

        // Handle Period conversion
        if (updateData.Period !== undefined) {
            updateData.Period = parseInt(updateData.Period);
            if (isNaN(updateData.Period) || updateData.Period < 1 || updateData.Period > 12) {
                return res.status(400).json({
                    code: 400,
                    success: false,
                    message: 'Period must be a number between 1 and 12'
                });
            }
        }

        // Handle Teacher_Id conversion
        if (updateData.Teacher_Id !== undefined) {
            if (updateData.Teacher_Id && typeof updateData.Teacher_Id === 'string' && updateData.Teacher_Id.trim() !== '' && mongoose.Types.ObjectId.isValid(updateData.Teacher_Id)) {
                try {
                    updateData.Teacher_Id = new mongoose.Types.ObjectId(updateData.Teacher_Id);
                } catch (e) {
                    logger.warn('Invalid Teacher_Id provided:', updateData.Teacher_Id);
                    updateData.Teacher_Id = null;
                }
            } else if (!updateData.Teacher_Id || (typeof updateData.Teacher_Id === 'string' && updateData.Teacher_Id.trim() === '')) {
                updateData.Teacher_Id = null;
            }
        }

        // Trim string fields (only if they are strings)
        if (updateData.ClassCode && typeof updateData.ClassCode === 'string') updateData.ClassCode = updateData.ClassCode.trim();
        if (updateData.ClassName && typeof updateData.ClassName === 'string') updateData.ClassName = updateData.ClassName.trim();
        if (updateData.SectionCode && typeof updateData.SectionCode === 'string') updateData.SectionCode = updateData.SectionCode.trim();
        if (updateData.SectionName && typeof updateData.SectionName === 'string') updateData.SectionName = updateData.SectionName.trim();
        if (updateData.StartTime && typeof updateData.StartTime === 'string') updateData.StartTime = updateData.StartTime.trim();
        if (updateData.EndTime && typeof updateData.EndTime === 'string') updateData.EndTime = updateData.EndTime.trim();
        if (updateData.Subject && typeof updateData.Subject === 'string') updateData.Subject = updateData.Subject.trim();
        if (updateData.Teacher_Code && typeof updateData.Teacher_Code === 'string') updateData.Teacher_Code = updateData.Teacher_Code.trim();
        if (updateData.Teacher_Name && typeof updateData.Teacher_Name === 'string') updateData.Teacher_Name = updateData.Teacher_Name.trim();
        if (updateData.Room && typeof updateData.Room === 'string') updateData.Room = updateData.Room.trim();
        if (updateData.Session && typeof updateData.Session === 'string') updateData.Session = updateData.Session.trim();

        // Handle empty strings for optional fields
        if (updateData.SectionCode === '') updateData.SectionCode = '';
        if (updateData.SectionName === '') updateData.SectionName = '';
        if (updateData.Teacher_Code === '') updateData.Teacher_Code = '';
        if (updateData.Teacher_Name === '') updateData.Teacher_Name = '';
        if (updateData.Room === '') updateData.Room = '';

        Object.assign(timetable, updateData);
        await timetable.save();

        // Clear cache
        cache.clear();

        // Fetch the updated document as a plain object to avoid serialization issues
        const updatedTimetable = await Timetable.findOne({ _id: id, InstutionCode: instutionCode }).lean();

        return res.status(200).json({
            code: 200,
            success: true,
            data: updatedTimetable,
            message: 'Timetable updated successfully'
        });
    } catch (error) {
        logger.error('Error updating timetable:', error);
        return res.status(500).json({
            code: 500,
            success: false,
            message: 'Error updating timetable',
            error: error.message
        });
    }
};

/**
 * Delete timetable entry
 */
const destroy = async (req, res) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            });
        }

        let permissionsResult;
        try {
            permissionsResult = await getPermissionSet(req);
        } catch (permError) {
            logger.error('Error getting permissions:', permError);
            permissionsResult = { timetable: 'R-W-E-D-RA' };
        }

        if (!permissionsResult || !permissionsResult.timetable) {
            permissionsResult = { timetable: 'R-W-E-D-RA' };
        }

        const timetablePermissions = typeof permissionsResult.timetable === 'string' 
            ? permissionsResult.timetable 
            : (permissionsResult.timetable?.toString() || 'R-W-E-D-RA');

        if (!timetablePermissions.split("-").includes('D')) {
            return res.status(403).json({
                code: 403,
                success: false,
                message: 'You do not have the necessary permissions to delete timetables'
            });
        }

        const { id } = req.params;
        const instutionCode = req.user.InstutionCode;

        const timetable = await Timetable.findOne({ _id: id, InstutionCode: instutionCode });
        if (!timetable) {
            return res.status(404).json({
                code: 404,
                success: false,
                message: 'Timetable not found'
            });
        }

        await Timetable.deleteOne({ _id: id });

        // Clear cache
        cache.clear();

        return res.status(200).json({
            code: 200,
            success: true,
            message: 'Timetable deleted successfully'
        });
    } catch (error) {
        logger.error('Error deleting timetable:', error);
        return res.status(500).json({
            code: 500,
            success: false,
            message: 'Error deleting timetable',
            error: error.message
        });
    }
};

/**
 * Get single timetable entry
 */
const show = async (req, res) => {
    try {
        if (!req.user || !req.user.InstutionCode) {
            return res.status(401).json({
                code: 401,
                success: false,
                message: 'User authentication required'
            });
        }

        const { id } = req.params;
        const instutionCode = req.user.InstutionCode;

        const timetable = await Timetable.findOne({ _id: id, InstutionCode: instutionCode }).lean();
        if (!timetable) {
            return res.status(404).json({
                code: 404,
                success: false,
                message: 'Timetable not found'
            });
        }

        return res.status(200).json({
            code: 200,
            success: true,
            data: timetable,
            message: 'Timetable fetched successfully'
        });
    } catch (error) {
        logger.error('Error fetching timetable:', error);
        return res.status(500).json({
            code: 500,
            success: false,
            message: 'Error fetching timetable',
            error: error.message
        });
    }
};

const emptyWeek = () => ({
    Monday: [],
    Tuesday: [],
    Wednesday: [],
    Thursday: [],
    Friday: [],
    Saturday: [],
    Sunday: [],
});

const groupLatest = (rows) => {
    const grouped = emptyWeek();
    const seen = new Set();
    rows.forEach((row) => {
        const key = `${row.Day}-${row.Period}`;
        if (!grouped[row.Day] || seen.has(key)) return;
        seen.add(key);
        grouped[row.Day].push(row);
    });
    Object.values(grouped).forEach((list) => list.sort((a, b) => a.Period - b.Period));
    return grouped;
};

const saveWeek = async (req, res) => {
    try {
        const permissionsResult = await getPermissionSet(req).catch(() => ({ timetable: 'R-W-E-D-RA' }));
        const canWrite = String(permissionsResult?.timetable || '').split('-').includes('W');
        if (!canWrite) {
            return res.status(403).json({ success: false, code: 403, message: 'You cannot change the timetable' });
        }
        const classCode = String(req.body.ClassCode || '').trim();
        const periods = Array.isArray(req.body.periods) ? req.body.periods : [];
        if (!classCode || !periods.length) {
            return res.status(400).json({ success: false, code: 400, message: 'Choose a class and fill at least one period' });
        }
        const classInfo = await classModel.findOne({
            InstutionCode: req.user.InstutionCode,
            ClassCode: classCode,
        }).select('ClassName Session').lean();
        if (!classInfo) {
            return res.status(404).json({ success: false, code: 404, message: 'Class not found' });
        }
        const sectionCode = String(req.body.SectionCode || '').trim();
        const sectionName = String(req.body.SectionName || '').trim();
        const session = classInfo.Session || `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
        let saved = 0;
        let removed = 0;

        for (const period of periods) {
            const day = period.Day;
            const periodNumber = parseInt(period.Period, 10);
            if (!day || !periodNumber) continue;
            const sectionQuery = sectionCode
                ? { SectionCode: sectionCode }
                : { $or: [{ SectionCode: '' }, { SectionCode: null }, { SectionCode: { $exists: false } }] };
            const existing = await Timetable.findOne({
                InstutionCode: req.user.InstutionCode,
                ClassCode: classCode,
                Day: day,
                Period: periodNumber,
                ...sectionQuery,
            });
            const subject = String(period.Subject || '').trim();
            if (!subject) {
                if (existing) {
                    await Timetable.deleteOne({ _id: existing._id });
                    removed += 1;
                }
                continue;
            }
            const teacherId = period.Teacher_Id && mongoose.Types.ObjectId.isValid(period.Teacher_Id)
                ? new mongoose.Types.ObjectId(period.Teacher_Id)
                : null;
            const payload = {
                InstutionCode: req.user.InstutionCode,
                ClassCode: classCode,
                ClassName: classInfo.ClassName,
                SectionCode: sectionCode,
                SectionName: sectionName,
                Day: day,
                Period: periodNumber,
                StartTime: String(period.StartTime || '').trim(),
                EndTime: String(period.EndTime || '').trim(),
                Subject: subject,
                Teacher_Code: String(period.Teacher_Code || '').trim(),
                Teacher_Name: String(period.Teacher_Name || '').trim(),
                Teacher_Id: teacherId,
                Room: String(period.Room || '').trim(),
                Session: session,
                Status: true,
            };
            if (!payload.StartTime || !payload.EndTime) {
                return res.status(400).json({ success: false, code: 400, message: `Add a start and end time for period ${periodNumber}` });
            }
            if (existing) {
                await Timetable.updateOne({ _id: existing._id }, { $set: payload });
            } else {
                await Timetable.create(payload);
            }
            saved += 1;
        }

        return res.status(200).json({
            success: true,
            code: 200,
            message: 'Timetable saved',
            data: { saved, removed },
        });
    } catch (error) {
        logger.error('Error saving timetable week:', error);
        return res.status(500).json({ success: false, code: 500, message: 'Could not save the timetable' });
    }
};

const mine = async (req, res) => {
    try {
        const resolved = resolveOwnStudentRegistration(req);
        if (resolved.error) {
            return res.status(resolved.error.status).json({ success: false, code: resolved.error.status, message: resolved.error.message });
        }
        if (String(req.user?.UserType || '') !== 'Student') {
            return res.status(403).json({ success: false, code: 403, message: 'Only a student can open their class timetable' });
        }
        const student = await studentModel.findOne({
            InstutionCode: req.user.InstutionCode,
            Registration_Number: resolved.registrationNumber,
        }).select('Class Class_Code Section SectionCode').lean();
        if (!student) {
            return res.status(404).json({ success: false, code: 404, message: 'Student record not found' });
        }
        const query = {
            InstutionCode: req.user.InstutionCode,
            Status: true,
            $or: [
                { ClassCode: student.Class_Code || '' },
                { ClassName: student.Class || '' },
            ],
        };
        let rows = await Timetable.find(query).sort({ updatedAt: -1 }).lean();
        if (student.SectionCode || student.Section) {
            const sectionRows = rows.filter((row) => row.SectionCode === student.SectionCode || row.SectionName === student.Section);
            if (sectionRows.length) rows = sectionRows;
        }
        return res.status(200).json({
            success: true,
            code: 200,
            data: {
                className: student.Class || '',
                sectionName: student.Section || '',
                timetable: groupLatest(rows),
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, code: 500, message: 'Could not load your timetable' });
    }
};

module.exports = {
    index,
    getByClassSection,
    store,
    update,
    destroy,
    show,
    saveWeek,
    mine,
};

