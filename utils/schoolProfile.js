const InstutionModel = require('../models/InstutionModel')
const userModel = require('../models/User')
const { SystemSettings } = require('../models/academicYearModel')

const clean = (value) => String(value || '').trim()

const loadSchoolProfile = async (req) => {
  const code = clean(req.user?.InstutionCode)
  if (!code) {
    const error = new Error('Your account is not linked to a school')
    error.status = 400
    throw error
  }

  const [institution, settings, namedUser] = await Promise.all([
    InstutionModel.findOne({ Instution_Id: code }).lean(),
    SystemSettings.findOne({ InstutionCode: code }).lean(),
    userModel.findOne({
      InstutionCode: code,
      InstutionName: { $nin: [null, ''] },
    }).select('InstutionName').lean(),
  ])

  const name = [
    settings?.School_Name,
    institution?.Instution_Name,
    req.user?.InstutionName,
    namedUser?.InstutionName,
  ].map(clean).find(Boolean)

  if (!name) {
    const error = new Error('Add the school name in Settings before issuing a leaving certificate')
    error.status = 400
    throw error
  }

  const address = clean(settings?.Address) || clean(institution?.Address)
  const district = clean(institution?.District)
  const state = clean(institution?.State)
  const addressLine = [address, district, state].filter(Boolean).join(', ')

  return {
    code,
    name,
    addressLine,
    phone: clean(settings?.Contact_Phone) || clean(institution?.Contact_Number),
    email: clean(settings?.Contact_Email) || clean(institution?.Email),
    affiliation: clean(institution?.Affiliation),
  }
}

module.exports = { loadSchoolProfile }
