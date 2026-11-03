const shuffle = (items) => {
  const list = [...items]
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const current = list[i]
    list[i] = list[j]
    list[j] = current
  }
  return list
}

/** Pick `count` questions. When shuffle is on, the pick is random. */
const pickQuestions = (pool, count, { shuffleQuestions = true } = {}) => {
  const list = Array.isArray(pool) ? pool.filter(Boolean) : []
  const wanted = Math.max(0, Number(count) || 0)
  const size = Math.min(wanted, list.length)
  const ordered = shuffleQuestions ? shuffle(list) : [...list]
  return ordered.slice(0, size)
}

const publicQuestion = (question) => ({
  _id: question._id,
  QuestionText: question.QuestionText,
  Type: question.Type,
  Options: (question.Options || []).map((option) => ({
    Key: option.Key,
    Text: option.Text,
  })),
  Marks: Number(question.Marks) || 0,
})

const scoreAnswers = (questions, answers = []) => {
  const byId = new Map((Array.isArray(answers) ? answers : []).map((answer) => [String(answer.Question_Id), answer]))
  let mcqScore = 0
  let longScore = 0
  let maxScore = 0

  ;(Array.isArray(questions) ? questions : []).forEach((question) => {
    const marks = Number(question.Marks) || 0
    maxScore += marks
    const answer = byId.get(String(question._id))
    if (question.Type === 'mcq') {
      const selected = String(answer?.SelectedOption || '').trim().toUpperCase()
      const correct = String(question.CorrectOption || '').trim().toUpperCase()
      if (selected && correct && selected === correct) mcqScore += marks
      return
    }
    const awarded = Math.max(0, Number(answer?.AwardedMarks) || 0)
    longScore += Math.min(marks, awarded)
  })

  return {
    mcqScore,
    longScore,
    totalScore: mcqScore + longScore,
    maxScore,
  }
}

module.exports = {
  shuffle,
  pickQuestions,
  publicQuestion,
  scoreAnswers,
}
