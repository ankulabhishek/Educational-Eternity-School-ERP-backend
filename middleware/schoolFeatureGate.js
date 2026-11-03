const jwt = require('jsonwebtoken')
const Institution = require('../models/InstutionModel')
const { getJwtAccessSecret } = require('../utils/jwtConfig')
const { featureForApiPath, normalizeFeatures } = require('../utils/schoolFeatures')

const roleOf = (user) => String(user?.UserType || '').trim().toLowerCase().replace(/\s+/g, '')

const schoolFeatureGate = async (req, res, next) => {
  try {
    if (req.method === 'OPTIONS') return next()
    const feature = featureForApiPath(req.originalUrl || req.path)
    if (!feature) return next()
    if (String(req.originalUrl || '').includes('/school-features')) return next()

    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ')) return next()
    let user
    try {
      user = jwt.verify(header.slice(7), getJwtAccessSecret())
    } catch {
      return next()
    }
    if (roleOf(user) === 'superadmin') return next()

    const code = String(user.InstutionCode || '').trim()
    if (!code) return next()
    const institution = await Institution.findOne({ Instution_Id: code }).select('Features').lean()
    const features = normalizeFeatures(institution?.Features)
    if (features[feature]) return next()

    return res.status(403).json({
      success: false,
      code: 'PLAN_REQUIRED',
      feature,
      message: 'Upgrade your plan to use this feature. Please contact your admin.',
    })
  } catch {
    return next()
  }
}

module.exports = schoolFeatureGate
