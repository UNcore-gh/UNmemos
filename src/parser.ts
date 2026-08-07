import type { Editor } from 'obsidian';
import type { Memo, MemoMeta } from './types';
import { MEMO_ID_RE, parseMemoId } from './id';

/* ------------------------------------------------------------------ *
 * Structural regexes for the legacy markdown storage format.
 * Kept for one-shot migration to canvas (parseMarkdownMemos).
 * ------------------------------------------------------------------ */

/** New markdown format: # MM */
const MONTH_HEADING_RE = /^# (\d{2})\s*$/;
/** New markdown format: ## YYYYMMDDHHmmSSSS */
const MEMO_HEADING_RE = /^## (\d{16})\s*$/;
/** Legacy date heading: # YYYY-MM-DD */
const LEGACY_DATE_HEADING_RE = /^# (\d{4}-\d{2}-\d{2})\s*$/;
/** Legacy callout: > [!memo] HH:mm:ss ... */
const LEGACY_MEMO_RE = /^> \[!memo\]\s+(\d{2}:\d{2}(?::\d{2})?)\s*(.*)$/i;
const COMMENT_RE =
	/^> \[!memo-comment\]\s+(\d{2}:\d{2}(?::\d{2})?)\s*(?:<!--\s*id:(\S+)\s*-->)?\s*$/i;
const TAG_RE = /#([\p{L}\p{N}_/][\p{L}\p{N}_\-/·]*)/gu;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const META_RE = /<!--\s*(.*?)\s*-->/g;

/* ------------------------------------------------------------------ *
 * Canvas storage format (live).
 *
 * Each memo is one canvas text node whose id is the 16-digit timestamp.
 * Node text = <content>\n<!-- memos-meta | updated: ... | pinned | starred | archived -->
 * The meta marker line is ours; user content never contains it, so we can
 * split content from meta unambiguously by scanning for the last marker line.
 * ------------------------------------------------------------------ */

const CANVAS_META_RE = /^<!--\s*memos-meta\b.*-->\s*$/;

interface CanvasNodeRaw {
	id?: unknown;
	type?: unknown;
	text?: unknown;
	[key: string]: unknown;
}
interface CanvasRaw {
	nodes?: CanvasNodeRaw[];
	[key: string]: unknown;
}

/** Split a canvas node's text into logical content + the trailing meta line. */
export function splitNodeText(text: string): {
	content: string;
	metaLine: string;
} {
	const lines = text.split('\n');
	// Meta is written as the last line; scan from the end for robustness.
	for (let i = lines.length - 1; i >= 0; i--) {
		if (CANVAS_META_RE.test(lines[i]!)) {
			const metaLine = lines[i]!;
			const content = lines
				.slice(0, i)
				.join('\n')
				.replace(/\s+$/, '');
			return { content, metaLine };
		}
	}
	return { content: text.replace(/\s+$/, ''), metaLine: '' };
}

/** Parse a `<!-- memos-meta | ... -->` line into meta flags. */
export function parseCanvasMeta(metaLine: string): MemoMeta {
	const meta: MemoMeta = {
		id: null,
		updatedAt: null,
		pinned: false,
		starred: false,
		archived: false,
		archivedAt: null,
	};
	if (!metaLine) return meta;
	const inner = metaLine.replace(/^<!--/, '').replace(/-->$/, '');
	for (const raw of inner.split('|')) {
		const tok = raw.trim();
		if (tok.startsWith('memos-meta')) continue;
		if (tok.startsWith('updated:')) meta.updatedAt = tok.substring(8).trim();
		else if (tok === 'pinned') meta.pinned = true;
		else if (tok === 'starred') meta.starred = true;
		else if (tok === 'archived') meta.archived = true;
		else if (tok.startsWith('archivedAt:')) {
			meta.archivedAt = tok.substring(11).trim();
		}
	}
	return meta;
}

/** Parse a `.canvas` file into memos. Only timestamp-id text nodes count. */
export function parseCanvasMemos(content: string, sourceFile: string): Memo[] {
	let data: CanvasRaw;
	try {
		data = JSON.parse(content) as CanvasRaw;
	} catch {
		return [];
	}
	if (!data || typeof data !== 'object') return [];
	const nodes = Array.isArray(data.nodes) ? data.nodes : [];
	const memos: Memo[] = [];

	for (const node of nodes) {
		if (!node || node.type !== 'text') continue;
		const id = typeof node.id === 'string' ? node.id : '';
		if (!MEMO_ID_RE.test(id)) continue;

		const text = typeof node.text === 'string' ? node.text : '';
		const { content: raw, metaLine } = splitNodeText(text);
		const meta = parseCanvasMeta(metaLine);

		if (!raw.trim() && !metaLine && !meta.pinned && !meta.archived) continue;

		const parsed = parseMemoId(id);
		memos.push({
			id,
			date: parsed?.date ?? '',
			month: parsed?.month ?? '',
			time: id,
			content: raw,
			updatedAt:
				meta.updatedAt ||
				(parsed ? `${parsed.date} ${parsed.hour}:${parsed.minute}:00` : ''),
			sourceFile,
			lineStart: 0,
			pinned: meta.pinned,
			starred: meta.starred,
			archived: meta.archived,
			archivedAt: meta.archivedAt ?? undefined,
			tags: extractTags(raw),
			links: extractLinks(raw),
			reactions: [],
			comments: [],
		});
	}
	return memos;
}

/* ------------------------------------------------------------------ *
 * Legacy markdown parser — used only by the one-shot canvas migration.
 * Supports both heading format and legacy callout format.
 * ------------------------------------------------------------------ */

export function parseMarkdownMemos(
	content: string,
	sourceFile: string,
): Memo[] {
	const lines = content.split('\n');
	const hasNew = lines.some((l) => MEMO_HEADING_RE.test(l));
	const hasLegacy = lines.some((l) => LEGACY_MEMO_RE.test(l));

	if (hasNew) return parseHeadingFormat(lines, sourceFile);
	if (hasLegacy) return parseLegacyCallout(lines, sourceFile);
	return parseHeadingFormat(lines, sourceFile);
}

function parseHeadingFormat(lines: string[], sourceFile: string): Memo[] {
	const memos: Memo[] = [];
	let currentMonth = '';
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;
		const monthMatch = MONTH_HEADING_RE.exec(line);
		if (monthMatch) {
			currentMonth = monthMatch[1]!;
			i++;
			continue;
		}

		const legacyDate = LEGACY_DATE_HEADING_RE.exec(line);
		if (legacyDate) {
			currentMonth = legacyDate[1]!.slice(5, 7);
			i++;
			continue;
		}

		const memoMatch = MEMO_HEADING_RE.exec(line);
		if (memoMatch) {
			const id = memoMatch[1]!;
			const parsed = parseMemoId(id);
			const start = i;
			i++;

			const metaLines: string[] = [];
			while (i < lines.length) {
				const l = lines[i]!;
				if (/^\s*<!--.*-->\s*$/.test(l)) {
					metaLines.push(l);
					i++;
				} else if (l.trim() === '' && metaLines.length > 0) {
					i++;
					break;
				} else {
					break;
				}
			}

			const contentLines: string[] = [];
			while (i < lines.length) {
				const l = lines[i]!;
				if (
					MEMO_HEADING_RE.test(l) ||
					MONTH_HEADING_RE.test(l) ||
					LEGACY_DATE_HEADING_RE.test(l)
				) {
					break;
				}
				if (COMMENT_RE.test(l)) break;
				contentLines.push(l);
				i++;
			}

			while (
				contentLines.length > 0 &&
				contentLines[contentLines.length - 1]!.trim() === ''
			) {
				contentLines.pop();
			}
			while (contentLines.length > 0 && contentLines[0]!.trim() === '') {
				contentLines.shift();
			}

			const meta = parseMeta(metaLines.join(' '));
			const content = contentLines.join('\n');
			const date = parsed?.date ?? '';
			const month = parsed?.month ?? currentMonth;

			if (!content.trim() && !meta.pinned && !meta.archived) {
				continue;
			}

			memos.push({
				id,
				date,
				month,
				time: id,
				content,
				updatedAt:
					meta.updatedAt ||
					(parsed
						? `${parsed.date} ${parsed.hour}:${parsed.minute}:00`
						: ''),
				sourceFile,
				lineStart: start,
				lineEnd: i - 1,
				pinned: meta.pinned,
				starred: meta.starred,
				archived: meta.archived,
				tags: extractTags(content),
				links: extractLinks(content),
				reactions: [],
				comments: [],
			});
			continue;
		}

		const commentMatch = COMMENT_RE.exec(line);
		if (commentMatch) {
			const body = readCalloutBody(lines, i + 1);
			i += body.length + 1;
			continue;
		}

		i++;
	}

	return memos;
}

/** Legacy callout parser — used for one-shot migration. */
function parseLegacyCallout(lines: string[], sourceFile: string): Memo[] {
	const memos: Memo[] = [];
	let date = '';
	let state: 0 | 1 | 2 = 0;
	let current: Partial<Memo> | null = null;
	let body: string[] = [];

	const flush = () => {
		if (!current) return;
		const content = body.join('\n').trim();
		if (!content) {
			current = null;
			body = [];
			return;
		}
		const memo = current as Memo;
		memo.content = content;
		memo.tags = extractTags(content);
		memo.links = extractLinks(content);
		memo.lineEnd = memo.lineStart + body.length;
		memos.push(memo);
		current = null;
		body = [];
	};

	for (let c = 0; c < lines.length; c++) {
		const p = lines[c]!;
		if (state === 0 || state === 1) {
			const d = LEGACY_DATE_HEADING_RE.exec(p);
			if (d) {
				date = d[1]!;
				state = 1;
				continue;
			}
			const v = LEGACY_MEMO_RE.exec(p);
			if (v) {
				flush();
				const meta = parseMeta(v[2] || '');
				const time = normalizeTime(v[1]!);
				current = {
					id: meta.id || hashId(date, time, c),
					date,
					month: date.slice(5, 7),
					time,
					updatedAt: meta.updatedAt || `${date} ${time}`,
					sourceFile,
					lineStart: c,
					pinned: meta.pinned,
					starred: meta.starred,
					archived: meta.archived,
					reactions: [],
					comments: [],
					tags: [],
					links: [],
					content: '',
				};
				body = [];
				state = 2;
				continue;
			}
			if (p.trim() !== '') state = 0;
			continue;
		}
		// state === 2 collecting callout body
		if (p.startsWith('>')) {
			body.push(
				p.startsWith('> ') ? p.substring(2) : p.substring(1).trimStart(),
			);
		} else {
			flush();
			state = 0;
			c--; // reprocess this line
		}
	}
	flush();
	return memos;
}

export function parseMeta(text: string): MemoMeta {
	let id: string | null = null;
	let updatedAt: string | null = null;
	let pinned = false;
	let archived = false;
	META_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = META_RE.exec(text)) !== null) {
		const o = m[1]!.trim();
		if (o.startsWith('id:')) id = o.substring(3).trim();
		else if (o.startsWith('updated:')) updatedAt = o.substring(8).trim();
		else if (o === 'pinned') pinned = true;
		else if (o === 'archived') archived = true;
	}
	// Legacy callout/heading storage predates the star flag and never carried
	// an archive timestamp — starred is always false, and the missing
	// archivedAt excludes those memos from auto-deletion by design.
	return {
		id,
		updatedAt,
		pinned,
		starred: false,
		archived,
		archivedAt: null,
	};
}

function readCalloutBody(lines: string[], start: number): string[] {
	const out: string[] = [];
	for (let i = start; i < lines.length && lines[i]!.startsWith('>'); i++) {
		const p = lines[i]!;
		out.push(p.startsWith('> ') ? p.substring(2) : p.substring(1).trimStart());
	}
	return out;
}

export function extractTags(content: string): string[] {
	const tags: string[] = [];
	const lines = content.split('\n');
	let inCode = false;
	for (const line of lines) {
		if (line.trim().startsWith('```')) inCode = !inCode;
		if (inCode) continue;
		// Tags only live in plain prose. Strip wikilinks/embeds first — their
		// `#sub-path` is a link target, not a tag (this is what kept memo-ref
		// links like `[[….canvas#2026072815560000|memo]]` from leaking the
		// timestamp id into the tag list) — then markdown link URLs and inline
		// code, neither of which Obsidian counts as taggable text either.
		const text = line
			.replace(/\[\[[^\]]*\]\]/g, ' ')
			.replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
			.replace(/`[^`]*`/g, ' ');
		TAG_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = TAG_RE.exec(text)) !== null) {
			const tag = m[1]!.toLowerCase();
			// Obsidian requires at least one non-digit in a tag; a pure-number
			// match is an id/anchor, never a tag.
			if (/^\d+$/.test(tag)) continue;
			tags.push(tag);
		}
	}
	return [...new Set(tags)];
}

export function extractLinks(content: string): string[] {
	const links: string[] = [];
	WIKILINK_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = WIKILINK_RE.exec(content)) !== null) {
		links.push(m[1]!.trim());
	}
	return [...new Set(links)];
}

/**
 * If a wikilink target (as returned by extractLinks) points at a canvas memo
 * node — e.g. `Memos/2026.canvas#2026072815560000` — return the memo id, else
 * null. Regular note links and heading/block links never match.
 */
export function memoRefId(link: string): string | null {
	const frag = link.split('#').pop() ?? '';
	return MEMO_ID_RE.test(frag) ? frag : null;
}

/**
 * When the caret sits INSIDE a memo wikilink on the current line, or right
 * at either edge of one (光标在引用旁边/内部), return the referenced memo
 * id — used by the Shift+Enter "jump into the referenced memo's editor"
 * shortcut. Null when the caret touches no memo ref.
 */
export function refIdAtCursor(editor: Editor): string | null {
	const cur = editor.getCursor();
	const line = editor.getLine(cur.line);
	const re = /\[\[([^\]]+)\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line)) !== null) {
		const start = m.index;
		const end = m.index + m[0].length;
		if (cur.ch >= start && cur.ch <= end) {
			const id = memoRefId(m[1]!);
			if (id) return id;
		}
	}
	return null;
}

function normalizeTime(t: string): string {
	return t.length === 5 ? t + ':00' : t;
}

function hashId(date: string, time: string, line: number, suffix = ''): string {
	const s = `${date}T${time}${suffix}L${line}`;
	let n = 0;
	for (let i = 0; i < s.length; i++) n = ((n << 5) - n + s.charCodeAt(i)) | 0;
	return Math.abs(n).toString(16).padStart(8, '0');
}

export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TAG_BOUNDARY = '\\p{L}\\p{N}_\\-\\u00B7';

export function renameTagInContent(
	content: string,
	from: string,
	to: string,
): string {
	const re = new RegExp(`#${escapeRegExp(from)}(?![${TAG_BOUNDARY}])`, 'gu');
	return content.replace(re, `#${to}`);
}

export function removeTagFromContent(content: string, tag: string): string {
	const re = new RegExp(
		`[ \\t]?#${escapeRegExp(tag)}(?![${TAG_BOUNDARY}/])`,
		'gu',
	);
	return content.replace(re, '');
}
