import { type Editor } from 'obsidian';

export interface TagSuggestOptions {
	/** Returns a map of tag → usage count for the current frame. */
	getTagCounts: () => Map<string, number>;
	/** The CM editor currently in the host, or null when not ready. */
	getEditor: () => Editor | null;
}

export const MAX_TAG_ITEMS = 20;
const WATCH_MS = 100;

/**
 * `#`-tag autocomplete for a grafted CM6 editor. Watches input for a `#query`
 * token at the caret, shows a floating candidate list sorted by usage count
 * (descending, then alphabetically), and on selection inserts `#tagName`.
 */
export class TagSuggestController {
	private popup: HTMLElement | null = null;
	private items: Array<{ tag: string; count: number }> = [];
	private selected = 0;
	private tokenFrom: { line: number; ch: number } | null = null;
	private destroyed = false;
	private lastKey = '';
	private watchTimer: number | null = null;

	constructor(
		private opts: TagSuggestOptions,
		private anchorEl: HTMLElement,
	) {
		anchorEl.addEventListener('input', this.onInput);
		anchorEl.addEventListener('keydown', this.onKeyDown, true);
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

	/** Read the `#` token at the caret. Matches `#` only when it follows a
	 * whitespace or start-of-line, so mid-word `#` (like in a URL or code)
	 * does not trigger the popup. The query is the non-space suffix. */
	private update(): void {
		if (this.destroyed) return;
		const editor = this.opts.getEditor();
		if (!editor) {
			this.dismiss();
			return;
		}
		const cur = editor.getCursor();
		const before = editor.getLine(cur.line).slice(0, cur.ch);
		// Match `#` preceded by whitespace or start of line, followed by
		// non-whitespace chars (the query). Previous tag-suggest match
		// `#tag` already written — must not re-trigger on the same `#`.
		const m = /(^|\s)(#)([^\s#]*)$/u.exec(before);
		if (!m) {
			this.dismiss();
			return;
		}
		// The token starts at the `#` character
		const hashPos = m.index + m[1]!.length;
		this.tokenFrom = { line: cur.line, ch: hashPos };
		const query = m[3]!;
		const key = `${cur.line}:${hashPos}:${query}`;
		if (this.popup && key === this.lastKey) return;
		this.lastKey = key;

		const q = query.toLowerCase();
		const tagCounts = this.opts.getTagCounts();

		// Build sorted list: all tags, sorted by count desc, then alpha
		const all = [...tagCounts.entries()]
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

		this.items = q
			? all.filter((x) => x.tag.toLowerCase().includes(q))
			: all;

		// Prefix matches first, then substring
		if (q) {
			this.items.sort((a, b) => {
				const al = a.tag.toLowerCase();
				const bl = b.tag.toLowerCase();
				const ap = al.startsWith(q) ? 0 : 1;
				const bp = bl.startsWith(q) ? 0 : 1;
				return ap - bp || b.count - a.count || a.tag.localeCompare(b.tag);
			});
		}

		this.items = this.items.slice(0, MAX_TAG_ITEMS);
		this.selected = 0;
		this.render();
		this.startWatch();
	}

	private render(): void {
		if (!this.popup) {
			this.popup = document.body.createDiv({
				cls: 'memos-tag-suggest-popup',
			});
			this.popup.addEventListener('mousedown', (e) => {
				e.preventDefault();
			});
		}
		this.popup.empty();

		if (this.items.length === 0) {
			this.popup.createDiv({
				cls: 'memos-tag-suggest-empty',
				text: '无匹配标签',
			});
		} else {
			for (let i = 0; i < this.items.length; i++) {
				const { tag, count } = this.items[i]!;
				const item = this.popup.createDiv({
					cls: 'memos-tag-suggest-item' + (i === this.selected ? ' is-selected' : ''),
				});
				item.dataset.index = String(i);
				item.createSpan({
					cls: 'memos-tag-suggest-tag',
					text: `#${tag}`,
				});
				item.createSpan({
					cls: 'memos-tag-suggest-count',
					text: String(count),
				});
				item.addEventListener('mousedown', (e) => {
					e.preventDefault();
					this.choose(i);
				});
			}
		}
		this.position();
	}

	private onKeyDown = (e: KeyboardEvent): void => {
		if (!this.popup || e.isComposing) return;
		if (this.items.length === 0) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			const d = e.key === 'ArrowDown' ? 1 : -1;
			this.selected = (this.selected + d + this.items.length) % this.items.length;
			this.highlight();
		} else if (
			e.key === 'Enter' &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.shiftKey
		) {
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
		const els = this.popup.querySelectorAll('.memos-tag-suggest-item');
		els.forEach((el, i) =>
			(el as HTMLElement).toggleClass('is-selected', i === this.selected),
		);
		const sel = els[this.selected] as HTMLElement | undefined;
		sel?.scrollIntoView({ block: 'nearest' });
	}

	private choose(index: number): void {
		const item = this.items[index];
		const from = this.tokenFrom;
		const editor = this.opts.getEditor();
		if (!item || !from || !editor) {
			this.dismiss();
			return;
		}
		const to = editor.getCursor();
		editor.replaceRange(`#${item.tag} `, from, to);
		this.dismiss();
		editor.focus();
	}

	/** Fixed positioning: opens just below the line that contains the `#`
	 * token, flipping above when there's no room. */
	private position(): void {
		if (!this.popup) return;
		const c = this.caretCoords();
		const anchor = this.anchorEl.getBoundingClientRect();
		const bottom = c ? c.bottom : anchor.bottom;
		const lineTop = c ? c.top : anchor.top;
		const left0 = c ? c.left : anchor.left;
		const w = Math.max(200, Math.min(280, window.innerWidth - 16));
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

	/** Screen coordinates of the `#` token's position (CM6 coordsAtPos). */
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
	}

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