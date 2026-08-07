export interface MemoComment {
	id: string;
	time: string;
	content: string;
}

export interface Memo {
	/** Unique id = canvas node id, e.g. "2026072601370000" */
	id: string;
	/** Calendar date YYYY-MM-DD (derived from id for filtering/heatmap) */
	date: string;
	/** Month MM (derived from id) */
	month: string;
	/** Same as id — kept for compatibility with old "time" field usage */
	time: string;
	content: string;
	updatedAt: string;
	/** Vault-relative path of the .canvas file holding this memo. */
	sourceFile: string;
	/** Kept for interface compatibility; not meaningful for canvas nodes. */
	lineStart: number;
	lineEnd?: number;
	pinned: boolean;
	/** Starred = collectible into the sidebar 星标 view. Unlike `pinned`,
	 * it does NOT sort the memo to the top of the list. */
	starred: boolean;
	archived: boolean;
	/** When the memo was (last) archived — ISO timestamp, present only while
	 * `archived`. Drives the auto-delete retention setting. Legacy archived
	 * memos (archived before this field existed) have none and are never
	 * auto-deleted. */
	archivedAt?: string;
	tags: string[];
	links: string[];
	reactions: string[];
	comments: MemoComment[];
}

export type ViewMode = 'timeline' | 'archived' | 'starred';

export interface MemosState {
	memos: Memo[];
	filteredMemos: Memo[];
	activeTag: string | null;
	activeDate: string | null;
	/** Plain keyword search (search box): substring match over content,
	 * tags and comments. */
	keyword: string;
	/** Structured filter produced by the visual builder / saved entries.
	 * Serialized to the internal filter syntax and evaluated by filter.ts —
	 * never edited as text by the user. Combined with `keyword` via AND. */
	filterQuery: string;
	viewMode: ViewMode;
	isLoading: boolean;
	collapsedDates: Set<string>;
}

export interface MemoMeta {
	id: string | null;
	updatedAt: string | null;
	pinned: boolean;
	starred: boolean;
	archived: boolean;
	archivedAt: string | null;
}

export interface BuildMemoOptions {
	id: string;
	content: string;
	updatedAt: string;
	pinned?: boolean;
	starred?: boolean;
	archived?: boolean;
	archivedAt?: string;
}
