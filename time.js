'use strict';

// Helpers for turning "2026-11-07-18-30" into a real point in time in a given
// time zone (e.g. "America/Los_Angeles"), regardless of where the bot is hosted.

// How far ahead of UTC the time zone is at the given moment, in milliseconds.
function timeZoneOffset(timestamp, timeZone) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
	}).formatToParts(new Date(timestamp));
	const get = type => Number(parts.find(p => p.type === type).value);
	const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
	return asUtc - Math.floor(timestamp / 1000) * 1000;
}

// Parses Year-Month-Day-Hour-Minute (24-hour clock). Returns a Date or null.
function parseStartTime(input, timeZone) {
	const m = /^(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})$/.exec(String(input).trim());
	if (!m) return null;
	const [year, month, day, hour, minute] = m.slice(1).map(Number);
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

	const wallClock = Date.UTC(year, month - 1, day, hour, minute);
	// Reject dates like Feb 31 that JavaScript would silently roll over.
	if (new Date(wallClock).getUTCDate() !== day) return null;

	let ts = wallClock - timeZoneOffset(wallClock, timeZone);
	ts = wallClock - timeZoneOffset(ts, timeZone); // second pass handles DST edges
	return new Date(ts);
}

function isValidTimeZone(timeZone) {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
		return true;
	} catch {
		return false;
	}
}

module.exports = { parseStartTime, isValidTimeZone };
