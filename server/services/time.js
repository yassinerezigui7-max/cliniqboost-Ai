// Timezone helpers for quiet-hours enforcement. Uses the built-in Intl API —
// no external dependency. Falls back to UTC on an invalid/missing timezone.

const QUIET_START_HOUR = 9;   // 09:00 local — earliest sendable
const QUIET_END_HOUR = 19;    // 19:00 local — latest sendable (exclusive)

function safeTz(tz) {
  if (!tz) return 'UTC';
  try {
    // Throws RangeError on an invalid timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch (_e) {
    console.warn(`[time] invalid timezone "${tz}" — falling back to UTC`);
    return 'UTC';
  }
}

// Break a Date into wall-clock parts in the given timezone.
function partsInTz(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const p = dtf.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // some environments emit "24" for midnight
  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10),
    day: parseInt(p.day, 10),
    hour,
    minute: parseInt(p.minute, 10),
    second: parseInt(p.second, 10)
  };
}

// ms to add to a UTC instant to get local wall-clock time in `tz`.
function tzOffsetMs(date, tz) {
  const p = partsInTz(date, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - date.getTime();
}

// Current local hour (0-23) in the clinic timezone.
function localHour(tz, now = new Date()) {
  return partsInTz(now, safeTz(tz)).hour;
}

// Is `now` within sendable hours (09:00–19:00 local)?
function isWithinQuietHours(tz, now = new Date()) {
  const h = localHour(safeTz(tz), now);
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

// The next 09:00 local time (today if before 09:00, else tomorrow), as a UTC ISO string.
function nextSendTimeUtc(tz, now = new Date()) {
  const zone = safeTz(tz);
  const p = partsInTz(now, zone);

  let { year, month, day } = p;
  if (p.hour >= QUIET_START_HOUR) {
    // move to tomorrow (local calendar day)
    const t = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
    year = t.getUTCFullYear();
    month = t.getUTCMonth() + 1;
    day = t.getUTCDate();
  }

  // Convert local wall time (year-month-day 09:00) to a UTC instant.
  const guess = Date.UTC(year, month - 1, day, QUIET_START_HOUR, 0, 0);
  let utc = guess - tzOffsetMs(new Date(guess), zone);
  // Refine once to absorb DST transitions.
  utc = guess - tzOffsetMs(new Date(utc), zone);
  return new Date(utc).toISOString();
}

module.exports = { isWithinQuietHours, nextSendTimeUtc, localHour, QUIET_START_HOUR, QUIET_END_HOUR };
