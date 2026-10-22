// Recurring call math. Calls are stored as a local wall-clock date/time in an
// IANA timezone so a "Tuesdays at 7pm Central" call stays at 7pm across DST.

const STEP_DAYS = { weekly: 7, biweekly: 14, once: 0 };

export const FREQUENCIES = Object.keys(STEP_DAYS);

function tzOffsetMs(ts, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// Converts a wall-clock time in timeZone to a UTC timestamp.
export function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, timeZone);
  const second = guess - tzOffsetMs(first, timeZone);
  return second;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function addDays(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

// Returns the upcoming occurrences (including one in progress) for a call.
export function upcomingOccurrences(call, now = Date.now(), count = 3) {
  const step = STEP_DAYS[call.frequency] ?? 7;
  const durationMs = call.duration_min * 60_000;
  const out = [];
  let date = call.start_date;
  const startTs = zonedToUtc(date, call.start_time, call.timezone);

  if (step > 0 && startTs + durationMs < now) {
    // Jump close to now, then walk forward to absorb DST drift.
    const skip = Math.floor((now - startTs) / (step * 86_400_000));
    date = addDays(date, Math.max(0, skip - 1) * step);
  }

  for (let guard = 0; out.length < count && guard < 1000; guard++) {
    const ts = zonedToUtc(date, call.start_time, call.timezone);
    if (ts + durationMs >= now) out.push({ occurrence: date, startsAt: new Date(ts).toISOString() });
    if (step === 0) break;
    date = addDays(date, step);
  }
  return out;
}
