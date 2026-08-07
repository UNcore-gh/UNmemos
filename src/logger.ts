/**
 * Opt-in in-memory debug log for remote troubleshooting.
 *
 * Completely silent when disabled (settings.debugLog is false): nothing
 * is captured, nothing is stored, and each call returns immediately.
 * When enabled, `logger.*` calls — plus global errors hooked in main.ts —
 * append to a capped in-memory ring buffer. The user exports it from the
 * settings tab (clipboard or a vault file) and sends it to the developer.
 * The buffer is never written to disk automatically.
 *
 * Convention for new code: route diagnostics through this module instead
 * of raw console.* so they show up in the exported report. warn/error
 * still mirror to the console regardless of the switch, so local devtools
 * debugging is unchanged.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
	/** Epoch millis of the record. */
	t: number;
	level: LogLevel;
	msg: string;
}

/** Ring buffer cap — enough for a long repro session, tiny in memory. */
const MAX_ENTRIES = 1000;
/** One record never exceeds this; longer payloads get truncated. */
const MAX_MSG = 2000;

const entries: LogEntry[] = [];
let enabled = false;
let envProvider: (() => Record<string, string>) | null = null;

export function isDebugEnabled(): boolean {
	return enabled;
}

/** Number of records currently held (for the settings tab counter). */
export function entryCount(): number {
	return entries.length;
}

/** Snapshot of the buffer (copy — safe for the caller to render). */
export function getEntries(): LogEntry[] {
	return entries.slice();
}

/**
 * Flip the capture switch. Enabling records an env snapshot so the export
 * always carries version/platform context even if nothing else logged;
 * disabling wipes the buffer — off means silent AND empty.
 */
export function setDebugEnabled(value: boolean): void {
	if (value === enabled) return;
	enabled = value;
	if (value) {
		append('info', ['debug logging enabled']);
		if (envProvider) {
			try {
				append('info', ['env', envProvider()]);
			} catch {
				// Env collection must never break the plugin.
			}
		}
	} else {
		entries.length = 0;
	}
}

/** Supplies version/platform/settings context for the enable snapshot
 *  and the exported report. Installed once from main.ts. */
export function setEnvProvider(fn: () => Record<string, string>): void {
	envProvider = fn;
}

// info stays buffer-only (no devtools echo — lifecycle traces would just be
// noise there); warn/error mirror to the console like the raw calls they
// replace, so local debugging is unchanged.
export function info(...parts: unknown[]): void {
	append('info', parts);
}

export function warn(...parts: unknown[]): void {
	console.warn('[Memos]', ...parts);
	append('warn', parts);
}

export function error(...parts: unknown[]): void {
	console.error('[Memos]', ...parts);
	append('error', parts);
}

export function clear(): void {
	entries.length = 0;
}

function append(level: LogLevel, parts: unknown[]): void {
	if (!enabled) return;
	let msg = parts.map(fmt).join(' ');
	if (msg.length > MAX_MSG) msg = `${msg.slice(0, MAX_MSG)}…(truncated)`;
	// Drop consecutive duplicates — a stuck loop must not flush the
	// buffer of its actually-useful history.
	const last = entries[entries.length - 1];
	if (last && last.level === level && last.msg === msg) return;
	if (entries.length >= MAX_ENTRIES) entries.shift();
	entries.push({ t: Date.now(), level, msg });
}

function fmt(v: unknown): string {
	if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

/**
 * Build the shareable report: header with export time, live env context,
 * then the full buffer with timestamps. The caller decides where it goes
 * (clipboard / vault file).
 */
export function buildReport(): string {
	const lines: string[] = [];
	lines.push('=== Memos for Obsidian — debug log ===');
	lines.push(`exported at: ${new Date().toISOString()}`);
	if (envProvider) {
		try {
			for (const [k, v] of Object.entries(envProvider())) {
				lines.push(`${k}: ${v}`);
			}
		} catch {
			// Same as above — env must never break the export.
		}
	}
	lines.push(`entries: ${entries.length}`);
	lines.push('--------------------------------------');
	for (const e of entries) {
		lines.push(
			`[${new Date(e.t).toISOString()}] [${e.level}] ${e.msg}`,
		);
	}
	return lines.join('\n');
}
