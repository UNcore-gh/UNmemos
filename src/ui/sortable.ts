/* Pointer-Events based drag-to-reorder for sidebar row lists, entered by
 * a long-press ("pick up") instead of a dedicated drag handle.
 *
 * HTML5 drag-and-drop does not exist on iOS, so this uses the Pointer
 * Events API uniformly for mouse / touch / pen. Design constraints:
 *
 * - Rows are re-rendered (destroyed and rebuilt) on store updates, so
 *   all listeners live on the LONG-LIVED container via delegation —
 *   never on rows. Sessions abort cleanly if the dragged row is torn
 *   down mid-drag (isConnected check) or the system cancels the pointer
 *   (e.g. native scroll taking over before we arm).
 *
 * - Entry is a long-press: pointerdown starts a short hold timer. Hold
 *   still for HOLD_MS and the row "lifts" (armed style + a light haptic)
 *   and dragging begins. Move more than a few px before the hold
 *   completes and we back off, treating it as a scroll or a click — so
 *   a quick tap still selects the row and a swipe still scrolls the
 *   sidebar. There is intentionally no grip icon: the whole row is the
 *   handle once picked up.
 *
 * - On touch, native scrolling keeps working right up to the moment we
 *   arm: a non-passive document touchmove listener preventDefaults ONLY
 *   once armed. A still finger never starts a scroll, so a completed
 *   long-press is never stolen by the browser; a swipe before arming
 *   starts native scrolling and its pointercancel ends the pending
 *   session — exactly the desired behaviour.
 *
 * - Reordering happens LIVE during the drag: the item whose vertical
 *   centre is nearest the pointer wins, and the dragged row slots in
 *   above or below it by reading the pointer against that item's own
 *   mid-line (lists are single-column, so a vertical test is both
 *   correct and direction-symmetric). Insertion is clamped to the
 *   matched block so a row can never escape its section. The final
 *   order is read back from the DOM on drop.
 *
 * - Clicks: a quick (never-armed) tap passes through to select the row.
 *   Once armed we swallow the trailing click so a completed — or
 *   abandoned — drag never also toggles a filter or selects a tag.
 *
 * - Hold still vs. drag: picking a row up and releasing it WITHOUT ever
 *   moving is treated as a request for the row's edit menu, not a drag —
 *   `onLongPress` fires in that case (mutually exclusive with
 *   `onReorder`), so hold-to-edit and hold-then-drag-to-reorder share one
 *   gesture without colliding.
 */

export interface SortableOptions {
	/** Selector matching the reorderable rows within `container`. */
	itemSelector: string;
	/** Optional selector for spots inside a row that must NOT start a
	 * drag session (e.g. the row's ⋯ actions button on mobile). */
	ignoreSelector?: string;
	/** Called after a successful drop with the row's start and final
	 * index among the matched items. */
	onReorder: (from: number, to: number) => void;
	/** Called when a picked-up row is released WITHOUT having moved —
	 * the long-press asked for the row's edit menu, not a reorder.
	 * Mutually exclusive with onReorder for a given gesture. */
	onLongPress?: (row: HTMLElement, index: number) => void;
	/** Optional scroll container for edge auto-scroll during drag. */
	scrollContainer?: HTMLElement | null;
}

export interface SortableHandle {
	destroy(): void;
}

/** Long-press duration before the row lifts into drag mode. */
const HOLD_MS = 320;
/** Movement before arming that cancels the hold (= it's a scroll/click). */
const MOVE_CANCEL_PX = 8;
const EDGE_ZONE_PX = 40;
const EDGE_NUDGE_PX = 14;

export function attachSortable(
	container: HTMLElement,
	opts: SortableOptions,
): SortableHandle {
	let session: {
		pointerId: number;
		startX: number;
		startY: number;
		armed: boolean;
		moved: boolean;
		fromIndex: number;
		row: HTMLElement;
		holdTimer: number;
	} | null = null;

	const items = (): HTMLElement[] =>
		Array.from(container.querySelectorAll<HTMLElement>(opts.itemSelector));

	const onPointerDown = (e: PointerEvent) => {
		if (session || e.button !== 0) return;
		const target = e.target as HTMLElement | null;
		if (!target) return;
		if (opts.ignoreSelector && target.closest(opts.ignoreSelector)) return;
		const row = target.closest<HTMLElement>(opts.itemSelector);
		if (!row || !container.contains(row)) return;

		const index = items().indexOf(row);
		if (index < 0) return;

		session = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			armed: false,
			moved: false,
			fromIndex: index,
			row,
			holdTimer: window.setTimeout(arm, HOLD_MS),
		};

		document.addEventListener('pointermove', onPointerMove);
		document.addEventListener('pointerup', onPointerUp);
		document.addEventListener('pointercancel', onPointerCancel);
		// Only block native touch scrolling once armed (see onTouchMove);
		// suppress the Android long-press context menu during the gesture.
		document.addEventListener('touchmove', onTouchMove, { passive: false });
		document.addEventListener('contextmenu', onContextMenu, true);
	};

	/** The hold completed: lift the row into drag mode. */
	const arm = (): void => {
		const s = session;
		// The row may have been re-rendered away while we waited.
		if (!s || !s.row.isConnected) {
			abort();
			return;
		}
		s.armed = true;
		s.row.addClass('is-armed');
		if (navigator.vibrate) navigator.vibrate(8);
	};

	const onTouchMove = (e: TouchEvent): void => {
		if (session?.armed) e.preventDefault();
	};

	const onContextMenu = (e: Event): void => {
		// On Android a long-press also fires contextmenu; by then we've
		// armed as a drag, so suppress the menu (the ⋯ button covers
		// actions). Desktop right-click never starts a session, so its
		// context menu is unaffected.
		if (session) e.preventDefault();
	};

	const onPointerMove = (e: PointerEvent) => {
		const s = session;
		if (!s || e.pointerId !== s.pointerId) return;

		if (!s.armed) {
			// Still waiting on the hold: any real movement means this is a
			// scroll or a click, not a pick-up — back off.
			const dist = Math.hypot(e.clientX - s.startX, e.clientY - s.startY);
			if (dist >= MOVE_CANCEL_PX) {
				abort();
				return;
			}
			return;
		}

		// A re-render mid-drag destroys the row — abort cleanly.
		if (!s.row.isConnected) {
			abort();
			return;
		}
		e.preventDefault();

		if (!s.moved) {
			s.moved = true;
			s.row.addClass('is-dragging');
			document.body.addClass('memos-row-dragging');
		}

		autoScroll(e.clientY);

		// Live reorder among sibling items. Lists here are single-column,
		// so the winner is the item whose vertical centre is nearest, and
		// before/after reads the pointer against that item's own vertical
		// mid-line (a horizontal test is wrong for full-width rows).
		const list = items();
		let best: HTMLElement | null = null;
		let bestD = Infinity;
		for (const el of list) {
			if (el === s.row) continue;
			const r = el.getBoundingClientRect();
			const dy = Math.abs(e.clientY - (r.top + r.height / 2));
			if (dy < bestD) {
				bestD = dy;
				best = el;
			}
		}
		if (!best) return;
		const tr = best.getBoundingClientRect();
		const before = e.clientY < tr.top + tr.height / 2;
		// Target slot among the matched items (row excluded). Insertion
		// references the item at the slot — or, past the end, a position
		// resolved through the LAST matched item's own parent — so the row
		// can never escape the matched block. (A bare container.insertBefore
		// with a null ref would append to the container, which let pinned
		// tags drop below the normal tag tree.)
		const siblings = list.filter((el) => el !== s.row);
		const bestSlot = siblings.indexOf(best);
		if (bestSlot < 0) return;
		const slot = Math.max(
			0,
			Math.min(bestSlot + (before ? 0 : 1), siblings.length),
		);
		if (slot < siblings.length) {
			const ref = siblings[slot]!;
			if (s.row.nextSibling === ref) return; // already in the slot
			ref.parentNode?.insertBefore(s.row, ref);
		} else {
			const last = siblings[siblings.length - 1]!;
			if (last.nextSibling === s.row) return;
			last.parentNode?.insertBefore(s.row, last.nextSibling);
		}
	};

	const onPointerUp = (e: PointerEvent) => {
		const s = session;
		if (!s || e.pointerId !== s.pointerId) return;
		window.clearTimeout(s.holdTimer);
		if (s.armed) {
			// A picked-up row never also "clicks" — even if released without
			// moving, the long-press itself was the intent, not a selection.
			const to = items().indexOf(s.row);
			cleanupVisual(s.row);
			detachDocListeners();
			session = null;
			if (s.moved && to >= 0 && to !== s.fromIndex) {
				opts.onReorder(s.fromIndex, to);
			} else if (!s.moved) {
				// Held still the whole time: the hold asked for the row's
				// edit menu, anchored to where the row sits.
				opts.onLongPress?.(s.row, s.fromIndex);
			}
			suppressClick();
		} else {
			// Quick tap: never armed, let the click select the row.
			detachDocListeners();
			session = null;
		}
	};

	const onPointerCancel = (e: PointerEvent) => {
		const s = session;
		if (!s || e.pointerId !== s.pointerId) return;
		abort();
	};

	const abort = () => {
		const s = session;
		if (s) {
			window.clearTimeout(s.holdTimer);
			cleanupVisual(s.row);
		}
		detachDocListeners();
		session = null;
	};

	const cleanupVisual = (row: HTMLElement) => {
		row.removeClass('is-armed');
		row.removeClass('is-dragging');
		document.body.removeClass('memos-row-dragging');
	};

	const detachDocListeners = () => {
		document.removeEventListener('pointermove', onPointerMove);
		document.removeEventListener('pointerup', onPointerUp);
		document.removeEventListener('pointercancel', onPointerCancel);
		document.removeEventListener('touchmove', onTouchMove);
		document.removeEventListener('contextmenu', onContextMenu, true);
	};

	/** After an armed session the browser still fires `click` on the row —
	 * swallow exactly one so the drop doesn't also apply a filter or
	 * select a tag. */
	const suppressClick = () => {
		const swallow = (e: Event) => {
			e.stopPropagation();
			e.preventDefault();
			container.removeEventListener('click', swallow, true);
		};
		container.addEventListener('click', swallow, true);
		// Safety net: never leave the suppressor armed.
		window.setTimeout(
			() => container.removeEventListener('click', swallow, true),
			300,
		);
	};

	const autoScroll = (y: number) => {
		const sc = opts.scrollContainer;
		if (!sc || !sc.isConnected) return;
		const rect = sc.getBoundingClientRect();
		if (y < rect.top + EDGE_ZONE_PX) {
			sc.scrollTop -= EDGE_NUDGE_PX;
		} else if (y > rect.bottom - EDGE_ZONE_PX) {
			sc.scrollTop += EDGE_NUDGE_PX;
		}
	};

	container.addEventListener('pointerdown', onPointerDown);

	return {
		destroy() {
			abort();
			container.removeEventListener('pointerdown', onPointerDown);
		},
	};
}
