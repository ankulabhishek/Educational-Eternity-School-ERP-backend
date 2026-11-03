/**
 * Outstanding / baki must be the same number everywhere:
 * unpaid previous monthly months + unpaid current-month monthly fee.
 * Yearly heads never enter outstanding.
 *
 * Run: node scripts/verifyFeePendingCalc.js
 */
const {
  computeStudentTotalPayable,
  computeTotalMonthlyOutstanding,
  getPreviousMonthlyPending,
} = require('../utils/feeHeads')

const structure = {
  TutionFee: 4000,
  TutionFeeFrequency: 'monthly',
  LibraryFee: 1000,
  LibraryFeeFrequency: 'monthly',
  ActivityFee: 0,
  ExamFee: 2000,
  ExamFeeFrequency: 'yearly',
  UniformFee: 1500,
  UniformFeeFrequency: 'yearly',
  ProspectusFee: 0,
  AdmissionFee: 0,
  TransportFee: 0,
}

const monthly = 5000
const yearly = 3500

const systemRow = (month, id = `sys-${month}`) => ({
  _id: id,
  PaymentMode: 'SYSTEM',
  FeeType: 'Monthly',
  Month: month,
  Status: 'Pending',
  PaidAmount: '0',
  SelectedFeeHeads: ['TutionFee', 'LibraryFee'],
})

const paidMonthly = (month, amount, extra = {}) => ({
  _id: `pay-${month}-${amount}`,
  Status: 'Success',
  VerificationStatus: 'Approved',
  PaymentMode: 'Cash',
  FeeType: extra.FeeType || 'Monthly',
  Month: month,
  PaidAmount: String(amount),
  TutionFee: extra.TutionFee != null ? String(extra.TutionFee) : '4000',
  LibraryFee: extra.LibraryFee != null ? String(extra.LibraryFee) : '1000',
  ExamFee: extra.ExamFee != null ? String(extra.ExamFee) : '0',
  UniformFee: extra.UniformFee != null ? String(extra.UniformFee) : '0',
  SelectedFeeHeads: extra.heads || ['TutionFee', 'LibraryFee'],
  ScholarshipAmount: '0',
  ConcessionAmount: '0',
  ...extra,
})

const assertEq = (label, actual, expected) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

const payable = (payments, month, stored = 0) =>
  computeStudentTotalPayable(structure, payments, {
    month,
    storedOutstanding: stored,
  })

// 1. No payments, stored 0 → only current month monthly
{
  const p = payable([], '2026-06', 0)
  assertEq('fresh student current due', p.outstanding, monthly)
  assertEq('fresh student arrears', p.arrears, 0)
}

// 2. Inflated stored (yearly leaked) after generation must not win over ledger
{
  const payments = [systemRow('2026-04'), systemRow('2026-05'), systemRow('2026-06')]
  const stored = monthly * 3 + yearly
  const p = payable(payments, '2026-06', stored)
  const ledger = computeTotalMonthlyOutstanding(structure, payments, { month: '2026-06' })
  assertEq('inflated stored matches ledger', p.outstanding, ledger.outstanding)
  assertEq('three unpaid months', p.outstanding, monthly * 3)
  assertEq('yearly not in baki', p.outstanding, 15000)
}

// 3. Math.max(stored, ledger) regression: stored higher than ledger
{
  const payments = [systemRow('2026-06')]
  const p = payable(payments, '2026-06', monthly + yearly)
  assertEq('do not keep yearly in current-only stored', p.outstanding, monthly)
}

// 4. Total due typed on the student is previous pending, added to this month
{
  const p = payable([], '2026-06', 2000)
  assertEq('student total due is arrears', p.arrears, 2000)
  assertEq('student total due plus current month', p.outstanding, monthly + 2000)
}

// 5. After generation, saved total (opening + current month) stays opening + current month
{
  const p = payable([systemRow('2026-06')], '2026-06', 2000 + monthly)
  assertEq('opening remains after this month is generated', p.arrears, 2000)
  assertEq('generated month keeps opening plus current', p.outstanding, monthly + 2000)
}

// 6. Pay this month, previous unpaid months remain
{
  const payments = [
    systemRow('2026-04'),
    systemRow('2026-05'),
    systemRow('2026-06'),
    paidMonthly('2026-06', monthly),
  ]
  const p = payable(payments, '2026-06', monthly * 2)
  assertEq('after paying June, April+May remain', p.outstanding, monthly * 2)
  assertEq('June current due cleared', p.currentMonthDue, 0)
}

// 7. Collect-fee previous arrears === outstanding − current
{
  const payments = [systemRow('2026-05'), systemRow('2026-06')]
  const p = payable(payments, '2026-06', 0)
  const prev = getPreviousMonthlyPending(payments, {
    structure,
    month: '2026-06',
    fallback: 0,
    currentMonthDue: monthly,
  })
  assertEq('collect previous arrears', prev, p.arrears)
  assertEq('collect previous is one month', prev, monthly)
  assertEq('total due is arrears + current', p.outstanding, prev + p.currentMonthDue)
}

// 8. Paying yearly only does not reduce monthly baki
{
  const payments = [
    systemRow('2026-06'),
    paidMonthly('2026-06', yearly, {
      heads: ['ExamFee', 'UniformFee'],
      FeeType: 'Yearly',
      TutionFee: '0',
      LibraryFee: '0',
      ExamFee: '2000',
      UniformFee: '1500',
    }),
  ]
  const p = payable(payments, '2026-06', monthly)
  assertEq('yearly collection leaves monthly due', p.outstanding, monthly)
}

// 9. Collecting this month keeps the student total due; collecting pending clears it
{
  const openingStored = 2000
  const cashMonth = paidMonthly('2026-06', monthly)
  const afterMonth = computeStudentTotalPayable(structure, [cashMonth], {
    month: '2026-06',
    storedOutstanding: openingStored + monthly,
    settlePayment: cashMonth,
  })
  assertEq('paying this month leaves student total due', afterMonth.outstanding, openingStored)

  const cashAll = paidMonthly('2026-06', monthly + openingStored, {
    heads: ['TutionFee', 'LibraryFee', 'PendingFee'],
    PaidAmount: String(monthly + openingStored),
  })
  const afterAll = computeStudentTotalPayable(structure, [cashAll], {
    month: '2026-06',
    storedOutstanding: openingStored + monthly,
    settlePayment: cashAll,
  })
  assertEq('paying pending clears student total due', afterAll.outstanding, 0)
}

console.log('Fee outstanding / baki scenarios passed')
