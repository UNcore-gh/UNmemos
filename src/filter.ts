import type { Memo } from './types';

/* flomo-style filter query engine.
 *
 * A query is whitespace-separated tokens combined with the boolean
 * connectives AND / OR / NOT (aliases: && || !, 与/且 或 非). Adjacent
 * conditions with no explicit connective are AND-ed, flomo-style:
 *   "#work 本周 方案"  ≡  "#work AND 本周 AND 方案"
 * Precedence: NOT > AND > OR. Dangling connectives are silently dropped,
 * so a query never fails to parse — worst case it degrades to a plain
 * keyword search over the whole string.
 *
 * Condition dimensions:
 *   #tag          hierarchical prefix match (#work matches #work/todo)
 *   2024 / 2024-6 / 2024-6-15   bare date / month / year ranges
 *   今天 昨天 前天 本周 上周 本月 上月 今年 去年 最近N天 (+ English aliases)
 *   <word>        case-insensitive keyword over content, tags and comments
 */

/** Structural subset of moment.js (Obsidian exposes window.moment). */
export interface MomentLike {
	format(fmt: string): string;
	startOf(unit: string): MomentLike;
	endOf(unit: string): MomentLike;
	add(n: number, unit: string): MomentLike;
	subtract(n: number, unit: string): MomentLike;
	isoWeekday(n: number): MomentLike;
	isValid(): boolean;
	clone(): MomentLike;
}

export type Cond =
	| { kind: 'tag'; tag: string }
	| { kind: 'time'; start: string; end: string; label: string }
	| { kind: 'keyword'; text: string };

export type FilterNode =
	| { type: 'cond'; cond: Cond }
	| { type: 'not'; child: FilterNode }
	| { type: 'and'; children: FilterNode[] }
	| { type: 'or'; children: FilterNode[] };

export interface FilterToken {
	/** Original text as typed (including punctuation), for offset splicing. */
	raw: string;
	kind: 'tag' | 'time' | 'keyword' | 'op';
	op?: 'AND' | 'OR' | 'NOT';
	/** Display label: "#work", "本周", "2024-06", "AND"… */
	label: string;
	/** Inclusive character offsets into the source query. */
	start: number;
	end: number;
	/** false for e.g. impossible dates (2024-13-40), rendered faded. */
	valid: boolean;
	/** Normalized tag (kind === 'tag'). */
	tag?: string;
	/** Inclusive day range, YYYY-MM-DD (kind === 'time'). */
	dayStart?: string;
	dayEnd?: string;
}

export interface ParsedFilter {
	ast: FilterNode | null;
	tokens: FilterToken[];
}

/* ── Connective aliases ─────────────────────────────────────── */

const AND_ALIASES = new Set(['and', '&&', '与', '且']);
const OR_ALIASES = new Set(['or', '||', '或']);
const NOT_ALIASES = new Set(['not', '!', '非']);

/* ── Time keywords ──────────────────────────────────────────── */

const DAY = 'YYYY-MM-DD';

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
	// Day 0 of month `month + 1` is the last day of `month`. Local-time
	// Date arithmetic is safe here: we only read getDate().
	return new Date(year, month, 0).getDate();
}

/** Resolve a time keyword to an inclusive [start, end] day range. */
export function resolveTimeKeyword(
	alias: string,
	now: MomentLike,
): { start: string; end: string } | null {
	const key = alias.toLowerCase();
	const dayAt = (offsetDays: number): { start: string; end: string } => {
		const d = now.clone().add(offsetDays, 'days').startOf('day').format(DAY);
		return { start: d, end: d };
	};
	switch (key) {
		case '今天':
		case 'today':
			return dayAt(0);
		case '昨天':
		case 'yesterday':
			return dayAt(-1);
		case '前天':
			return dayAt(-2);
		case '本周':
		case '这周':
		case 'this-week':
			// moment's locale week may start on Sunday — force ISO Monday.
			return {
				start: now.clone().isoWeekday(1).startOf('day').format(DAY),
				end: now.clone().isoWeekday(7).startOf('day').format(DAY),
			};
		case '上周':
		case 'last-week':
			return {
				start: now.clone().subtract(1, 'weeks').isoWeekday(1).startOf('day').format(DAY),
				end: now.clone().subtract(1, 'weeks').isoWeekday(7).startOf('day').format(DAY),
			};
		case '本月':
		case '这个月':
		case 'this-month':
			return {
				start: now.clone().startOf('month').format(DAY),
				end: now.clone().endOf('month').format(DAY),
			};
		case '上月':
		case '上个月':
		case 'last-month':
			return {
				start: now.clone().subtract(1, 'months').startOf('month').format(DAY),
				end: now.clone().subtract(1, 'months').endOf('month').format(DAY),
			};
		case '今年':
		case 'this-year':
			return {
				start: now.clone().startOf('year').format(DAY),
				end: now.clone().endOf('year').format(DAY),
			};
		case '去年':
		case 'last-year':
			return {
				start: now.clone().subtract(1, 'years').startOf('year').format(DAY),
				end: now.clone().subtract(1, 'years').endOf('year').format(DAY),
			};
		default: {
			const recent = /^最近(\d{1,4})天$/.exec(key);
			if (recent) {
				const n = Math.max(1, Number.parseInt(recent[1]!, 10));
				return {
					start: now.clone().subtract(n - 1, 'days').startOf('day').format(DAY),
					end: now.clone().startOf('day').format(DAY),
				};
			}
			return null;
		}
	}
}

/** Parse a bare date token (YYYY, YYYY-M[M], YYYY-M[M]-D[D]; "/" ok too). */
function resolveBareDate(text: string): { start: string; end: string; label: string } | null {
	const m = /^(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?$/.exec(text);
	if (!m) return null;
	const year = Number.parseInt(m[1]!, 10);
	if (year < 1000 || year > 9999) return null;
	if (m[2] === undefined) {
		return { start: `${year}-01-01`, end: `${year}-12-31`, label: `${year}` };
	}
	const month = Number.parseInt(m[2], 10);
	if (month < 1 || month > 12) return null;
	if (m[3] === undefined) {
		const last = daysInMonth(year, month);
		return {
			start: `${year}-${pad2(month)}-01`,
			end: `${year}-${pad2(month)}-${pad2(last)}`,
			label: `${year}-${pad2(month)}`,
		};
	}
	const day = Number.parseInt(m[3], 10);
	if (day < 1 || day > daysInMonth(year, month)) return null;
	const date = `${year}-${pad2(month)}-${pad2(day)}`;
	return { start: date, end: date, label: date };
}

/** Strict full date YYYY-M[M]-D[D] ("/" ok too) → zero-padded YYYY-MM-DD,
 * or null when shaped but impossible (2024-13-40). */
function resolveFullDate(text: string): string | null {
	const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
	if (!m) return null;
	const year = Number.parseInt(m[1]!, 10);
	const month = Number.parseInt(m[2]!, 10);
	const day = Number.parseInt(m[3]!, 10);
	if (month < 1 || month > 12) return null;
	if (day < 1 || day > daysInMonth(year, month)) return null;
	return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Parse a bare date RANGE token: YYYY-M[M]-D[D]..YYYY-M[M]-D[D] — a single
 * whitespace-free token; inverted bounds are swapped. Full dates on both
 * sides only: bare-year/month ranges ("2024..2025") would be ambiguous. */
function resolveBareDateRange(text: string): { start: string; end: string; label: string } | null {
	const parts = text.split('..');
	if (parts.length !== 2) return null;
	const a = resolveFullDate(parts[0]!);
	const b = resolveFullDate(parts[1]!);
	if (!a || !b) return null;
	const start = a <= b ? a : b;
	const end = a <= b ? b : a;
	return { start, end, label: `${start}~${end}` };
}

/* ── Tokenizer ──────────────────────────────────────────────── */

const TRAILING_PUNCT = /[，。；：、,.:;!?…]+$/;
// Obsidian tag charset (see parser.ts TAG_RE), minus the leading "#".
const TAG_BODY_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_\-/·]*$/u;

function normalizeText(raw: string): string {
	// Fullwidth "＃" → "#", then drop one trailing punctuation layer
	// ("#work，" → "#work"). Token offsets keep the punctuation so that
	// removing the chip splices it out of the query too.
	return raw.replace(/＃/g, '#').replace(TRAILING_PUNCT, '');
}

function classifyToken(
	raw: string,
	start: number,
	end: number,
	now: MomentLike | null,
): FilterToken {
	const lower = raw.toLowerCase();
	if (AND_ALIASES.has(lower)) return { raw, start, end, kind: 'op', op: 'AND', label: 'AND', valid: true };
	if (OR_ALIASES.has(lower)) return { raw, start, end, kind: 'op', op: 'OR', label: 'OR', valid: true };
	if (NOT_ALIASES.has(lower)) return { raw, start, end, kind: 'op', op: 'NOT', label: 'NOT', valid: true };

	const text = normalizeText(raw);

	if (text.startsWith('#') && text.length > 1) {
		const tag = text.slice(1).toLowerCase();
		// Obsidian requires at least one non-digit in a tag; a pure-number
		// "tag" cannot exist, so show it as an invalid (faded) keyword.
		if (TAG_BODY_RE.test(tag) && !/^\d+$/.test(tag)) {
			return { raw, start, end, kind: 'tag', tag, label: `#${tag}`, valid: true };
		}
		return { raw, start, end, kind: 'keyword', label: raw, valid: false };
	}

	const dateRange = resolveBareDateRange(text);
	if (dateRange) {
		return {
			raw, start, end,
			kind: 'time',
			label: dateRange.label,
			dayStart: dateRange.start,
			dayEnd: dateRange.end,
			valid: true,
		};
	}

	const date = resolveBareDate(text);
	if (date) {
		return {
			raw, start, end,
			kind: 'time',
			label: date.label,
			dayStart: date.start,
			dayEnd: date.end,
			valid: true,
		};
	}
	// Shaped like a date but impossible (2024-13-40), or a range whose right
	// side is garbage (2024-01-01..x): visible but faded.
	if (
		/^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/.test(text) ||
		/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\.\.\S+$/.test(text)
	) {
		return { raw, start, end, kind: 'keyword', label: raw, valid: false };
	}

	if (now !== null) {
		const range = resolveTimeKeyword(text, now);
		if (range) {
			return {
				raw, start, end,
				kind: 'time',
				label: text,
				dayStart: range.start,
				dayEnd: range.end,
				valid: true,
			};
		}
	}

	return { raw, start, end, kind: 'keyword', label: raw, valid: true };
}

/* ── Parser (recursive descent, precedence NOT > AND > OR) ──── */

type Op = 'AND' | 'OR' | 'NOT';

class Parser {
	private pos = 0;
	constructor(private readonly tokens: FilterToken[]) {}

	parse(): FilterNode | null {
		return this.parseOr();
	}

	private peek(): FilterToken | undefined {
		return this.tokens[this.pos];
	}

	private peekOp(): Op | null {
		const t = this.peek();
		return t && t.kind === 'op' && t.op ? t.op : null;
	}

	private advance(): void {
		this.pos++;
	}

	private parseOr(): FilterNode | null {
		const children: FilterNode[] = [];
		const first = this.parseAnd();
		if (first) children.push(first);
		while (this.peekOp() === 'OR') {
			this.advance();
			const next = this.parseAnd();
			if (!next) break; // dangling OR at end → ignore
			children.push(next);
		}
		return join('or', children);
	}

	private parseAnd(): FilterNode | null {
		const children: FilterNode[] = [];
		const first = this.parseUnary();
		if (first) children.push(first);
		for (;;) {
			const op = this.peekOp();
			if (op === 'AND' || op === 'NOT') {
				// Explicit AND, or implicit AND before a NOT ("a NOT b" ≡ a AND (NOT b)).
				if (op === 'AND') this.advance();
				const next = this.parseUnary();
				if (!next) break; // dangling AND / NOT
				children.push(next);
			} else if (op === null && this.peek()) {
				// Implicit AND between adjacent conditions.
				const next = this.parseUnary();
				if (!next) break;
				children.push(next);
			} else {
				break; // OR belongs to the outer level, or input exhausted
			}
		}
		return join('and', children);
	}

	private parseUnary(): FilterNode | null {
		if (this.peekOp() === 'NOT') {
			this.advance();
			const child = this.parseUnary();
			if (!child) return null; // dangling NOT
			return { type: 'not', child };
		}
		const t = this.peek();
		if (!t || t.kind === 'op') return null;
		this.advance();
		return { type: 'cond', cond: tokenToCond(t) };
	}
}

function join(type: 'and' | 'or', children: FilterNode[]): FilterNode | null {
	if (children.length === 0) return null;
	if (children.length === 1) return children[0]!;
	// Flatten nested same-type nodes.
	const flat: FilterNode[] = [];
	for (const c of children) {
		if (c.type === type) flat.push(...c.children);
		else flat.push(c);
	}
	return { type, children: flat };
}

function tokenToCond(t: FilterToken): Cond {
	switch (t.kind) {
		case 'tag':
			return { kind: 'tag', tag: t.tag ?? t.label.slice(1) };
		case 'time':
			if (t.dayStart && t.dayEnd) {
				return { kind: 'time', start: t.dayStart, end: t.dayEnd, label: t.label };
			}
			return { kind: 'keyword', text: t.raw.toLowerCase() };
		default:
			return { kind: 'keyword', text: t.raw.toLowerCase() };
	}
}

/* ── Public API ─────────────────────────────────────────────── */

function defaultNow(): MomentLike | null {
	const w = window as unknown as { moment?: (inp?: unknown, fmt?: string) => MomentLike };
	if (typeof w.moment === 'function') {
		const m = w.moment();
		return m.isValid() ? m : null;
	}
	return null;
}

/**
 * Parse a filter query. NEVER throws: any internal failure degrades the
 * whole query into a single keyword condition.
 */
export function parseFilter(query: string, now?: MomentLike | null): ParsedFilter {
	const trimmed = query.trim();
	if (!trimmed) return { ast: null, tokens: [] };
	try {
		const momentNow = now === undefined ? defaultNow() : now;
		const tokens: FilterToken[] = [];
		const re = /\S+/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(query)) !== null) {
			tokens.push(classifyToken(m[0], m.index, m.index + m[0].length, momentNow));
		}
		const ast = new Parser(tokens).parse();
		return { ast, tokens };
	} catch {
		const idx = query.indexOf(trimmed);
		const token: FilterToken = {
			raw: trimmed,
			kind: 'keyword',
			label: trimmed,
			start: idx >= 0 ? idx : 0,
			end: idx >= 0 ? idx + trimmed.length : trimmed.length,
			valid: true,
		};
		return {
			ast: { type: 'cond', cond: { kind: 'keyword', text: trimmed.toLowerCase() } },
			tokens: [token],
		};
	}
}

/** Evaluate a parsed AST against a memo. */
export function evalFilter(node: FilterNode, memo: Memo): boolean {
	switch (node.type) {
		case 'and':
			return node.children.every((c) => evalFilter(c, memo));
		case 'or':
			return node.children.some((c) => evalFilter(c, memo));
		case 'not':
			return !evalFilter(node.child, memo);
		case 'cond':
			return evalCond(node.cond, memo);
		default:
			return true; // unreachable; keep the whole feed rather than crash
	}
}

function evalCond(cond: Cond, memo: Memo): boolean {
	switch (cond.kind) {
		case 'tag': {
			const tag = cond.tag;
			return memo.tags.some((t) => t === tag || t.startsWith(tag + '/'));
		}
		case 'time':
			// memo.date is zero-padded YYYY-MM-DD → lexicographic compare is safe.
			return memo.date >= cond.start && memo.date <= cond.end;
		case 'keyword': {
			const q = cond.text;
			return (
				memo.content.toLowerCase().includes(q) ||
				memo.tags.some((t) => t.includes(q)) ||
				memo.comments.some((c) => c.content.toLowerCase().includes(q))
			);
		}
		default:
			return true;
	}
}

/** Splice a token (by its offsets) out of the query, collapsing spaces. */
export function removeToken(query: string, token: FilterToken): string {
	return (query.slice(0, token.start) + query.slice(token.end)).replace(/\s{2,}/g, ' ').trim();
}
