/** Memo id = YYYYMMDDHHmm + 4-digit sequence, e.g. 2026072601370000 */

export const MEMO_ID_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{4})$/;

export function parseMemoId(id: string): {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
	seq: string;
	date: string; // YYYY-MM-DD
} | null {
	const m = MEMO_ID_RE.exec(id);
	if (!m) return null;
	const [, year, month, day, hour, minute, seq] = m;
	return {
		year: year!,
		month: month!,
		day: day!,
		hour: hour!,
		minute: minute!,
		seq: seq!,
		date: `${year}-${month}-${day}`,
	};
}

/** Base 12-digit prefix from a moment-like object (YYYYMMDDHHmm). */
export function baseIdFromMoment(m: {
	format: (fmt: string) => string;
}): string {
	return m.format('YYYYMMDDHHmm');
}

/**
 * Allocate next free id for a given minute base among existing ids.
 * existingIds should be the set of memo ids already in use (canvas node ids).
 */
export function allocateMemoId(base: string, existingIds: Set<string>): string {
	for (let i = 0; i < 10000; i++) {
		const id = base + String(i).padStart(4, '0');
		if (!existingIds.has(id)) return id;
	}
	// Extremely unlikely; fall back with random suffix collision avoidance
	return base + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

/**
 * Convert old callout time + date into a candidate base id (to the minute).
 * date: YYYY-MM-DD, time: HH:mm or HH:mm:ss
 */
export function legacyToBaseId(date: string, time: string): string {
	const [y, mo, d] = date.split('-');
	const parts = time.split(':');
	const hh = (parts[0] ?? '00').padStart(2, '0');
	const mm = (parts[1] ?? '00').padStart(2, '0');
	return `${y}${mo}${d}${hh}${mm}`;
}
