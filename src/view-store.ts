import { evalFilter, parseFilter } from './filter';
import type { MemosStore } from './store';
import type { Memo, MemosState, ViewMode } from './types';

type Listener = (state: MemosState) => void;

/**
 * Per-view navigation state layered over the shared data store.
 *
 * The plugin keeps ONE MemosStore holding the memo DATA — shared, so every
 * open view sees the same notes and stays in sync on any edit. Each MemosView
 * additionally owns a ViewStore that holds its OWN navigation (active tab,
 * tag / date / keyword / structured filter, collapsed dates) and derives its
 * own filteredMemos from the shared memos. Two views therefore browse
 * independently — the sidebar can sit on 全部 while the main pane shows 归档 —
 * yet both always reflect the same underlying notes.
 *
 * Data flows one way: MemosStore → ViewStore (via the subscription set up in
 * the constructor). A ViewStore never writes back to the shared store; memo
 * mutations go through the writer + plugin.reloadMemos(), which updates the
 * shared store and fans out to every ViewStore.
 */
export class ViewStore {
	private state: MemosState;
	private listeners = new Set<Listener>();
	private readonly unsubData: () => void;

	constructor(private data: MemosStore) {
		this.state = {
			memos: data.get().memos,
			filteredMemos: [],
			activeTag: null,
			activeDate: null,
			keyword: '',
			filterQuery: '',
			viewMode: 'timeline',
			isLoading: data.get().isLoading,
			collapsedDates: new Set(),
		};
		this.state.filteredMemos = this.deriveFiltered();
		// Memo edits (from this or any other view) re-flow here: recompute our
		// filtered list against the fresh memos and re-render this view.
		this.unsubData = data.subscribe(() => this.onDataChanged());
	}

	private onDataChanged(): void {
		const d = this.data.get();
		this.state.memos = d.memos;
		this.state.isLoading = d.isLoading;
		this.state.filteredMemos = this.deriveFiltered();
		this.notify();
	}

	get(): MemosState {
		return this.state;
	}

	/** Apply a navigation change. `memos` / `isLoading` are owned by the
	 * shared store and are ignored here — they only arrive via onDataChanged. */
	update(partial: Partial<MemosState>): void {
		this.state = { ...this.state, ...partial };
		if (
			partial.activeTag !== undefined ||
			partial.activeDate !== undefined ||
			partial.keyword !== undefined ||
			partial.filterQuery !== undefined ||
			partial.viewMode !== undefined
		) {
			this.state.filteredMemos = this.deriveFiltered();
		}
		this.notify();
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Detach from the shared store (view closed) — stops the re-flow and
	 * drops listeners so this state can be garbage-collected. */
	destroy(): void {
		this.unsubData();
		this.listeners.clear();
	}

	/** Frame/counts memoization: the sidebar widgets (tag tree, heatmap)
	 * ask for these on EVERY view-store notification — keystrokes, date
	 * clicks, tag clicks — but the aggregates only change when the memo
	 * DATA or the base viewMode changes. Cache keyed on the memos array
	 * reference + viewMode, so unchanged navigation re-renders read O(1)
	 * instead of re-filtering/counting all memos 3× per notification. */
	private frameSrcRef: Memo[] | null = null;
	private frameMode = '';
	private frameCache: Memo[] = [];
	private tagCountsCache: { frame: Memo[]; map: Map<string, number> } | null =
		null;
	private dateCountsCache: { frame: Memo[]; map: Map<string, number> } | null =
		null;

	getTagCounts(): Map<string, number> {
		const frame = this.frameMemos();
		if (this.tagCountsCache?.frame === frame) return this.tagCountsCache.map;
		const counts = new Map<string, number>();
		for (const memo of frame) {
			for (const tag of memo.tags) {
				counts.set(tag, (counts.get(tag) || 0) + 1);
			}
		}
		this.tagCountsCache = { frame, map: counts };
		return counts;
	}

	getDateCounts(): Map<string, number> {
		const frame = this.frameMemos();
		if (this.dateCountsCache?.frame === frame) return this.dateCountsCache.map;
		const counts = new Map<string, number>();
		for (const memo of frame) {
			counts.set(memo.date, (counts.get(memo.date) || 0) + 1);
		}
		this.dateCountsCache = { frame, map: counts };
		return counts;
	}

	/** Memos inside the current base frame (Memos / 归档 / 星标) IGNORING
	 * tag / date / keyword / structured constraints — the sidebar widgets
	 * (heatmap density, tag counts, totals) aggregate over the frame so a
	 * date or tag clicked inside 归档/星标 only ever surfaces memos that
	 * actually exist there. */
	frameMemos(): Memo[] {
		if (
			this.frameSrcRef === this.state.memos &&
			this.frameMode === this.state.viewMode
		) {
			return this.frameCache;
		}
		this.frameSrcRef = this.state.memos;
		this.frameMode = this.state.viewMode;
		const mode = this.state.viewMode;
		let list: Memo[];
		if (mode === 'starred') {
			list = this.state.memos.filter((m) => m.starred);
		} else if (mode === 'archived') {
			list = this.state.memos.filter((m) => m.archived);
		} else {
			list = this.state.memos.filter((m) => !m.archived);
		}
		this.frameCache = list;
		// Frame identity is the counts' cache key — a fresh frame voids them.
		this.tagCountsCache = null;
		this.dateCountsCache = null;
		return list;
	}

	private notifyPending = false;

	private notify(): void {
		// Coalesce into one microtask: a data re-flow plus a navigation
		// update (or several rapid updates) would each run a full render
		// cycle in every subscriber otherwise. State mutation above stays
		// synchronous — get() always returns the fresh state — only
		// listener delivery is deferred, and destroy() empties `listeners`
		// before a pending flush can fire on a dead view.
		if (this.notifyPending) return;
		this.notifyPending = true;
		queueMicrotask(() => {
			this.notifyPending = false;
			for (const listener of this.listeners) listener(this.state);
		});
	}

	private deriveFiltered(): Memo[] {
		let list = this.state.memos;
		const mode: ViewMode = this.state.viewMode;

		if (mode === 'starred') {
			list = list.filter((m) => m.starred);
		} else if (mode === 'archived') {
			list = list.filter((m) => m.archived);
		} else {
			list = list.filter((m) => !m.archived);
		}

		if (this.state.activeTag) {
			const tag = this.state.activeTag.toLowerCase();
			list = list.filter((m) =>
				m.tags.some((t) => t === tag || t.startsWith(tag + '/')),
			);
		}

		if (this.state.activeDate) {
			list = list.filter((m) => m.date === this.state.activeDate);
		}

		const kw = this.state.keyword.trim().toLowerCase();
		if (kw) {
			// Plain substring search across content, tags and comments
			// (same fields the filter engine's keyword condition matches).
			list = list.filter(
				(m) =>
					m.content.toLowerCase().includes(kw) ||
					m.tags.some((t) => t.includes(kw)) ||
					m.comments.some((c) => c.content.toLowerCase().includes(kw)),
			);
		}

		if (this.state.filterQuery.trim()) {
			// Structured filter from the visual builder / saved entries:
			// #tags, time ranges and keywords with AND / OR / NOT
			// (parseFilter never throws).
			const { ast } = parseFilter(this.state.filterQuery);
			if (ast) {
				list = list.filter((m) => evalFilter(ast, m));
			}
		}

		return [...list].sort((a, b) => {
			// Pinned = 置顶: floats to the top of every list. Starred memos do
			// NOT — starring only collects them into the 星标 view.
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			// Newer ids (YYYYMMDDHHmmSSSS) sort lexicographically descending
			return b.id.localeCompare(a.id);
		});
	}
}
