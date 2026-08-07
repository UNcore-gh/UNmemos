export interface SavedFilter {
	name: string;
	query: string;
}

export interface MemosSettings {
	/** Settings UI + command language ('zh' | 'en'). */
	language: 'zh' | 'en';
	/** Accent color (hex) for buttons, tag highlights, heatmap, etc.
	 *  Published on <body> as --memos-accent* (see src/color.ts). */
	accentColor: string;
	storagePath: string;
	/** Kept for migration / display only. */
	dateFormat: string;
	/** Kept for migration / display only. */
	timeFormat: string;
	showHeatmap: boolean;
	showTags: boolean;
	defaultTag: string;
	focusOnOpen: boolean;
	/** Enable `@` mention / `@@` quick-create in ALL Obsidian editors —
	 * regular notes (source & live preview) and canvas text nodes — not
	 * just the Memos composer. Checked live on every keystroke, so flipping
	 * it in settings takes effect without a reload. */
	globalMention: boolean;
	/** Show Obsidian's native mobile quick-edit toolbar (formatting buttons)
	 * above the keyboard. On iPad it appears with a ~2s delay and can cause
	 * overheating, so it defaults to off on mobile; users who want it can
	 * re-enable. When off, the composer is never claimed as the active editor. */
	mobileToolbar: boolean;
	hotkeyOpen: string;
	hotkeyNew: string;
	sidebarWidth: number;
	sidebarHidden: boolean;
	sidebarPosition: 'left' | 'right';
	pinnedTags: string[];
	/** Named filter queries pinned in the sidebar (flomo-style shortcuts). */
	savedFilters: SavedFilter[];
	/** Recently searched keywords — suggestions for the filter panel's
	 * 内容 condition field (most recent first, capped at 12). */
	recentSearches: string[];
	/** Tags recently used for filtering — suggestions for the filter
	 * panel's 标签 condition field (most recent first, capped at 12). */
	recentFilterTags: string[];
	/** Days an archived memo is kept before automatic deletion. 0 = never
	 * (archived memos live forever unless deleted by hand) — the default. */
	archiveRetentionDays: number;
	/** Opt-in in-memory debug log (src/logger.ts). Off = fully silent and
	 * zero capture; on = diagnostics land in a ring buffer the user can
	 * export from the settings tab and send to the developer. */
	debugLog: boolean;
	/** Legacy one-shot flag: callout → heading format. Superseded by canvas. */
	migratedToHeadings?: boolean;
	/** One-shot migration flag: markdown storage → canvas storage. */
	migratedToCanvas?: boolean;
	/** Runtime state (not shown in the settings tab): unsent composer text,
	 * persisted so closing/reopening the view doesn't lose a half-typed memo. */
	composerDraft?: string;
}

export const DEFAULT_SETTINGS: MemosSettings = {
	language: 'zh',
	accentColor: '#07c160',
	storagePath: 'Memos/{year}.canvas',
	dateFormat: 'YYYY-MM-DD',
	timeFormat: 'HH:mm:ss',
	showHeatmap: true,
	showTags: true,
	defaultTag: '',
	focusOnOpen: true,
	globalMention: true,
	mobileToolbar: false,
	hotkeyOpen: 'Mod+Shift+M',
	hotkeyNew: 'Mod+Shift+N',
	sidebarWidth: 260,
	sidebarHidden: false,
	sidebarPosition: 'right',
	pinnedTags: [],
	savedFilters: [],
	recentSearches: [],
	recentFilterTags: [],
	archiveRetentionDays: 0,
	debugLog: false,
	migratedToHeadings: false,
	migratedToCanvas: false,
};
