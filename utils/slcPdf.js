const PDFDocument = require('pdfkit')

const formatDate = (value) => {
  if (!value) return '—'
  const raw = String(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const [year, month, day] = raw.slice(0, 10).split('-').map(Number)
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
}

const renderSlcPdf = (school, certificate) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 36 })
  const chunks = []
  doc.on('data', (chunk) => chunks.push(chunk))
  doc.on('end', () => resolve(Buffer.concat(chunks)))
  doc.on('error', reject)

  const pageWidth = doc.page.width
  const left = 48
  const width = pageWidth - 96

  doc.lineWidth(2).strokeColor('#1e3a8a').rect(28, 24, pageWidth - 56, doc.page.height - 48).stroke()
  doc.lineWidth(0.6).rect(34, 30, pageWidth - 68, doc.page.height - 60).stroke()

  let y = 52
  doc.fillColor('#1e3a8a').font('Helvetica-Bold').fontSize(18)
  const nameHeight = doc.heightOfString(school.name, { width, align: 'center' })
  doc.text(school.name, left, y, { width, align: 'center' })
  y += nameHeight + 6

  doc.fillColor('#334155').font('Helvetica').fontSize(10)
  const contact = [school.addressLine, [school.phone, school.email].filter(Boolean).join('  |  '), school.affiliation ? `Affiliation: ${school.affiliation}` : '']
    .filter(Boolean)
  contact.forEach((line) => {
    doc.text(line, left, y, { width, align: 'center' })
    y += 14
  })

  y += 8
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#1e3a8a').stroke()
  y += 16
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(14)
  doc.text('SCHOOL LEAVING CERTIFICATE', left, y, { width, align: 'center' })
  y += 28
  doc.font('Helvetica').fontSize(11).fillColor('#111827')
  doc.text(`Certificate number: ${certificate.SLCNumber}`, left, y, { width: width / 2 })
  doc.text(`Date: ${formatDate(certificate.updatedAt || certificate.createdAt)}`, left + width / 2, y, { width: width / 2, align: 'right' })
  y += 28
  doc.text('This is to certify that the student named below was studying in this school and has now left.', left, y, { width })
  y += 36

  const rows = [
    ['Student name', certificate.StudentName],
    ["Father's name", certificate.FatherName],
    ["Mother's name", certificate.MotherName],
    ['Date of birth', certificate.DOB],
    ['Gender', certificate.Gender],
    ['Roll number', certificate.RegistrationNumber],
    ['Class', [certificate.ClassName, certificate.SectionName].filter(Boolean).join(' - ')],
    ['Date of admission', formatDate(certificate.DateOfAdmission)],
    ['Date of leaving', formatDate(certificate.DateOfLeaving)],
    ['Reason for leaving', certificate.Reason],
    ['Promoted to the next class', certificate.Promoted ? 'Yes' : 'No'],
    ['Conduct', certificate.Conduct],
    ['Attendance', certificate.WorkingDays ? `${certificate.AttendedDays || 0} days present out of ${certificate.WorkingDays}` : ''],
    ['School fees', certificate.FeesCleared ? 'Cleared' : 'Not cleared'],
    ['Address', certificate.Address],
    ['Remarks', certificate.Remarks],
  ]

  rows.forEach(([label, value]) => {
    const text = value ? String(value) : '—'
    const textHeight = Math.max(16, doc.heightOfString(text, { width: width - 190 }))
    doc.font('Helvetica-Bold').fontSize(11).text(label, left, y, { width: 170 })
    doc.font('Helvetica').text(text, left + 180, y, { width: width - 180 })
    y += textHeight + 6
  })

  y += 16
  doc.font('Helvetica-Oblique').fontSize(10)
  doc.text('The particulars above are taken from the school record.', left, y, { width })
  y += 56
  doc.font('Helvetica').fontSize(11)
  doc.text('Class teacher', left, y, { width: 180 })
  doc.text('Principal', left + width - 180, y, { width: 180, align: 'right' })
  y += 16
  doc.fontSize(9).fillColor('#475569')
  doc.text(school.name, left + width - 220, y, { width: 220, align: 'right' })

  doc.end()
})

module.exports = { renderSlcPdf, formatDate }
