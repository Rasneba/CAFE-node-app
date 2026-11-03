const { HttpError } = require('./errors');
const {
  addDays,
  fromDateString,
  isDateString,
  startOfMonth,
  todayInTimeZone,
} = require('./dateUtils');

const MAX_RANGE_DAYS = 366;

function parseReportCriteria(query, timeZone) {
  const today = todayInTimeZone(timeZone);
  const from = query.from || startOfMonth(today);
  const to = query.to || today;

  if (!isDateString(from) || !isDateString(to)) {
    throw new HttpError(400, 'INVALID_DATE', 'Dates must use the YYYY-MM-DD format and be real calendar dates.');
  }
  if (from > to) {
    throw new HttpError(400, 'INVALID_DATE_RANGE', 'The start date must be on or before the end date.');
  }

  const days = Math.round((fromDateString(to) - fromDateString(from)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new HttpError(400, 'DATE_RANGE_TOO_LARGE', `Choose a date range of ${MAX_RANGE_DAYS} days or less.`);
  }

  return { from, to, days, nextDay: addDays(to, 1) };
}

module.exports = { MAX_RANGE_DAYS, parseReportCriteria };
