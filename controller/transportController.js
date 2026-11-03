const { Vehicle, Driver, TransportRoute, StudentTransport } = require('../models/transportModel');
const studentModel = require('../models/studentModel');
const { logger } = require('../utils/logger');
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response');
const { cache } = require('../utils/cache');

const parseStops = (stops) => {
  if (Array.isArray(stops)) {
    return stops
      .map((stop, index) => {
        if (typeof stop === 'string') {
          const name = stop.trim();
          return name ? { Stop_Name: name, Stop_Order: index + 1 } : null;
        }
        const name = String(stop?.Stop_Name || '').trim();
        if (!name) return null;
        return {
          Stop_Name: name,
          Stop_Order: Number(stop.Stop_Order) || index + 1,
          Arrival_Time: stop.Arrival_Time || '',
        };
      })
      .filter(Boolean);
  }
  return String(stops || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((Stop_Name, index) => ({ Stop_Name, Stop_Order: index + 1 }));
};

const clearStudentCache = (student) => {
  if (!student) return;
  if (student._id) cache.delete(`student:${student._id}`);
  const reg = String(student.Registration_Number || '').trim();
  if (reg) {
    cache.delete(`student-reg:${reg}`);
    cache.delete(`student-profile:${reg}`);
  }
  cache.clear();
};

const syncStudentTransportBilling = async (instutionCode, registrationNumber, { active, fee }) => {
  const reg = String(registrationNumber || '').trim();
  if (!reg) return null;
  const student = await studentModel.findOne({
    InstutionCode: instutionCode,
    Registration_Number: reg,
  });
  if (!student) return null;
  student.UsesTransport = Boolean(active);
  student.TransportMonthlyFee = active ? String(Math.max(0, Number(fee) || 0)) : '0';
  await student.save();
  clearStudentCache(student);
  return student;
};

const assertVehicleHasSeat = async (instutionCode, vehicleId, ignoreAssignmentId, routeId) => {
  if (!vehicleId) return null;
  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    InstutionCode: instutionCode,
    Status: true,
  });
  if (!vehicle) {
    const error = new Error('Selected vehicle was not found');
    error.statusCode = 400;
    throw error;
  }
  if (routeId && String(vehicle.Route_Id || '') !== String(routeId)) {
    const error = new Error('Select a vehicle assigned to this route');
    error.statusCode = 400;
    throw error;
  }
  const count = await StudentTransport.countDocuments({
    InstutionCode: instutionCode,
    Vehicle_Id: vehicleId,
    Status: true,
    ...(ignoreAssignmentId ? { _id: { $ne: ignoreAssignmentId } } : {}),
  });
  if (count >= Number(vehicle.Capacity || 0)) {
    const error = new Error(`This vehicle is full (${vehicle.Capacity} seats)`);
    error.statusCode = 400;
    throw error;
  }
  return vehicle;
};

// Vehicle Management
const getAllVehicles = async (req, res) => {
  try {
    const page = parseInt(req.query.PageNumber) || 1;
    const limit = parseInt(req.query.PageSize) || 10;
    const skip = (page - 1) * limit;

    const [vehicles, totalCount] = await Promise.all([
      Vehicle.find({ InstutionCode: req.user.InstutionCode, Status: true })
        .populate('Driver_Id', 'First_Name Last_Name Contact_Number')
        .populate('Route_Id', 'Route_Name Route_Number')
        .select('-__v')
        .sort({ Vehicle_Number: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Vehicle.countDocuments({ InstutionCode: req.user.InstutionCode, Status: true })
    ]);

    return paginatedResponse(res, vehicles, { page, pageSize: limit, total: totalCount }, 'Vehicles retrieved successfully');
  } catch (error) {
    logger.error('Error fetching vehicles:', error);
    return errorResponse(res, 'Failed to fetch vehicles', 500);
  }
};

const addVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.create({
      ...req.body,
      InstutionCode: req.user.InstutionCode
    });
    return successResponse(res, vehicle, 'Vehicle added successfully', 201);
  } catch (error) {
    logger.error('Error adding vehicle:', error);
    if (error.code === 11000) {
      return errorResponse(res, 'Vehicle with this number already exists', 400);
    }
    return errorResponse(res, 'Failed to add vehicle', 500);
  }
};

const updateVehicle = async (req, res) => {
  try {
    const vehicleId = req.body.vehicleId || req.body._id;
    if (!vehicleId) return errorResponse(res, 'Please provide Vehicle ID', 400);

    const vehicle = await Vehicle.findOneAndUpdate(
      { _id: vehicleId, InstutionCode: req.user.InstutionCode },
      req.body,
      { new: true }
    ).select('-__v');

    if (!vehicle) return errorResponse(res, 'Vehicle not found', 404);
    return successResponse(res, vehicle, 'Vehicle updated successfully');
  } catch (error) {
    logger.error('Error updating vehicle:', error);
    return errorResponse(res, 'Failed to update vehicle', 500);
  }
};

const deleteVehicle = async (req, res) => {
  try {
    const vehicleId = req.body.vehicleId;
    if (!vehicleId) return errorResponse(res, 'Please provide Vehicle ID', 400);

    const vehicle = await Vehicle.findOneAndUpdate(
      { _id: vehicleId, InstutionCode: req.user.InstutionCode },
      { Status: false },
      { new: true }
    );

    if (!vehicle) return errorResponse(res, 'Vehicle not found', 404);
    return successResponse(res, null, 'Vehicle deleted successfully');
  } catch (error) {
    logger.error('Error deleting vehicle:', error);
    return errorResponse(res, 'Failed to delete vehicle', 500);
  }
};

// Driver Management
const getAllDrivers = async (req, res) => {
  try {
    const drivers = await Driver.find({ InstutionCode: req.user.InstutionCode, Status: true })
      .select('-__v')
      .sort({ First_Name: 1 })
      .lean();
    return successResponse(res, drivers, 'Drivers retrieved successfully');
  } catch (error) {
    logger.error('Error fetching drivers:', error);
    return errorResponse(res, 'Failed to fetch drivers', 500);
  }
};

const addDriver = async (req, res) => {
  try {
    const driver = await Driver.create({
      ...req.body,
      InstutionCode: req.user.InstutionCode
    });
    return successResponse(res, driver, 'Driver added successfully', 201);
  } catch (error) {
    logger.error('Error adding driver:', error);
    if (error.code === 11000) {
      return errorResponse(res, 'Driver with this license number already exists', 400);
    }
    return errorResponse(res, 'Failed to add driver', 500);
  }
};

const updateDriver = async (req, res) => {
  try {
    const driverId = req.body.driverId || req.body._id;
    if (!driverId) return errorResponse(res, 'Please provide Driver ID', 400);
    const payload = { ...req.body, Updated_At: new Date() };
    delete payload.driverId;
    delete payload._id;

    const driver = await Driver.findOneAndUpdate(
      { _id: driverId, InstutionCode: req.user.InstutionCode },
      payload,
      { new: true }
    ).select('-__v');

    if (!driver) return errorResponse(res, 'Driver not found', 404);
    return successResponse(res, driver, 'Driver updated successfully');
  } catch (error) {
    logger.error('Error updating driver:', error);
    return errorResponse(res, 'Failed to update driver', 500);
  }
};

const deleteDriver = async (req, res) => {
  try {
    const driverId = req.body.driverId || req.query.driverId;
    if (!driverId) return errorResponse(res, 'Please provide Driver ID', 400);

    const driver = await Driver.findOneAndUpdate(
      { _id: driverId, InstutionCode: req.user.InstutionCode },
      { Status: false, Updated_At: new Date() },
      { new: true }
    );
    if (!driver) return errorResponse(res, 'Driver not found', 404);

    await Vehicle.updateMany(
      { InstutionCode: req.user.InstutionCode, Driver_Id: driverId, Status: true },
      { $unset: { Driver_Id: 1 }, Updated_At: new Date() }
    );

    return successResponse(res, null, 'Driver deleted successfully');
  } catch (error) {
    logger.error('Error deleting driver:', error);
    return errorResponse(res, 'Failed to delete driver', 500);
  }
};

// Route Management
const getAllRoutes = async (req, res) => {
  try {
    const routes = await TransportRoute.find({ InstutionCode: req.user.InstutionCode, Status: true })
      .select('-__v')
      .sort({ Route_Name: 1 })
      .lean();
    return successResponse(res, routes, 'Routes retrieved successfully');
  } catch (error) {
    logger.error('Error fetching routes:', error);
    return errorResponse(res, 'Failed to fetch routes', 500);
  }
};

const addRoute = async (req, res) => {
  try {
    const route = await TransportRoute.create({
      ...req.body,
      Stops: parseStops(req.body.Stops),
      Fee: Number(req.body.Fee || 0),
      InstutionCode: req.user.InstutionCode
    });
    return successResponse(res, route, 'Route added successfully', 201);
  } catch (error) {
    logger.error('Error adding route:', error);
    return errorResponse(res, 'Failed to add route', 500);
  }
};

const updateRoute = async (req, res) => {
  try {
    const routeId = req.body.routeId || req.body._id;
    if (!routeId) return errorResponse(res, 'Please provide Route ID', 400);
    const payload = { ...req.body, Updated_At: new Date() };
    delete payload.routeId;
    delete payload._id;
    if (payload.Stops !== undefined) payload.Stops = parseStops(payload.Stops);
    if (payload.Fee !== undefined) payload.Fee = Number(payload.Fee || 0);

    const route = await TransportRoute.findOneAndUpdate(
      { _id: routeId, InstutionCode: req.user.InstutionCode },
      payload,
      { new: true }
    ).select('-__v');

    if (!route) return errorResponse(res, 'Route not found', 404);
    return successResponse(res, route, 'Route updated successfully');
  } catch (error) {
    logger.error('Error updating route:', error);
    return errorResponse(res, 'Failed to update route', 500);
  }
};

const deleteRoute = async (req, res) => {
  try {
    const routeId = req.body.routeId || req.query.routeId;
    if (!routeId) return errorResponse(res, 'Please provide Route ID', 400);

    const route = await TransportRoute.findOneAndUpdate(
      { _id: routeId, InstutionCode: req.user.InstutionCode },
      { Status: false, Updated_At: new Date() },
      { new: true }
    );
    if (!route) return errorResponse(res, 'Route not found', 404);

    await Vehicle.updateMany(
      { InstutionCode: req.user.InstutionCode, Route_Id: routeId, Status: true },
      { $unset: { Route_Id: 1 }, Updated_At: new Date() }
    );

    const dropped = await StudentTransport.find({
      InstutionCode: req.user.InstutionCode,
      Route_Id: routeId,
      Status: true,
    }).select('Registration_Number');
    await StudentTransport.updateMany(
      { InstutionCode: req.user.InstutionCode, Route_Id: routeId, Status: true },
      { Status: false, End_Date: new Date(), Updated_At: new Date() }
    );
    for (const row of dropped) {
      await syncStudentTransportBilling(req.user.InstutionCode, row.Registration_Number, {
        active: false,
        fee: 0,
      });
    }

    return successResponse(res, null, 'Route deleted successfully');
  } catch (error) {
    logger.error('Error deleting route:', error);
    return errorResponse(res, 'Failed to delete route', 500);
  }
};

// Student Transport Assignment
const assignStudentTransport = async (req, res) => {
  try {
    const registrationNumber = String(req.body.registrationNumber || '').trim();
    const routeId = req.body.routeId;
    const vehicleId = req.body.vehicleId || undefined;
    const stopName = String(req.body.stopName || '').trim();

    if (!registrationNumber || !routeId) {
      return errorResponse(res, 'Please provide registrationNumber and routeId', 400);
    }

    const student = await studentModel.findOne({
      InstutionCode: req.user.InstutionCode,
      Registration_Number: registrationNumber,
    }).select('Registration_Number First_Name Last_Name');
    if (!student) return errorResponse(res, 'Student not found in this school', 404);

    const route = await TransportRoute.findOne({
      _id: routeId,
      InstutionCode: req.user.InstutionCode,
      Status: true,
    });
    if (!route) return errorResponse(res, 'Route not found', 404);

    const existing = await StudentTransport.findOne({
      Registration_Number: registrationNumber,
      InstutionCode: req.user.InstutionCode,
      Status: true
    });
    if (existing) {
      return errorResponse(res, 'Student already has transport assigned', 400);
    }

    await assertVehicleHasSeat(req.user.InstutionCode, vehicleId, null, routeId);
    const fee = Number(req.body.fee) > 0 ? Number(req.body.fee) : Number(route.Fee || 0);

    const assignment = await StudentTransport.create({
      InstutionCode: req.user.InstutionCode,
      Registration_Number: registrationNumber,
      Route_Id: routeId,
      Vehicle_Id: vehicleId,
      Stop_Name: stopName,
      Fee: fee
    });

    await syncStudentTransportBilling(req.user.InstutionCode, registrationNumber, {
      active: true,
      fee,
    });

    return successResponse(res, assignment, 'Transport assigned successfully', 201);
  } catch (error) {
    logger.error('Error assigning transport:', error);
    return errorResponse(res, error.statusCode ? error.message : 'Failed to assign transport', error.statusCode || 500);
  }
};

const getStudentTransport = async (req, res) => {
  try {
    const registrationNumber = req.query.registrationNumber;

    if (!registrationNumber) {
      return errorResponse(res, 'Please provide Registration Number', 400);
    }

    const transport = await StudentTransport.findOne({
      Registration_Number: registrationNumber,
      InstutionCode: req.user.InstutionCode,
      Status: true
    })
      .populate('Route_Id', 'Route_Name Route_Number Stops')
      .populate('Vehicle_Id', 'Vehicle_Number Vehicle_Type Capacity')
      .select('-__v')
      .lean();

    if (!transport) {
      return errorResponse(res, 'Transport not assigned', 404);
    }

    return successResponse(res, transport, 'Transport details retrieved successfully');
  } catch (error) {
    logger.error('Error fetching transport:', error);
    return errorResponse(res, 'Failed to fetch transport', 500);
  }
};

const getAllStudentTransport = async (req, res) => {
  try {
    const assignments = await StudentTransport.find({
      InstutionCode: req.user.InstutionCode,
      Status: true
    })
      .populate('Route_Id', 'Route_Name Route_Number Fee Stops')
      .populate('Vehicle_Id', 'Vehicle_Number Vehicle_Type Capacity')
      .select('-__v')
      .sort({ createdAt: -1 })
      .lean();

    const regs = [...new Set(assignments.map((row) => String(row.Registration_Number || '').trim()).filter(Boolean))];
    const students = regs.length
      ? await studentModel
          .find({ InstutionCode: req.user.InstutionCode, Registration_Number: { $in: regs } })
          .select('Registration_Number First_Name Last_Name Class Section UsesTransport TransportMonthlyFee')
          .lean()
      : [];
    const byReg = new Map(students.map((student) => [String(student.Registration_Number || '').trim(), student]));
    const withStudents = assignments.map((row) => {
      const student = byReg.get(String(row.Registration_Number || '').trim());
      return {
        ...row,
        Student_Name: student ? `${student.First_Name || ''} ${student.Last_Name || ''}`.trim() : '',
        Class: student?.Class || '',
        Section: student?.Section || '',
        UsesTransport: student?.UsesTransport === true,
      };
    });

    return successResponse(res, withStudents, 'Student transport assignments retrieved successfully');
  } catch (error) {
    logger.error('Error fetching all student transport assignments:', error);
    return errorResponse(res, 'Failed to fetch student transport assignments', 500);
  }
};

const updateStudentTransport = async (req, res) => {
  try {
    const assignmentId = req.body.assignmentId || req.body._id;
    if (!assignmentId) return errorResponse(res, 'Please provide assignment ID', 400);
    const current = await StudentTransport.findOne({
      _id: assignmentId,
      InstutionCode: req.user.InstutionCode,
      Status: true,
    });
    if (!current) return errorResponse(res, 'Transport assignment not found', 404);

    const registrationNumber = String(
      req.body.Registration_Number || req.body.registrationNumber || current.Registration_Number
    ).trim();
    const routeId = req.body.Route_Id || req.body.routeId || current.Route_Id;
    const vehicleId = req.body.Vehicle_Id || req.body.vehicleId || undefined;
    const route = await TransportRoute.findOne({
      _id: routeId,
      InstutionCode: req.user.InstutionCode,
      Status: true,
    });
    if (!route) return errorResponse(res, 'Route not found', 404);

    const student = await studentModel.findOne({
      InstutionCode: req.user.InstutionCode,
      Registration_Number: registrationNumber,
    }).select('Registration_Number');
    if (!student) return errorResponse(res, 'Student not found in this school', 404);

    await assertVehicleHasSeat(req.user.InstutionCode, vehicleId, assignmentId, routeId);
    const requestedFee = req.body.Fee !== undefined ? req.body.Fee : req.body.fee;
    const fee = Number(requestedFee) > 0 ? Number(requestedFee) : Number(route.Fee || 0);

    const assignment = await StudentTransport.findOneAndUpdate(
      { _id: assignmentId, InstutionCode: req.user.InstutionCode, Status: true },
      {
        Registration_Number: registrationNumber,
        Route_Id: routeId,
        Vehicle_Id: vehicleId || undefined,
        Stop_Name: String(req.body.Stop_Name ?? req.body.stopName ?? current.Stop_Name ?? '').trim(),
        Fee: fee,
        Updated_At: new Date(),
      },
      { new: true }
    );

    if (String(current.Registration_Number) !== registrationNumber) {
      await syncStudentTransportBilling(req.user.InstutionCode, current.Registration_Number, {
        active: false,
        fee: 0,
      });
    }
    await syncStudentTransportBilling(req.user.InstutionCode, registrationNumber, {
      active: true,
      fee,
    });

    return successResponse(res, assignment, 'Transport assignment updated successfully');
  } catch (error) {
    logger.error('Error updating student transport assignment:', error);
    return errorResponse(res, error.statusCode ? error.message : 'Failed to update student transport assignment', error.statusCode || 500);
  }
};

const removeStudentTransport = async (req, res) => {
  try {
    const assignmentId = req.body.assignmentId || req.query.assignmentId;
    if (!assignmentId) return errorResponse(res, 'Please provide assignment ID', 400);

    const assignment = await StudentTransport.findOneAndUpdate(
      { _id: assignmentId, InstutionCode: req.user.InstutionCode, Status: true },
      { Status: false, End_Date: new Date(), Updated_At: new Date() },
      { new: true }
    );

    if (!assignment) return errorResponse(res, 'Transport assignment not found', 404);
    await syncStudentTransportBilling(req.user.InstutionCode, assignment.Registration_Number, {
      active: false,
      fee: 0,
    });
    return successResponse(res, null, 'Transport assignment removed successfully');
  } catch (error) {
    logger.error('Error removing student transport assignment:', error);
    return errorResponse(res, 'Failed to remove student transport assignment', 500);
  }
};

module.exports = {
  getAllVehicles,
  addVehicle,
  updateVehicle,
  deleteVehicle,
  getAllDrivers,
  addDriver,
  updateDriver,
  deleteDriver,
  getAllRoutes,
  addRoute,
  updateRoute,
  deleteRoute,
  assignStudentTransport,
  getStudentTransport,
  getAllStudentTransport,
  updateStudentTransport,
  removeStudentTransport
};

