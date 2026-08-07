import {
	App,
	ButtonComponent,
	Component,
	MarkdownRenderer,
	Modal,
	Notice,
	Platform,
	setIcon,
	TFile,
} from 'obsidian';
import { cssProps } from '../css-props';
import type { Memo } from '../types';
import * as logger from '../logger';
import {
	applyMobileEditability,
	graftNativeEditor,
	seedDomCaret,
	type GraftedEditorHandle,
} from './editor-graft';
import { MentionController } from './mention';
import { TagSuggestController } from './tag-suggest';
import { MEMO_ID_RE, parseMemoId } from '../id';
import { memoRefId, refIdAtCursor } from '../parser';
import { scrollCardIntoList } from './list';

export interface CardCallbacks {
	onEdit: (memo: Memo, content: string) => Promise<void>;
	onDelete: (memo: Memo) => Promise<void>;
	onPin?: (memo: Memo) => Promise<void>;
	/** Toggle the star (sidebar 星标 view filter) — independent of pinning. */
	onStar?: (memo: Memo) => Promise<void>;
	onArchive?: (memo: Memo) => Promise<void>;
	onTagClick?: (tag: string | null) => void;
	/** Touch flow: edit this memo in the composer (above the feed) instead of
	 * in-card, where the soft keyboard would cover the editor on iPad/phone. */
	onEditRequest?: (memo: Memo) => void;
	/** `@@` in the inline editor: create a blank memo, its ref replaces the
	 * `@@name` token (see MentionController). */
	onCreateMemo?: (
		name: string,
	) => Promise<{ sourceFile: string; id: string } | null>;
	/** Shift+Enter with the caret on a memo ref: open that memo's editor. */
	onRefOpen?: (id: string) => void;
}

/**
 * Cross-memo link context, computed once per list render and shared by every
 * card. `byId` resolves outlink targets; `inlinks` is the reverse map (memo id
 * → memos that link to it); `onNavigate` routes a click to the target memo
 * (scroll + flash inside the feed, canvas fallback when filtered out).
 */
export interface RefContext {
	byId: Map<string, Memo>;
	inlinks: Map<string, Memo[]>;
	onNavigate: (memo: Memo) => void;
}

/** The one active inline edit session (at most one card is editable at a
 * time; switching cards discards the current unsaved input). */
interface EditSession {
	memo: Memo;
	card: HTMLElement;
	wrap: HTMLElement;
	cb: CardCallbacks;
	ctx: RefContext;
	handle: GraftedEditorHandle | null;
	fallback: HTMLTextAreaElement | null;
	mention: MentionController | null;
	tagSuggest: TagSuggestController | null;
	previewTimer: number | null;
}

export class CardRenderer {
	private htmlCache = new Map<string, { content: string; html: string }>();
	private component: Component;
	/* Pooled graft editor shared by every inline edit. Created lazily (warmed
	 * when a card menu opens), then reused forever — so every edit after the
	 * first is a DOM move + setValue instead of leaf creation + CM6 init. */
	private poolHandle: GraftedEditorHandle | null = null;
	private poolHolder: HTMLElement | null = null;
	private poolPromise: Promise<GraftedEditorHandle | null> | null = null;
	private session: EditSession | null = null;

	constructor(private app: App) {
		this.component = new Component();
		this.component.load();
	}

	private createMenuButton(parent: HTMLElement): HTMLElement {
		const btn = parent.createEl('button', {
			cls: 'memos-card-menu',
			attr: {
				'aria-label': 'Actions',
				title: 'Actions',
				style: 'width: 22px !important; height: 22px !important;',
			},
		});
		const svg = createSvg('svg');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		cssProps(svg, { width: '14px', height: '14px' });
		for (const { cx, cy, r } of [
			{ cx: 12, cy: 12, r: 1 },
			{ cx: 5, cy: 12, r: 1 },
			{ cx: 19, cy: 12, r: 1 },
		]) {
			const c = createSvg('circle');
			c.setAttribute('cx', String(cx));
			c.setAttribute('cy', String(cy));
			c.setAttribute('r', String(r));
			svg.appendChild(c);
		}
		btn.appendChild(svg);
		return btn;
	}

	private enforceMenuSvgSize(btn: HTMLElement): void {
		const svg = btn.querySelector('svg');
		if (svg) {
			svg.setAttribute('width', '14');
			svg.setAttribute('height', '14');
			cssProps(svg, {
				width: '14px',
				height: '14px',
			});
		}
		cssProps(btn, { width: '22px', height: '22px' });
	}

	async renderCard(
		memo: Memo,
		parent: HTMLElement,
		cb: CardCallbacks,
		ctx: RefContext,
	): Promise<void> {
		const card = parent.createDiv({ cls: 'memos-card' });
		if (memo.starred) card.addClass('memos-card-starred');
		card.dataset.memoId = memo.id;

		// Double-click a card → straight into edit mode (inline on desktop,
		// composer on touch — same split as the menu's Edit item). Ignored
		// while this very card is mid-edit, and on interactive children.
		card.addEventListener('dblclick', (e) => {
			if (this.session?.memo.id === memo.id) return;
			const t = e.target as HTMLElement;
			if (t.closest('button, a, .memos-inline-editor-wrap')) return;
			e.preventDefault();
			if (Platform.isMobile && cb.onEditRequest) {
				cb.onEditRequest(memo);
			} else {
				void this.startInlineEdit(card, memo, cb, ctx);
			}
		});

		// Route clicks on outlink/inlink chips and in-body "memo" links to the
		// target card. Capture phase so we win over Obsidian's own link handler
		// (staying in the feed beats jumping to the canvas when the target is
		// already visible here).
		card.addEventListener(
			'click',
			(e) => {
				const t = (e.target as HTMLElement).closest<HTMLElement>(
					'.memos-ref-chip[data-memo-id], .memos-memo-link[data-memo-id]',
				);
				if (!t) return;
				const id = t.dataset.memoId;
				if (!id) return;
				const target = ctx.byId.get(id);
				if (!target) {
					// Reference target was deleted — kill the navigation so the
					// grayed-out "dead" link behaves dead instead of opening a
					// canvas where the node no longer exists.
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				ctx.onNavigate(target);
			},
			true,
		);

		// Code-block copy button. Obsidian attaches its own per-element click
		// handler while rendering, but the card's innerHTML cache drops it on
		// re-render — so cached cards couldn't copy. Own it here in the capture
		// phase (which beats Obsidian's target-phase handler) so fresh and cached
		// cards behave identically.
		card.addEventListener(
			'click',
			(e) => {
				const btn = (e.target as HTMLElement).closest<HTMLElement>(
					'button.copy-code-button',
				);
				if (!btn) return;
				const pre = btn.closest('pre');
				if (!pre) return;
				e.preventDefault();
				e.stopPropagation();
				const codeEl = pre.querySelector('code');
				let text = codeEl?.textContent ?? pre.textContent ?? '';
				if (text.endsWith('\n')) text = text.slice(0, -1);
				void navigator.clipboard
					.writeText(text)
					.then(() => {
						setIcon(btn, 'check');
						btn.addClass('memos-copy-success');
						window.setTimeout(() => {
							setIcon(btn, 'copy');
							btn.removeClass('memos-copy-success');
						}, 1500);
					})
					.catch(() => new Notice('复制失败'));
			},
			true,
		);

		// Wiki-link hover preview: route internal-link hovers into Obsidian's
		// 'Page preview' core plugin via the documented `hover-link` event. The
		// 'memos' source is registered with defaultMod:false (main.ts), so a
		// plain hover pops the preview without holding Cmd.
		card.addEventListener('mouseover', (e) => {
			const link = (e.target as HTMLElement).closest<HTMLElement>(
				'a.internal-link',
			);
			if (!link) return;
			const linktext = link.dataset.href ?? link.getAttribute('href') ?? '';
			if (!linktext) return;
			this.app.workspace.trigger('hover-link', {
				event: e,
				source: 'memos',
				hoverParent: this.component,
				targetEl: link,
				linktext,
				sourcePath: memo.sourceFile,
			});
		});

		const header = card.createDiv({ cls: 'memos-card-header' });
		const headerLeft = header.createDiv({ cls: 'memos-card-header-left' });
		const updated = headerLeft.createDiv({ cls: 'memos-card-updated' });
		// Show the CREATION time (decoded from the node id) — that's the
		// date the heatmap and the date filter are keyed on, so a memo
		// edited later still appears under its original day.
		const created = parseMemoId(memo.id);
		if (created) {
			updated.setText(`${created.date} ${created.hour}:${created.minute}`);
		} else {
			updated.setText(this.formatUpdatedAt(memo.updatedAt, memo.id));
		}

		// Right edge: an optional quiet pin glyph (same treatment as a
		// pinned sidebar tag) beside the ⋯ button. Star takes the loud
		// affordance — the card's green left border (.memos-card-starred);
		// pin only floats the card to the top and marks itself here.
		const headerRight = header.createDiv({ cls: 'memos-card-header-right' });
		if (memo.pinned) {
			const pin = headerRight.createSpan({ cls: 'memos-card-pin' });
			setIcon(pin, 'pin');
			pin.setAttribute('aria-label', '已置顶');
		}
		const menuBtn = this.createMenuButton(headerRight);
		this.enforceMenuSvgSize(menuBtn);
		// Size permanence is CSS's job — see the `.memos-card-menu` rules in
		// styles.css (desktop 22px / mobile+tablet 36px). A per-card
		// setInterval that re-enforced the size every 200ms for 3s used to
		// run here: N cards × ~15 style-writing ticks per full list render,
		// and superseded renders kept firing on detached buttons — a major
		// iPad hitch source. Removed; the one-shot enforce above suffices.
		menuBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.showMenu(e, card, memo, cb, ctx);
		});

		const body = card.createDiv({ cls: 'memos-card-body' });
		// Obsidian scopes its reading-view chrome (the code-block copy button,
		// embed styling, …) under a `.markdown-rendered` ancestor — render into
		// that wrapper or the button shows up unstyled and in-flow.
		const md = body.createDiv({ cls: 'markdown-rendered' });
		const cached = this.htmlCache.get(memo.id);
		if (cached && cached.content === memo.content) {
			// eslint-disable-next-line no-unsanitized/property -- cached HTML is our own MarkdownRenderer output for this card, never user-supplied markup.
			md.innerHTML = cached.html;
		} else {
			await MarkdownRenderer.render(
				this.app,
				memo.content,
				md,
				memo.sourceFile,
				this.component,
			);
			this.decorateMemoLinks(md);
			// Own the code-block copy button BEFORE caching (see the method): put a
			// button inside every <pre> so it anchors in the block's top-right and
			// the cached HTML carries it.
			this.normalizeCopyButtons(md);
			this.htmlCache.set(memo.id, {
				content: memo.content,
				html: md.innerHTML,
			});
		}

		// Re-check which in-body memo links point at deleted memos on EVERY render.
		// The body HTML comes from a content-keyed cache, but whether a referenced
		// memo still exists changes independently of this memo's content — so the
		// "broken" state can't live in the cached snapshot; toggle it here.
		this.markBrokenMemoLinks(md, ctx);

		this.renderRefs(card, memo, ctx);
	}

	/**
	 * Turn rendered `[[Memos/….canvas#<id>]]` anchors into short "memo" links:
	 * tag each with its target memo id (so clicks route within the feed) and —
	 * when the user didn't write an explicit `|alias` — replace the raw path
	 * display text with the word "memo". User-provided aliases are kept.
	 */
	private decorateMemoLinks(body: HTMLElement): void {
		const anchors =
			body.querySelectorAll<HTMLAnchorElement>('a.internal-link');
		anchors.forEach((a) => {
			const target = a.dataset.href ?? a.getAttribute('href') ?? '';
			const frag = target.split('#').pop() ?? '';
			if (!MEMO_ID_RE.test(frag)) return;
			a.classList.add('memos-memo-link');
			a.dataset.memoId = frag;
			const text = (a.textContent ?? '').trim();
			if (text === '' || text === target.trim() || text.includes('.canvas#')) {
				a.textContent = 'Memo';
			}
		});
	}

	/**
	 * Mark in-body `[[…#id]]` memo links whose target memo no longer exists, so
	 * they render in the gray "broken" style. Called on every render (see caller
	 * note): brokenness depends on the live memo set, not this memo's content, so
	 * it must be re-derived after the cached HTML is restored rather than cached.
	 */
	private markBrokenMemoLinks(body: HTMLElement, ctx: RefContext): void {
		const anchors = body.querySelectorAll<HTMLAnchorElement>(
			'a.memos-memo-link[data-memo-id]',
		);
		anchors.forEach((a) => {
			const id = a.dataset.memoId;
			if (!id) return;
			a.classList.toggle('memos-memo-link-broken', !ctx.byId.has(id));
		});
	}

	/**
	 * Take ownership of the code-block copy button. Obsidian's post-processor
	 * creates it as a SIBLING of <pre> (a child of pre.parentElement) and dedups
	 * per parent — inside our shared `.markdown-rendered` container that means it
	 * floats up to the nearest positioned ancestor (out into the card's right
	 * margin) and only ONE button is made for all blocks. Strip those and create
	 * our own button inside each <pre>, where the CSS anchors it in the block's
	 * top-right corner. The actual copy is handled by the capture-phase click
	 * handler in renderCard, which — unlike Obsidian's per-element handler —
	 * survives the innerHTML cache round-trip.
	 */
	private normalizeCopyButtons(body: HTMLElement): void {
		body.querySelectorAll('button.copy-code-button').forEach((b) => b.remove());
		body.querySelectorAll('pre').forEach((pre) => {
			const btn = pre.createEl('button', { cls: 'copy-code-button' });
			btn.setAttribute('aria-label', 'Copy code');
			setIcon(btn, 'copy');
		});
	}

	/**
	 * "引用 / 被引用" footer at the bottom of the card. Two left-aligned rows
	 * (outlinks "引用" first, blue ↗; inlinks "被引用" second, teal ↙), each chip
	 * showing the referenced memo's time + a short content snippet. Outlinks whose
	 * target memo was deleted render as gray, non-clickable chips. Rendered only
	 * when the memo has references in either direction (or a broken one).
	 */
	private renderRefs(card: HTMLElement, memo: Memo, ctx: RefContext): void {
		const outlinks: Memo[] = [];
		/** Ids of referenced memos that no longer exist (deleted) — rendered as
		 * gray, non-clickable chips instead of being silently dropped. */
		const broken: string[] = [];
		const seen = new Set<string>();
		for (const link of memo.links) {
			const id = memoRefId(link);
			if (!id || id === memo.id || seen.has(id)) continue;
			seen.add(id);
			const target = ctx.byId.get(id);
			if (target) outlinks.push(target);
			else broken.push(id);
		}
		const inlinks = (ctx.inlinks.get(memo.id) ?? []).filter(
			(m) => m.id !== memo.id,
		);
		if (outlinks.length === 0 && inlinks.length === 0 && broken.length === 0) {
			return;
		}

		const refs = card.createDiv({ cls: 'memos-card-refs' });
		if (outlinks.length > 0 || broken.length > 0) {
			this.renderRefsRow(refs, 'out', 'arrow-up-right', '引用', outlinks, broken);
		}
		if (inlinks.length > 0) {
			this.renderRefsRow(refs, 'in', 'arrow-down-left', '被引用', inlinks, []);
		}
	}

	private renderRefsRow(
		parent: HTMLElement,
		kind: 'out' | 'in',
		icon: string,
		label: string,
		memos: Memo[],
		brokenIds: string[],
	): void {
		const row = parent.createDiv({ cls: `memos-refs-row memos-refs-${kind}` });
		const lab = row.createSpan({ cls: 'memos-refs-label' });
		setIcon(lab.createSpan({ cls: 'memos-refs-label-icon' }), icon);
		lab.createSpan({ cls: 'memos-refs-label-text', text: label });
		const chips = row.createDiv({ cls: 'memos-refs-chips' });
		for (const m of memos) {
			const chip = chips.createDiv({ cls: 'memos-ref-chip' });
			chip.dataset.memoId = m.id;
			chip.setAttribute('role', 'button');
			const full = snippetText(m.content, 80);
			if (full) chip.setAttribute('title', full);
			chip.createSpan({ cls: 'memos-ref-chip-time', text: this.shortTime(m) });
			const snip = snippetText(m.content);
			if (snip) chip.createSpan({ cls: 'memos-ref-chip-snippet', text: snip });
		}
		// Broken references: the target memo was deleted, so there is no content
		// or navigation target — show a gray, non-clickable chip with just the
		// referenced memo's time (parsed from its id) and a "已删除" marker.
		for (const id of brokenIds) {
			const chip = chips.createDiv({
				cls: 'memos-ref-chip memos-ref-chip-broken',
			});
			chip.setAttribute('title', '引用的笔记已删除');
			const p = parseMemoId(id);
			chip.createSpan({
				cls: 'memos-ref-chip-time',
				text: p ? `${p.month}-${p.day} ${p.hour}:${p.minute}` : id,
			});
			chip.createSpan({ cls: 'memos-ref-chip-snippet', text: '已删除' });
		}
	}

	/** Compact "MM-DD HH:mm" label for ref chips (falls back to full time). */
	private shortTime(memo: Memo): string {
		const p = parseMemoId(memo.id);
		if (p) return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
		return this.formatUpdatedAt(memo.updatedAt);
	}

	private showMenu(
		e: MouseEvent,
		card: HTMLElement,
		memo: Memo,
		cb: CardCallbacks,
		ctx: RefContext,
	): void {
		// Warm the pooled editor in the background so clicking Edit is instant.
		// Desktop only: on mobile/tablet the menu's Edit routes to the composer
		// (the onEditRequest branches below), so the pool — a second grafted
		// live MarkdownView with its own event fan-out and CM6 measure cycle —
		// would just sit idle and double per-event cost while typing.
		if (!Platform.isMobile) this.warmPool();
		const trigger = (e.target as HTMLElement).closest<HTMLElement>(
			'.memos-card-menu',
		);
		const existing = document.querySelector(
			'.memos-card-dropdown',
		) as HTMLElement & { _trigger?: HTMLElement; _close?: () => void };
		if (existing && trigger && existing._trigger === trigger) {
			(existing._close ?? (() => existing.remove()))();
			return;
		}
		if (existing) (existing._close ?? (() => existing.remove()))();

		const menu = document.body.createDiv({
			cls: 'memos-card-dropdown',
		}) as HTMLElement & { _trigger?: HTMLElement; _close?: () => void };
		if (Platform.isMobile && !Platform.isTablet) {
			menu.addClass('memos-dropdown-sheet');
		}

		const addItem = (
			label: string,
			icon: string,
			action: () => void,
			danger = false,
		) => {
			const btn = menu.createEl('button', {
				cls:
					'memos-card-dropdown-item' +
					(danger ? ' memos-card-dropdown-item-danger' : ''),
			});
			const ic = btn.createSpan({ cls: 'memos-card-dropdown-item-icon' });
			setIcon(ic, icon);
			btn.createSpan({ cls: 'memos-card-dropdown-item-label', text: label });
			btn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				close();
				action();
			});
		};
		const sep = () => menu.createDiv({ cls: 'memos-card-dropdown-separator' });

		addItem('Copy', 'copy', () => {
			void navigator.clipboard.writeText(memo.content);
		});
		addItem('复制卡片引用', 'link', () => {
			void navigator.clipboard.writeText(
				`[[${memo.sourceFile}#${memo.id}|memo]]`,
			);
			new Notice('已复制卡片引用');
		});
		addItem('Edit', 'pencil', () => {
			// On iPad/phone the in-card editor is unusable once the soft keyboard
			// opens (it fills the short viewport), so edit in the composer instead.
			if (Platform.isMobile && cb.onEditRequest) {
				cb.onEditRequest(memo);
			} else {
				void this.startInlineEdit(card, memo, cb, ctx);
			}
		});
		addItem('定位到源文件位置', 'file-search', () =>
			void this.locateInSource(memo),
		);
		addItem(
			memo.starred ? '取消星标' : '星标',
			'star',
			() => {
				if (cb.onStar) void cb.onStar(memo);
			},
		);
		addItem(
			memo.pinned ? '取消置顶' : '置顶',
			'pin',
			() => {
				if (cb.onPin) void cb.onPin(memo);
			},
		);
		addItem(
			memo.archived ? 'Unarchive' : 'Archive',
			'archive',
			() => {
				if (cb.onArchive) void cb.onArchive(memo);
			},
		);
		sep();
		addItem(
			'Delete',
			'trash-2',
			() => {
				new DeleteMemoModal(this.app, memo, cb.onDelete).open();
			},
			true,
		);

		const rect = trigger?.getBoundingClientRect();
		if (rect) {
			const w = menu.offsetWidth;
			const h = menu.offsetHeight;
			let left = rect.right - w;
			left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
			let top = rect.bottom + 4;
			if (top + h > window.innerHeight - 8) {
				top = Math.max(8, rect.top - h - 4);
			}
			menu.style.left = `${left}px`;
			menu.style.top = `${top}px`;
		}

		let leaveTimer: number | null = null;
		const close = () => {
			if (leaveTimer !== null) {
				window.clearTimeout(leaveTimer);
				leaveTimer = null;
			}
			menu.remove();
			document.removeEventListener('click', onDoc, true);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('resize', close);
		};
		const onDoc = (ev: MouseEvent) => {
			if (trigger && trigger.contains(ev.target as Node)) return;
			if (menu.contains(ev.target as Node)) return;
			close();
		};
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key === 'Escape') close();
		};
		menu._close = close;
		menu._trigger = trigger ?? undefined;

		const onLeave = () => {
			if (leaveTimer !== null) window.clearTimeout(leaveTimer);
			leaveTimer = window.setTimeout(close, 1000);
		};
		const onEnter = () => {
			if (leaveTimer !== null) {
				window.clearTimeout(leaveTimer);
				leaveTimer = null;
			}
		};

		window.setTimeout(() => {
			document.addEventListener('click', onDoc, true);
			document.addEventListener('keydown', onKey);
			window.addEventListener('resize', close);
			menu.addEventListener('mouseleave', onLeave);
			menu.addEventListener('mouseenter', onEnter);
		}, 0);
	}

	async locateInSource(memo: Memo): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(memo.sourceFile);
		if (!(file instanceof TFile)) {
			new Notice('找不到源文件：' + memo.sourceFile);
			return;
		}
		// Canvas node link: opens the canvas and focuses the node.
		try {
			await this.app.workspace.openLinkText(
				`${file.path}#${memo.id}`,
				'',
				true,
			);
		} catch (e) {
			logger.error('Failed to locate memo in canvas', e);
			new Notice('无法定位到画布中的卡片');
		}
	}

	/* ─────────────────────── Inline editing ─────────────────────── */

	/** Start pool creation in the background (called when a card menu opens,
	 * so the editor is usually warm before the user clicks Edit). */
	private warmPool(): void {
		if (this.poolHandle || this.poolPromise || this.session) return;
		void this.getPooledEditor().catch(() => {
			/* startInlineEdit falls back to a plain textarea if this fails */
		});
	}

	private async getPooledEditor(): Promise<GraftedEditorHandle> {
		if (this.poolHandle && this.isPoolAlive()) return this.poolHandle;
		if (this.poolHandle && !this.isPoolAlive()) {
			this.poolHandle = null;
			this.poolPromise = null;
		}
		if (this.poolPromise) {
			const h = await this.poolPromise;
			if (h) return h;
		}
		this.poolPromise = (async () => {
			if (!this.poolHolder) {
				this.poolHolder = document.body.createDiv({
					cls: 'memos-editor-pool-holder',
					attr: {
						style:
							'position:absolute;left:-99999px;top:0;width:320px;' +
							'visibility:hidden;pointer-events:none;',
					},
				});
			}
			const h = await graftNativeEditor(
				this.app,
				this.poolHolder,
				'',
				'memos-inline-edit-pool.md',
				6000,
				true,
			);
			this.poolHandle = h;
			return h;
		})();
		try {
			const h = await this.poolPromise;
			if (!h) throw new Error('pool editor unavailable');
			return h;
		} finally {
			this.poolPromise = null;
		}
	}

	private isPoolAlive(): boolean {
		try {
			this.poolHandle!.editor.getValue();
			return !!(
				this.poolHolder && this.poolHolder.querySelector('.cm-editor')
			);
		} catch {
			return false;
		}
	}

	private poolDom(): HTMLElement | null {
		return (
			this.poolHolder?.querySelector('.markdown-source-view') ??
			this.poolHolder?.querySelector('.cm-editor') ??
			null
		);
	}

	async startInlineEdit(
		card: HTMLElement,
		memo: Memo,
		cb: CardCallbacks,
		ctx: RefContext,
	): Promise<void> {
		if (this.session?.memo.id === memo.id) return;
		// A card already being edited is abandoned — unsaved input is discarded.
		if (this.session) this.closeSession('cancel');

		card.empty();
		this.htmlCache.delete(memo.id);

		const wrap = card.createDiv({ cls: 'memos-inline-editor-wrap' });
		const actions = card.createDiv({ cls: 'memos-inline-actions' });
		const session: EditSession = {
			memo,
			card,
			wrap,
			cb,
			ctx,
			handle: null,
			fallback: null,
			mention: null,
			tagSuggest: null,
			previewTimer: null,
		};
		this.session = session;

		const cancelBtn = actions.createEl('button', {
			cls: 'memos-btn memos-btn-ghost',
			text: 'Cancel',
		});
		cancelBtn.addEventListener('click', () => this.closeSession('cancel'));

		const saveBtn = actions.createEl('button', {
			cls: 'memos-btn memos-btn-primary',
			text: 'Save',
		});
		saveBtn.addEventListener('click', () => this.closeSession('save'));

		// Dead-zone focus only: taps inside .cm-content position the caret
		// natively, and a programmatic focus() racing that on iOS yanks the
		// caret back (same race as the composer — see editor.ts build()).
		const focusIfOutsideContent = (e: Event) => {
			const t = e.target;
			if (t instanceof Element && t.closest('.cm-content')) return;
			session.handle?.editor.focus();
		};
		wrap.addEventListener('click', focusIfOutsideContent);
		wrap.addEventListener('touchend', focusIfOutsideContent);

		let handle: GraftedEditorHandle | null = null;
		try {
			handle = await this.getPooledEditor();
		} catch (err) {
			logger.error('Pool editor unavailable:', err);
		}
		if (this.session !== session) return; // superseded while awaiting

		if (handle) {
			const dom = this.poolDom();
			if (!dom) {
				handle = null;
			} else {
				wrap.appendChild(dom);
				applyMobileEditability(wrap);
				try {
					handle.editor.setValue(memo.content);
					// Caret at the END of the memo (after the last character):
					// the pooled editor's old selection (usually 0 after the
					// previous session's clear) maps through setValue, so pin
					// the end explicitly — in state, in the DOM (pre-seed so
					// an iOS focus opens the keyboard there), and again after
					// focus in case the platform moved it. NB: setSelection,
					// not setCursor — setCursor only exists on Obsidian ≥1.13
					// runtimes and throws here (1.12.4).
					const ed = handle.editor;
					const lastLine = ed.lineCount() - 1;
					const endPos = {
						line: lastLine,
						ch: ed.getLine(lastLine).length,
					};
					ed.setSelection(endPos);
					seedDomCaret(ed, ed.getValue().length);
					ed.refresh();
					window.requestAnimationFrame(() => {
						try {
							handle!.editor.refresh();
							if (this.session === session) {
								const e = handle!.editor;
								const l = e.lineCount() - 1;
								e.setSelection({ line: l, ch: e.getLine(l).length });
							}
						} catch {
							/* ignore */
						}
					});
					ed.focus();
					ed.setSelection(endPos);
					session.handle = handle;
					if (handle.isLivePreview) wrap.addClass('memos-inline-live-preview');
					session.mention = new MentionController(
						{
							getMemos: () => [...session.ctx.byId.values()],
							getEditor: () => session.handle?.editor ?? null,
							onCreateMemo: cb.onCreateMemo,
						},
						wrap,
					);
					session.tagSuggest = new TagSuggestController(
						{
							getTagCounts: () => {
								const memos = [...session.ctx.byId.values()];
								const counts = new Map<string, number>();
								for (const m of memos) {
									for (const t of m.tags) {
										counts.set(t, (counts.get(t) || 0) + 1);
									}
								}
								return counts;
							},
							getEditor: () => session.handle?.editor ?? null,
						},
						wrap,
					);
				} catch (err) {
					logger.error('Failed to reuse pool editor:', err);
					handle = null;
				}
			}
		}

		if (!handle) {
			// Fallback: plain textarea + debounced markdown preview.
			wrap.empty();
			const fallback = wrap.createEl('textarea', {
				cls: 'memos-editor-textarea',
				attr: {
					'aria-label': 'Native editor failed — plain text mode',
					title: 'Native editor failed — plain text mode',
				},
			});
			fallback.value = memo.content;
			fallback.setSelectionRange(fallback.value.length, fallback.value.length);
			fallback.focus();
			fallback.setSelectionRange(fallback.value.length, fallback.value.length);
			session.fallback = fallback;

			const preview = wrap.createDiv({
				cls: 'memos-inline-preview markdown-rendered',
			});
			const renderPreview = async () => {
				preview.empty();
				await MarkdownRenderer.render(
					this.app,
					fallback.value,
					preview,
					memo.sourceFile,
					this.component,
				);
			};
			fallback.addEventListener('input', () => {
				if (session.previewTimer !== null) {
					window.clearTimeout(session.previewTimer);
				}
				session.previewTimer = window.setTimeout(
					() => void renderPreview(),
					150,
				);
			});
			void renderPreview();
		}

			// Scroll ONLY the memo list, not the feed/view ancestors — scrollIntoView
			// would fling the fixed composer up when the target card is far down.
			const listEl = card.closest('.memos-list');
			if (listEl instanceof HTMLElement) {
				await scrollCardIntoList(listEl, card);
			} else {
				card.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}

			wrap.addEventListener(
				'keydown',
				(ev) => {
					const e = ev;
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
					e.preventDefault();
					e.stopPropagation();
					saveBtn.click();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					cancelBtn.click();
				} else if (
					e.key === 'Enter' &&
					e.shiftKey &&
					!e.isComposing &&
					cb.onRefOpen &&
					session.handle
				) {
					// Shift+Enter on a memo ref: save this session (closeSession
					// only writes when the content actually changed), then jump
					// into the referenced memo's editor.
					const id = refIdAtCursor(session.handle.editor);
					if (id) {
						e.preventDefault();
						e.stopPropagation();
						this.closeSession('save');
						cb.onRefOpen(id);
					}
				}
			},
			true,
		);
	}

	/**
	 * End the inline edit session.
	 * - `save`: write the content if changed;
	 * - `cancel`: discard the input (also used when switching to another card).
	 * Always parks the pooled editor back in its holder and rebuilds the card
	 * in place (the list's render cache would otherwise leave an empty shell).
	 */
	private closeSession(reason: 'save' | 'cancel'): void {
		const s = this.session;
		if (!s) return;
		this.session = null;

		let value = '';
		if (s.handle) {
			try {
				value = s.handle.editor.getValue();
			} catch {
				value = '';
			}
		} else if (s.fallback) {
			value = s.fallback.value;
		}

		if (s.previewTimer !== null) window.clearTimeout(s.previewTimer);
		s.mention?.destroy();

		if (reason === 'save') {
			const v = value.trim();
			if (v && v !== s.memo.content) void s.cb.onEdit(s.memo, v);
		}

		if (s.handle) {
			const dom =
				s.wrap.querySelector('.markdown-source-view') ??
				s.wrap.querySelector('.cm-editor');
			if (dom && this.poolHolder) this.poolHolder.appendChild(dom);
			try {
				s.handle.editor.setValue('');
				s.handle.editor.refresh();
			} catch {
				/* ignore */
			}
		}

		void this.rebuildCard(s);

		// Keep focus inside the list on mobile so the soft keyboard stays put.
		const parent = s.card.parentElement;
		if (parent) {
			parent.setAttribute('tabindex', '-1');
			parent.focus();
		}
	}

	private async rebuildCard(s: EditSession): Promise<void> {
		const holder = document.body.createDiv();
		const memo = s.ctx.byId.get(s.memo.id) ?? s.memo;
		await this.renderCard(memo, holder, s.cb, s.ctx);
		const fresh = holder.firstElementChild;
		if (fresh && s.card.isConnected) s.card.replaceWith(fresh);
		holder.remove();
	}

	destroy(): void {
		if (this.session) {
			if (this.session.previewTimer !== null) {
				window.clearTimeout(this.session.previewTimer);
			}
			this.session.mention?.destroy();
			this.session.tagSuggest?.destroy();
			this.session = null;
		}
		if (this.poolHandle) {
			try {
				this.poolHandle.destroy();
			} catch {
				/* ignore */
			}
			this.poolHandle = null;
		}
		this.poolHolder?.remove();
		this.poolHolder = null;
		this.component.unload();
		this.htmlCache.clear();
	}

	formatUpdatedAt(updatedAt: string, id?: string): string {
		const m = (
			window as unknown as {
				moment: (inp?: string, fmt?: string) => {
					isValid: () => boolean;
					format: (f: string) => string;
				};
			}
		).moment(updatedAt, 'YYYY-MM-DD HH:mm:ss');
		if (m.isValid()) return m.format('YYYY-MM-DD HH:mm');
		if (id) {
			const p = parseMemoId(id);
			if (p) return `${p.date} ${p.hour}:${p.minute}`;
		}
		return updatedAt;
	}
}

class DeleteMemoModal extends Modal {
	constructor(
		app: App,
		private memo: Memo,
		private onConfirm: (memo: Memo) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'Delete memo' });
		contentEl.createEl('p', {
			text: `Are you sure you want to delete this memo (${this.memo.id})? This cannot be undone.`,
		});
		const row = contentEl.createDiv({ cls: 'memos-modal-actions' });
		new ButtonComponent(row).setButtonText('Cancel').onClick(() => this.close());
		new ButtonComponent(row)
			.setButtonText('Delete')
			.setWarning()
			.onClick(async () => {
				await this.onConfirm(this.memo);
				this.close();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Plain-text preview of a memo for ref chips: strips wikilinks/embeds, code
 * fences, HTML tags and markdown emphasis, collapses whitespace, truncates.
 */
function snippetText(content: string, max = 24): string {
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
