const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDateString(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function fromDateString(value) {
  if (!isDateString(value)) throw new TypeError(`Invalid date: ${value}`);
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, amount) {
  const date = fromDateString(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return toDateString(date);
}

function todayInTimeZone(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function startOfMonth(value) {
  return `${value.slice(0, 7)}-01`;
}

module.exports = {
  addDays,
  fromDateString,
  isDateString,
  startOfMonth,
  toDateString,
  todayInTimeZone,
};
