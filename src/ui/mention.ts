import { setIcon, type Editor } from 'obsidian';
import type { Memo } from '../types';
import { parseMemoId } from '../id';

export interface MentionOptions {
	/** Candidate source (the full memo set; archived are excluded here). */
	getMemos: () => Memo[];
	/** The CM editor currently in the host, or null when not ready. */
	getEditor: () => Editor | null;
	/** `@@` token → create a brand-new BLANK memo; the returned ref
	 * replaces the `@@name` token with `[[<file>#<id>|<name>]]`. The typed
	 * name becomes the link's display text only — the new card stays
	 * empty. Absent → `@@` degrades to a plain `@` mention. */
	onCreateMemo?: (
		name: string,
	) => Promise<{ sourceFile: string; id: string } | null>;
}

export const MAX_ITEMS = 20;
/** Poll interval for re-checking the token while the popup is open (ms). */
const WATCH_MS = 100;
/** An `@query` / `@@name` token ending at the caret. `@` may follow ANY
 * character (mid-word mentions are wanted); the `@@` alternation must come
 * first so a double-@ reads as the create token, not an `@` with a query
 * starting at the second @. Query = the non-space, non-@ suffix. */
export const TOKEN_RE = /(@@|@)([^\s@]*)$/u;

/**
 * `@`-mention autocomplete for a grafted CM6 editor. Watches input for an
 * `@query` token at the caret, shows a floating candidate list sorted by edit
 * time (newest first), and on selection inserts `[[<canvas>#<id>|memo]]`.
 *
 * The popup is `position: fixed` on `document.body`, so it is never clipped by
 * the editor's overflow-hidden ancestors (composer box, feed, card).
 */
export class MentionController {
	private popup: HTMLElement | null = null;
	private items: Memo[] = [];
	private selected = 0;
	private tokenFrom: { line: number; ch: number } | null = null;
	private destroyed = false;
	/** Signature of the token currently rendered (`line:start:query`), so the
	 * watch loop can skip re-renders — a re-render would reset `selected` and
	 * fight the user's arrow-key navigation. */
	private lastKey = '';
	private watchTimer: number | null = null;
	/** `@@` create mode: the popup shows a single "create blank memo" row
	 * instead of candidates; Enter/Tab create it. */
	private createMode = false;
	private createQuery = '';
	private creating = false;

	constructor(
		private opts: MentionOptions,
		private anchorEl: HTMLElement,
	) {
		anchorEl.addEventListener('input', this.onInput);
		anchorEl.addEventListener('keydown', this.onKeyDown, true);
		// Close on any scroll (the feed/list moving under a fixed popup would
		// desync it) and on outside interaction.
		document.addEventListener('scroll', this.close, true);
		document.addEventListener('mousedown', this.onDocMouseDown, true);
		window.addEventListener('resize', this.close);
	}

	destroy(): void {
		this.destroyed = true;
		this.anchorEl.removeEventListener('input', this.onInput);
		this.anchorEl.removeEventListener('keydown', this.onKeyDown, true);
		document.removeEventListener('scroll', this.close, true);
		document.removeEventListener('mousedown', this.onDocMouseDown, true);
		window.removeEventListener('resize', this.close);
		this.dismiss();
	}

	private onInput = (): void => {
		window.requestAnimationFrame(() => this.update());
	};

	private onDocMouseDown = (e: MouseEvent): void => {
		if (this.popup && !this.popup.contains(e.target as Node)) this.dismiss();
	};

	private close = (): void => {
		this.dismiss();
	};

	/** Re-read the token at the caret and refresh the candidate list. */
	private update(): void {
		if (this.destroyed) return;
		const editor = this.opts.getEditor();
		if (!editor) {
			this.dismiss();
			return;
		}
		const cur = editor.getCursor();
		const before = editor.getLine(cur.line).slice(0, cur.ch);
		const m = TOKEN_RE.exec(before);
		if (!m) {
			this.dismiss();
			return;
		}
		this.tokenFrom = { line: cur.line, ch: m.index };
		const query = m[2]!;
		this.createMode = m[1] === '@@' && !!this.opts.onCreateMemo;
		this.createQuery = query;
		const key = `${cur.line}:${m.index}:${m[1]}${query}`;
		if (this.popup && key === this.lastKey) return; // token unchanged
		this.lastKey = key;

		if (this.createMode) {
			// Create mode owns the popup alone — no candidate list.
			this.items = [];
			this.selected = 0;
			this.render();
			this.startWatch();
			return;
		}

		const q = query.toLowerCase();

		const memos = this.opts.getMemos().filter((x) => !x.archived);
		memos.sort((a, b) =>
			(b.updatedAt || b.id).localeCompare(a.updatedAt || a.id),
		);
		this.items = (
			q
				? memos.filter(
						(x) =>
							x.content.toLowerCase().includes(q) ||
							x.tags.some((t) => t.includes(q)),
					)
				: memos
		).slice(0, MAX_ITEMS);
		this.selected = 0;
		this.render();
		this.startWatch();
	}

	private render(): void {
		if (!this.popup) {
			this.popup = document.body.createDiv({ cls: 'memos-mention-popup' });
			this.popup.addEventListener('mousedown', (e) => {
				// Keep the editor focused when picking with mouse/touch.
				e.preventDefault();
			});
		}
		this.popup.empty();

		if (this.createMode) {
			// Single action row: Enter/Tab (or click) creates the blank memo.
			const item = this.popup.createDiv({
				cls: 'memos-mention-item memos-mention-create is-selected',
			});
			const ic = item.createSpan({ cls: 'memos-mention-create-icon' });
			setIcon(ic, 'plus');
			item.createSpan({
				cls: 'memos-mention-snippet',
				text: this.createQuery
					? `新建笔记「${this.createQuery}」`
					: '新建空白笔记',
			});
			item.createSpan({ cls: 'memos-mention-time', text: '回车创建' });
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				void this.chooseCreate();
			});
			this.position();
			return;
		}

		if (this.items.length === 0) {
			this.popup.createDiv({ cls: 'memos-mention-empty', text: '无匹配 memo' });
		} else {
			this.items.forEach((memo, i) => {
				const item = this.popup!.createDiv({ cls: 'memos-mention-item' });
				if (i === this.selected) item.addClass('is-selected');
				item.dataset.index = String(i);
				item.createSpan({ cls: 'memos-mention-time', text: chipTime(memo) });
				const snip = chipSnippet(memo.content);
				if (snip) {
					item.createSpan({ cls: 'memos-mention-snippet', text: snip });
				}
				item.addEventListener('mousedown', (e) => {
					e.preventDefault();
					this.choose(i);
				});
			});
		}
		this.position();
	}

	private onKeyDown = (e: KeyboardEvent): void => {
		if (!this.popup || e.isComposing) return;
		if (this.createMode) {
			if (
				(e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) ||
				e.key === 'Tab'
			) {
				e.preventDefault();
				e.stopImmediatePropagation();
				void this.chooseCreate();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopImmediatePropagation();
				this.dismiss();
			}
			return;
		}
		if (this.items.length === 0) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			const d = e.key === 'ArrowDown' ? 1 : -1;
			this.selected =
				(this.selected + d + this.items.length) % this.items.length;
			this.highlight();
		} else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.choose(this.selected);
		} else if (e.key === 'Tab') {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.choose(this.selected);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.dismiss();
		}
	};

	private highlight(): void {
		if (!this.popup) return;
		const els = this.popup.querySelectorAll('.memos-mention-item');
		els.forEach((el, i) =>
			(el as HTMLElement).toggleClass('is-selected', i === this.selected),
		);
		const sel = els[this.selected] as HTMLElement | undefined;
		sel?.scrollIntoView({ block: 'nearest' });
	}

	private choose(index: number): void {
		const memo = this.items[index];
		const from = this.tokenFrom;
		const editor = this.opts.getEditor();
		if (!memo || !from || !editor) {
			this.dismiss();
			return;
		}
		const to = editor.getCursor();
		editor.replaceRange(
			`[[${memo.sourceFile}#${memo.id}|memo]]`,
			from,
			to,
		);
		this.dismiss();
		editor.focus();
	}

	/** `@@` mode: create a blank memo and replace the `@@name` token with
	 * a ref to it. The display name comes from the LIVE buffer at commit
	 * time (the user may have typed more while creation was in flight). */
	private async chooseCreate(): Promise<void> {
		if (this.creating) return;
		const editor = this.opts.getEditor();
		const onCreate = this.opts.onCreateMemo;
		if (!editor || !onCreate) {
			this.dismiss();
			return;
		}
		this.creating = true;
		let created: { sourceFile: string; id: string } | null = null;
		try {
			created = await onCreate(sanitizeName(this.createQuery));
		} finally {
			this.creating = false;
		}
		if (this.destroyed) return;
		if (!created) {
			this.dismiss();
			return;
		}
		// Re-read the token from the buffer: if the caret moved away or the
		// `@@` was edited out during the await, abort without touching text.
		const cur = editor.getCursor();
		const before = editor.getLine(cur.line).slice(0, cur.ch);
		const m = TOKEN_RE.exec(before);
		if (!m || m[1] !== '@@') {
			this.dismiss();
			return;
		}
		const name = sanitizeName(m[2]!);
		editor.replaceRange(
			`[[${created.sourceFile}#${created.id}|${name}]]`,
			{ line: cur.line, ch: m.index },
			cur,
		);
		this.dismiss();
		editor.focus();
	}

	/** Fixed positioning: opens just below the line that contains the `@`
	 * token (from CM6 caret coords), flipping above when there's no room.
	 * Falls back to the whole anchor element when coords are unavailable. */
	private position(): void {
		if (!this.popup) return;
		const c = this.caretCoords();
		const anchor = this.anchorEl.getBoundingClientRect();
		const bottom = c ? c.bottom : anchor.bottom;
		const lineTop = c ? c.top : anchor.top;
		const left0 = c ? c.left : anchor.left;
		const w = Math.max(240, Math.min(320, window.innerWidth - 16));
		this.popup.style.width = `${w}px`;
		const h = this.popup.offsetHeight;
		let top = bottom + 4;
		if (top + h > window.innerHeight - 8) top = lineTop - h - 4;
		if (top < 8) top = Math.max(8, window.innerHeight - h - 8);
		let left = left0;
		if (left + w > window.innerWidth - 8) {
			left = Math.max(8, window.innerWidth - w - 8);
		}
		this.popup.style.top = `${top}px`;
		this.popup.style.left = `${left}px`;
	}

	/** Screen coordinates of the `@` token's position (CM6 coordsAtPos). */
	private caretCoords(): { left: number; top: number; bottom: number } | null {
		const editor = this.opts.getEditor();
		if (!editor || !this.tokenFrom) return null;
		try {
			const cm = (
				editor as Editor & {
					cm?: {
						coordsAtPos?: (pos: number) => {
							left: number;
							top: number;
							bottom: number;
						};
					};
				}
			).cm;
			if (!cm?.coordsAtPos) return null;
			return cm.coordsAtPos(editor.posToOffset(this.tokenFrom));
		} catch {
			return null;
		}
	}

	private dismiss(): void {
		this.stopWatch();
		this.popup?.remove();
		this.popup = null;
		this.items = [];
		this.selected = 0;
		this.tokenFrom = null;
		this.lastKey = '';
		this.createMode = false;
		this.createQuery = '';
	}

	/** Re-check the token on a short interval while the popup is open. The
	 * `input` event alone isn't reliable: mobile CM6 doesn't always emit one
	 * for deletions (IME/composition quirks), and caret moves fire none — so
	 * without this the popup could outlive its `@` token. */
	private startWatch(): void {
		if (this.watchTimer !== null || this.destroyed) return;
		this.watchTimer = window.setInterval(() => this.update(), WATCH_MS);
	}

	private stopWatch(): void {
		if (this.watchTimer === null) return;
		window.clearInterval(this.watchTimer);
		this.watchTimer = null;
	}
}

/** Compact "MM-DD HH:mm" for candidate rows. */
export function chipTime(memo: Memo): string {
	const p = parseMemoId(memo.id);
	if (p) return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
	return memo.updatedAt || memo.id;
}

/** Display name for a created-memo ref: wikilink-breaking characters out,
 * empty falls back to the standard `memo` alias. */
export function sanitizeName(raw: string): string {
	const name = raw.replace(/[\]|[#]/g, '').trim();
	return name || 'memo';
}

/** Plain-text snippet of a memo (markdown/wikilinks stripped, truncated). */
export function chipSnippet(content: string, max = 32): string {
	const t = content
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/\[\[[^\]]*\]\]/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[#>*_`~!]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t) return '';
	return t.length > max ? t.slice(0, max) + '…' : t;
}
