const FEATURE_KEYS = [
  'teacherAttendance',
  'leave',
  'transport',
  'hostel',
  'store',
  'assignment',
  'onlineExam',
  'library',
]

const normalizeFeatures = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {}
  return FEATURE_KEYS.reduce((features, key) => {
    features[key] = source[key] === true
    return features
  }, {})
}

const featureForApiPath = (path) => {
  const value = String(path || '')
  if (value.includes('/teacher-attendance')) return 'teacherAttendance'
  if (value.includes('/leave')) return 'leave'
  if (value.includes('/transport')) return 'transport'
  if (value.includes('/hostel')) return 'hostel'
  if (value.includes('/store')) return 'store'
  if (value.includes('/assignment') || value.includes('/homework')) return 'assignment'
  if (value.includes('/online-exam')) return 'onlineExam'
  if (value.includes('/library')) return 'library'
  return null
}

module.exports = {
  FEATURE_KEYS,
  normalizeFeatures,
  featureForApiPath,
}
