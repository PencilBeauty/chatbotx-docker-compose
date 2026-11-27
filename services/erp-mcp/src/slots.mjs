const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function minutesOf(localDateTime) {
  const [hours, minutes] = localDateTime.slice(11, 16).split(":").map(Number)
  return hours * 60 + minutes
}

function formatMinutes(total) {
  const hours = String(Math.floor(total / 60)).padStart(2, "0")
  const minutes = String(total % 60).padStart(2, "0")
  return `${hours}:${minutes}`
}

export function toRanges(slots) {
  const starts = [...new Set(slots.map(minutesOf))].sort((a, b) => a - b)
  if (starts.length === 0) {
    return []
  }
  const gaps = starts.slice(1).map((value, index) => value - starts[index])
  const step = gaps.length > 0 ? Math.min(...gaps) : 30
  const ranges = []
  let rangeStart = starts[0]
  let previous = starts[0]
  for (const start of starts.slice(1)) {
    if (start - previous !== step) {
      ranges.push([rangeStart, previous])
      rangeStart = start
    }
    previous = start
  }
  ranges.push([rangeStart, previous])
  return ranges.map(([from, to]) => (from === to ? formatMinutes(from) : `${formatMinutes(from)}-${formatMinutes(to)}`))
}

export function weekdayOf(date) {
  const [year, month, day] = date.split("-").map(Number)
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
}
