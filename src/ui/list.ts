import { App } from 'obsidian';
import type { Memo, MemosState } from '../types';
import { CardRenderer, type CardCallbacks, type RefContext } from './card';
import { memoRefId } from '../parser';

export interface MemoListCallbacks extends CardCallbacks {
	onTagClick: (tag: string | null) => void;
	onDateToggle?: (date: string) => void;
	onNavigate: (memo: Memo) => void;
	/** Fires while the user scrolls the card list. `scrolledDown` is true when
	 * the list scrollTop has moved away from the top (first card hidden). */
	onScrollChange?: (scrolledDown: boolean) => void;
}

/** Cards per render batch. */
const CHUNK = 30;

/** Frame-aligned yield — lets content-visibility placeholder cards swap
 * their real heights and smooth scroll animations land between measures. */
function nextFrame(): Promise<void> {
	return new Promise((r) => {
		if (typeof requestAnimationFrame === 'function') {
			window.requestAnimationFrame(() => r());
		} else {
			window.setTimeout(r, 16);
		}
	});
}

/**
 * Scroll `el` so its TOP edge lands exactly at the top of `listEl`'s
 * scrollport — which sits flush below the composer, so the card's top
 * border aligns with the composer's bottom border. Scrolling is scoped to
 * the list's OWN scrollport WITHOUT letting the browser scroll the
 * feed/view ancestors: `el.scrollIntoView` treats `overflow: hidden`
 * ancestors (the feed) and Obsidian's workspace containers as scrollable
 * and scrolls them too — jumping to a far-down card then flings the fixed
 * composer up and out of place. Scoping the scroll to the list keeps the
 * composer pinned.
 */
export async function scrollCardIntoList(
	listEl: HTMLElement,
	el: HTMLElement,
	behavior: ScrollBehavior = 'smooth',
): Promise<void> {
	// Compute the card's position relative to the list's content area.
	// getBoundingClientRect() triggers a synchronous layout, so it returns
	// the real position even for cards that were just bulk-inserted into the
	// DOM and haven't had their offsetTop populated yet. offsetTop relies on
	// the offsetParent chain, which returns stale (zero) values until the
	// browser's async layout pass completes — causing scrollToMemo to
	// silently jump to the top instead of the target for far-away cards.
	// The alignment reference is the COMPOSER's bottom border, not the
	// list's own top edge: the list scrollport sits a few px below the
	// composer (feed gap / padding), so aligning to the list top would
	// leave the card that many px lower than the composer. Measure the gap
	// and roll the card that far past the list's top edge. When no
	// composer exists (inline edit on a detached card) or it sits
	// below/overlapping the list, fall back to the list's top edge.
	const feed = listEl.closest('.memos-feed');
	const composer = feed?.querySelector('.memos-editor');
	const listRect = listEl.getBoundingClientRect();
	const composerBottom =
		composer?.getBoundingClientRect().bottom ?? listRect.top;
	const gap = Math.max(0, listRect.top - composerBottom);
	// Land a small breathing space below the composer's bottom border so the
	// jumped-to card doesn't glue itself against the input box.
	const JUMP_BREATH = 5;
	const cardRect = el.getBoundingClientRect();
	// clientTop = border-top width. getBoundingClientRect().top is the
	// border-box edge, but scrollTop is measured from the padding-box edge
	// (inside the border). Subtracting clientTop aligns the two coordinate
	// systems so a future border-top on .memos-list can't silently skew
	// the offset by borderTop px.
	const offsetY =
		cardRect.top - listRect.top - listEl.clientTop + listEl.scrollTop;
	// Scroll to offsetY + gap: after the scroll the card's top border sits
	// gap px above the list's top edge — exactly on the composer's bottom
	// border — minus JUMP_BREATH so a 5px sliver of space separates the two.
	const target = offsetY + gap - JUMP_BREATH;
	const maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
	const initialTop = Math.max(0, Math.min(target, maxScroll));
	listEl.scrollTo({ top: initialTop, behavior });

	// A smooth glide takes a few hundred ms — wait for it to land before
	// measuring, or every check below would read a mid-flight position.
	if (behavior === 'smooth') {
		for (let i = 0; i < 40; i++) {
			await nextFrame();
			if (Math.abs(listEl.scrollTop - initialTop) <= 1) break;
		}
	}

	// Iterative precision pass. Mobile/tablet cards use content-visibility:
	// auto with a contain-intrinsic-size placeholder, so cards that were
	// never rendered report a fake (~180px) height and the initial target
	// above is computed against that placeholder layout. After the scroll
	// lands, cards near the scrollport — and crucially every placeholder
	// card ABOVE the target — keep swapping in their real heights over many
	// frames; each swap shifts the target card's absolute offset downward.
	// A single fixed-count pass misses the late swaps. Keep correcting until
	// the position is STABLE for several consecutive frames (re-layout has
	// settled) instead of stopping after a fixed number of nudges.
	let stableFrames = 0;
	for (let i = 0; i < 90; i++) {
		if (!el.isConnected || !listEl.isConnected) return;
		await nextFrame();
		const nr = listEl.getBoundingClientRect();
		const cr = el.getBoundingClientRect();
		// The correction target is the composer's bottom border: the card is
		// supposed to sit gap px ABOVE the list's top edge, so re-add the
		// (possibly re-measured) gap to the raw drift — then subtract the
		// same JUMP_BREATH as the initial jump so the pass converges on the
		// same 5px breathing space instead of pulling the card flush.
		const g = Math.max(
			0,
			nr.top - (composer?.getBoundingClientRect().bottom ?? nr.top),
		);
		const drift = cr.top - nr.top - listEl.clientTop + g - JUMP_BREATH;
		if (Math.abs(drift) <= 1) {
			stableFrames++;
			// Settled: several frames in a row with no measurable drift.
			if (stableFrames >= 3) break;
			continue;
		}
		stableFrames = 0;
		// Recompute maxScroll: scrollHeight changes as placeholder-height
		// cards take their real sizes.
		const ms = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
		listEl.scrollTop = Math.max(
			0,
			Math.min(listEl.scrollTop + Math.round(drift), ms),
		);
	}
}

/** Shortcut: scroll the `.memos-list` that contains `el` so `el` is at the
 * top (not centered) — for the "scroll to first card" jump. */
export function scrollListToTop(
	listEl: HTMLElement,
	behavior: ScrollBehavior = 'smooth',
): void {
	listEl.scrollTo({ top: 0, behavior });
}

export class MemoList {
	private listEl!: HTMLElement;
	private cardRenderer: CardRenderer;
	private lastRenderSig = '';
	/** Increments per render(); a loop that sees a different token has been
	 * superseded by a newer render and must stop appending stale cards. */
	private renderToken = 0;
	/** Ref context of the current rendered list — lets editMemo() open the
	 * inline editor on a card without recomputing the link maps. */
	private lastCtx: RefContext | null = null;
	/** Memos of the current (filtered) list — cards are built lazily from
	 * here as the user scrolls, not all up-front (see renderMore). */
	private memos: Memo[] = [];
	/** How many cards are currently in the DOM. */
	private renderedCount = 0;
	private allRendered = false;
	/** Serializes renderMore calls (scroll / resize / render can all fire it)
	 * so two never append overlapping cards. */
	private renderTail: Promise<void> = Promise.resolve();
	private scrollRaf = 0;
	private resizeObs: ResizeObserver | null = null;
	/** Track last-emitted scroll-down state so onScroll doesn't fire
	 * onScrollChange on every frame while the user holds still. */
	private _wasDown = false;

	constructor(
		app: App,
		private callbacks: MemoListCallbacks,
	) {
		this.cardRenderer = new CardRenderer(app);
	}

	build(parent: HTMLElement): void {
		this.listEl = parent.createDiv({ cls: 'memos-list' });
		// Progressive rendering: the list is the scroll container (overflow-y:auto);
		// we render a viewport's worth of cards and top up as the user scrolls down.
		this.listEl.addEventListener('scroll', () => this.onScroll(), {
			passive: true,
		});
		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObs = new ResizeObserver(() => this.onViewportGrow());
			this.resizeObs.observe(this.listEl);
		}
	}

	async render(state: MemosState): Promise<void> {
		// The ref footers depend on links across ALL memos (an inlink may come
		// from a memo that's currently filtered out), so the cache signature
		// includes a fingerprint of every memo's link count — plus each visible
		// memo's content length, updatedAt and tags so any write (even a
		// same-length edit or a pin/archive flip) refreshes the list.
		const linkFp = state.memos.map((m) => m.links.length).join('');
		const sig =
			state.viewMode +
			'|' +
			state.filteredMemos
				.map(
					(m) =>
						m.id +
						(m.pinned ? 'P' : '') +
						(m.starred ? 'S' : '') +
						'$' +
						m.content.length +
						'#' +
						m.updatedAt +
						'%' +
						m.tags.join('~'),
				)
				.join(',') +
			'|' +
			linkFp;
		if (sig === this.lastRenderSig) return;
		// Save scroll position before emptying — a single delete/edit shouldn't
		// fling the list to the top. 0 when the view was just opened or the
		// previous list was empty.
		const prevScroll = this.listEl.scrollTop;
		this.lastRenderSig = sig;
		const token = ++this.renderToken;
		this.listEl.empty();
		this.memos = state.filteredMemos;
		this.renderedCount = 0;
		this.allRendered = false;

		if (this.memos.length === 0) {
			this.listEl.scrollTop = 0;
			this._wasDown = false;
			this.callbacks.onScrollChange?.(false);
			this.lastCtx = null;
			this.renderEmpty(state);
			return;
		}

		const ctx = this.buildRefContext(state);
		this.lastCtx = ctx;
		await this.renderMore(token, ctx);
		// Restore approximate scroll position after the new content is laid out.
		// Clamp to the new scrollHeight so a deleted card above the fold doesn't
		// leave scrollTop past the bottom.
		if (prevScroll > 0) {
			const maxScroll = this.listEl.scrollHeight - this.listEl.clientHeight;
			this.listEl.scrollTop = Math.min(prevScroll, Math.max(0, maxScroll));
		}
	}

	/**
	 * Render cards (from `this.renderedCount`) until the list fills its scroll
	 * viewport (plus a buffer) AND the render has passed `minThrough` (used by
	 * scrollToMemo/editMemo to force a far target into the DOM). Appends in
	 * chunks with frame-aligned yields so a large list never freezes the open.
	 * Serialized via renderTail so concurrent triggers can't double-append.
	 */
	private renderMore(token: number, ctx: RefContext, minThrough = -1): Promise<void> {
		const run = async () => {
			const targetHeight = this.listEl.clientHeight * 2 + 200;
			let holder: HTMLElement | null = null;
			let i = this.renderedCount;
			const flush = () => {
				if (!holder) return;
				while (holder.firstChild) this.listEl.appendChild(holder.firstChild);
			};
			try {
				while (i < this.memos.length) {
					if (token !== this.renderToken) return;
					if (!holder) holder = createDiv();
					const memo = this.memos[i];
					i++;
					if (!memo) continue;
					await this.cardRenderer.renderCard(
						memo,
						holder,
						this.callbacks,
						ctx,
					);
					if (i % CHUNK === 0) {
						// Bail before flushing if superseded mid-chunk — a stale
						// holder is discarded, not appended over the new list.
						if (token !== this.renderToken) return;
						flush();
						this.renderedCount = i;
						await this.yieldFrame();
						if (token !== this.renderToken) return;
						// Stop once the content fills the viewport (plus buffer) and
						// we've rendered at least one chunk — and any forced target.
						if (
							i >= Math.max(CHUNK, minThrough + 1) &&
							this.listEl.scrollHeight >= targetHeight
						) {
							return;
						}
					}
				}
			} finally {
				if (token === this.renderToken) {
					flush();
					this.renderedCount = i;
					this.allRendered = i >= this.memos.length;
				}
			}
		};
		const tail = this.renderTail.then(run, run);
		this.renderTail = tail.then(
			() => undefined,
			() => undefined,
		);
		return tail;
	}

	private yieldFrame(): Promise<void> {
		return new Promise((r) => {
			if (typeof requestAnimationFrame === 'function') {
				window.requestAnimationFrame(() => r());
			} else {
				window.setTimeout(r, 0);
			}
		});
	}

	/** Scroll-driven top-up: approaching the bottom of the rendered content
	 * renders the next chunk(s). rAF-throttled.
	 * Also emits onScrollChange so the feed can show/hide a "back to top"
	 * button while the list is scrolled away from the first card. */
	private onScroll(): void {
		if (this.scrollRaf || !this.lastCtx) return;
		this.scrollRaf = window.requestAnimationFrame(() => {
			this.scrollRaf = 0;
			if (!this.lastCtx) return;
			const el = this.listEl;
			if (!this.allRendered &&
				el.scrollTop + el.clientHeight >= el.scrollHeight - 500) {
				void this.renderMore(this.renderToken, this.lastCtx);
			}
			const down = el.scrollTop > 4;
			if (down !== this._wasDown) {
				this._wasDown = down;
				this.callbacks.onScrollChange?.(down);
			}
		});
	}

	/** The layout settles asynchronously (dock slide-in starts with the list at
	 * 0 height); when the viewport outgrows the rendered content, top up. */
	private onViewportGrow(): void {
		if (this.allRendered || !this.lastCtx) return;
		if (this.listEl.scrollHeight < this.listEl.clientHeight) {
			void this.renderMore(this.renderToken, this.lastCtx);
		}
	}

	/** Memo id index + reverse link map, shared by every card in this render. */
	private buildRefContext(state: MemosState): RefContext {
		const byId = new Map<string, Memo>();
		for (const m of state.memos) byId.set(m.id, m);
		const inlinks = new Map<string, Memo[]>();
		for (const m of state.memos) {
			for (const link of m.links) {
				const id = memoRefId(link);
				if (!id || id === m.id || !byId.has(id)) continue;
				const arr = inlinks.get(id);
				if (arr) arr.push(m);
				else inlinks.set(id, [m]);
			}
		}
		return {
			byId,
			inlinks,
			onNavigate: (memo) => this.callbacks.onNavigate(memo),
		};
	}

	/**
	 * Scroll a memo's card into view and flash it. Returns false when the card
	 * isn't in the current (filtered) list, so the caller can fall back to
	 * opening the canvas node directly.
	 */
	async scrollToMemo(id: string): Promise<boolean> {
		const ctx = this.lastCtx;
		const idx = this.memos.findIndex((m) => m.id === id);
		if (idx < 0) return false;
		if (idx >= this.renderedCount && !this.allRendered && ctx) {
			await this.renderMore(this.renderToken, ctx, idx);
			await this.yieldFrame();
			await this.yieldFrame();
		}
		const el = this.listEl.querySelector<HTMLElement>(
			`.memos-card[data-memo-id="${id}"]`,
		);
		if (!el) return false;
		// Guard: poll offsetHeight until layout settles (bulk-inserted cards
		// may not have final dimensions even after yieldFrame).
		for (let retry = 0; retry < 5 && el.offsetHeight === 0; retry++) {
			await this.yieldFrame();
		}
		await scrollCardIntoList(this.listEl, el, 'auto');
		el.classList.remove('memos-card-flash');
		// Force reflow so the flash animation restarts on repeat navigation.
		void el.offsetWidth;
		el.classList.add('memos-card-flash');
		return true;
	}

	/**
	 * Open the inline editor on a memo's card in the current list (desktop
	 * jump-to-edit via Shift+Enter on a ref). Returns false when the card
	 * isn't rendered (filtered out), so the caller can fall back to opening
	 * the canvas node.
	 */
	async editMemo(id: string): Promise<boolean> {
		const ctx = this.lastCtx;
		const memo = ctx?.byId.get(id);
		if (!memo || !ctx) return false;
		const idx = this.memos.findIndex((m) => m.id === id);
		if (idx >= this.renderedCount && !this.allRendered) {
			await this.renderMore(this.renderToken, ctx, idx);
		}
		const el = this.listEl.querySelector<HTMLElement>(
			`.memos-card[data-memo-id="${id}"]`,
		);
		if (!el) return false;
		void this.cardRenderer.startInlineEdit(el, memo, this.callbacks, ctx);
		return true;
	}

	/** Programmatic jump: scroll the list back to the top (first card). */
	scrollToTop(): void {
		scrollListToTop(this.listEl);
	}

	private renderEmpty(state: MemosState): void {
		const el = this.listEl.createDiv({ cls: 'memos-empty' });
		el.createDiv({ cls: 'memos-empty-icon', text: '💭' });
		if (state.keyword || state.filterQuery) {
			el.createDiv({
				cls: 'memos-empty-text',
				text: 'No memos match your search.',
			});
		} else if (state.activeTag) {
			el.createDiv({
				cls: 'memos-empty-text',
				text: `No memos tagged #${state.activeTag}`,
			});
			el.createDiv({
				cls: 'memos-empty-hint',
				text: 'Click "All memos" to see everything.',
			});
		} else if (state.viewMode === 'starred') {
			el.createDiv({ cls: 'memos-empty-text', text: '还没有星标任何 memo' });
			el.createDiv({
				cls: 'memos-empty-hint',
				text: '在卡片的 ⋯ 菜单中选择「星标」即可收藏到这里。星标不影响排序，想让 memo 置顶请用「置顶」。',
			});
		} else if (state.viewMode === 'archived') {
			el.createDiv({ cls: 'memos-empty-text', text: 'No archived memos.' });
		} else {
			el.createDiv({ cls: 'memos-empty-text', text: 'No memos yet.' });
			el.createDiv({
				cls: 'memos-empty-hint',
				text: 'Share a thought above to get started.',
			});
		}
	}

	destroy(): void {
		this.resizeObs?.disconnect();
		this.cardRenderer.destroy();
	}
}
