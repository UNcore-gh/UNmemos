import {
	ItemView,
	Notice,
	Platform,
	setIcon,
	WorkspaceLeaf,
	WorkspaceParent,
} from 'obsidian';
import type MemosPlugin from '../main';
import { ViewStore } from '../view-store';
import { MemoEditor } from './editor';
import { MemoList } from './list';
import { TagSidebar } from './sidebar';
import { Heatmap } from './heatmap';
import { FilterPanelController } from './filter-panel';
import { attachSortable, type SortableHandle } from './sortable';
import { safeSetActiveLeaf } from './editor-graft';
import { cssProps } from '../css-props';
import { renameTagInContent, removeTagFromContent } from '../parser';
import { evalFilter, parseFilter } from '../filter';
import * as logger from '../logger';
import type { SavedFilter } from '../settings';
import type { Memo, MemosState, ViewMode } from '../types';

export const VIEW_TYPE = 'memos-for-obsidian-view';
export const VIEW_NAME = 'Memos';
export const VIEW_ICON = 'message-square';

/** Log a workspace.revealLeaf failure once per session — the patched reveal
 * must stay swallowed (commands must not break on it), but it used to fail
 * SILENTLY on mobile, making "the command did nothing" undiagnosable. */
let warnedRevealFailure = false;

export class MemosView extends ItemView {
	plugin: MemosPlugin;
	/** Per-view navigation state (tab / tag / date / keyword / filter) over
	 * the shared memo data — so multiple views browse independently. */
	private viewStore: ViewStore;
	private editor: MemoEditor;
	private memoList: MemoList;
	private tagSidebar: TagSidebar;
	private heatmap: Heatmap;
	private unsubscribes: Array<() => void> = [];
	private navItems: Array<{ el: HTMLElement; id: string }> = [];
	mainEl!: HTMLElement;
	sidebarEl!: HTMLElement;
	resizerEl!: HTMLElement;
	private sidebarHideBtn!: HTMLElement;
	private sidebarFloatBtn!: HTMLElement;
	private backdropEl!: HTMLElement;
	private drawerBtn!: HTMLElement;
	private drawerOpen = false;
	/** True while the view sits in a narrow container (docked into an
	 * Obsidian side dock). The internal sidebar then behaves like the
	 * phone drawer — floating over the feed under a backdrop — so the
	 * feed isn't crushed into an unusable strip and the editor's panel
	 * toggle stays reachable. Driven by a ResizeObserver. */
	private compact = false;
	private resizeObs: ResizeObserver | null = null;
	/** Last editor-refresh timestamp (throttles the RO callback; see below). */
	private lastRefreshAt = 0;
	/** Re-show detector: fires when the container transitions hidden→visible
	 * (sidebar tab switch, dock/un-dock) even at a constant size, where the
	 * ResizeObserver may not fire. Triggers the same editor recovery as the RO. */
	private visObs: IntersectionObserver | null = null;
	private searchEl!: HTMLElement;
	private searchInput!: HTMLInputElement;
	/** Funnel button beside the search box — opens the filter builder,
	 * seeding any pending search keyword as a condition row. */
	private filterBtnEl!: HTMLElement;
	private filterSectionEl!: HTMLElement;
	private filterChipsEl!: HTMLElement;
	/** Floating/inline filter builder next to the search box. Created in
	 * onOpen once the anchor elements exist; null between open/close. */
	private filterPanel: FilterPanelController | null = null;
	/** Drag-to-reorder for saved-filter rows (delegated on filterChipsEl). */
	private filterSortable: SortableHandle | null = null;
	/** Gates re-rendering the saved-filter list; bumped on every mutation. */
	private savedFiltersRev = 0;
	/** Bumped when the memo set changes, so per-filter match counts refresh. */
	private filterCountRev = 0;
	private lastMemosRef: Memo[] | null = null;
	private filterCountCache = new Map<string, number>();
	private lastChipsKey = '';
	private navItemCounts = new Map<string, HTMLElement>();
	/** Filter entry whose row anchors the builder panel (调整条件 flow);
	 * cleared when the panel closes. The list re-renders rows on every
	 * relevant store update, so renderFilterList re-points the panel at
	 * the surviving entry's fresh row. */
	private panelAnchorFilter: SavedFilter | null = null;
	/** The ⋯ button whose filter menu is currently open — a second tap on
	 * the same button toggles the menu closed instead of reopening it. */
	private filterMenuMore: HTMLElement | null = null;
	private filterMenuEl: HTMLElement | null = null;
	private closeFilterMenu: (() => void) | null = null;
	/** Suggestion dropdown under the search box — body-mounted popover
	 * combining 联想 (substring matches over past searches + vault tags)
	 * with 最近 entries. Mirrors the filter panel's value-field dropdown. */
	private searchSuggestEl: HTMLElement | null = null;
	/** Keyword store updates are debounced — each keystroke otherwise
	 * re-derives the filter and re-renders the entire card list. */
	private searchDebounce: number | null = null;
	private searchSuggestItems: HTMLElement[] = [];
	private searchSuggestActive = -1;
	/** Pending search-suggest open while the compact drawer is still
	 * sliding in — the body-mounted popover would otherwise anchor to the
	 * drawer's pre-transition off-screen position. */
	private drawerSettleTimer: number | null = null;
	private searchSuggestPending = false;
	/** False from the moment the drawer starts sliding in until it has
	 * settled — search suggestions must not anchor mid-transition. */
	private drawerSettled = true;

	static SIDEBAR_MIN_W = 200;
	static SIDEBAR_MAX_W = 480;

	constructor(leaf: WorkspaceLeaf, plugin: MemosPlugin) {
		super(leaf);
		this.navigation = false;
		this.plugin = plugin;
		this.viewStore = new ViewStore(this.plugin.store);

		this.editor = new MemoEditor(this.app, {
			onSave: async (content) => {
				let text = content;
				if (this.plugin.settings.defaultTag) {
					const tag = this.plugin.settings.defaultTag.trim();
					if (tag && !text.includes('#' + tag)) text += `\n#${tag}`;
				}
				await this.plugin.writer.insertMemo(text);
				await this.plugin.reloadMemos();
			},
			// Touch edit flow: the composer saves an existing memo (see
			// MemoEditor.startEdit). Wired here so Edit→composer works on mobile.
			onEditSave: async (memo, content) => {
				await this.plugin.writer.updateMemo(memo, content);
				await this.plugin.reloadMemos();
			},
			onOpenSidebar: () => {
				if (this.isDrawerMode()) this.openDrawer();
				else this.toggleSidebar();
			},
			onSearch: () => this.focusSearch(),
			getMemos: () => this.viewStore.get().memos,
			getDraft: () => this.plugin.settings.composerDraft ?? '',
			setDraft: (text) => {
				this.plugin.settings.composerDraft = text;
				return this.plugin.saveSettings();
			},
			onCreateMemo: () => this.createBlankMemo(),
			onRefOpen: (id) => void this.editMemoById(id),
			// 移动端快速编辑栏：默认关闭（iPad 上 2s 延迟 + 发热），用户可在设置开启。
			// getter 形式让开关实时生效（下次聚焦即应用）。
			showMobileToolbar: () => this.plugin.settings.mobileToolbar,
			onScrollToTop: () => this.memoList.scrollToTop(),
		});

		this.memoList = new MemoList(this.app, {
			onTagClick: (tag) => {
				this.pushRecentTag(tag);
				this.viewStore.update({ activeTag: tag });
			},
			onDateToggle: (date) => {
				const set = new Set(this.viewStore.get().collapsedDates);
				if (set.has(date)) set.delete(date);
				else set.add(date);
				this.viewStore.update({ collapsedDates: set });
			},
			onEdit: async (memo, content) => {
				await this.plugin.writer.updateMemo(memo, content);
				await this.plugin.reloadMemos();
			},
			onEditRequest: (memo) => {
				// iPad/phone: edit in the composer (above the feed) rather than
				// in-card, where the soft keyboard would cover the editor.
				this.editor.startEdit(memo);
			},
			onCreateMemo: () => this.createBlankMemo(),
			onRefOpen: (id) => void this.editMemoById(id),
			onDelete: async (memo) => {
				await this.plugin.writer.deleteMemo(memo);
				await this.plugin.reloadMemos();
			},
			onPin: async (memo) => {
				await this.plugin.writer.togglePin(memo);
				await this.plugin.reloadMemos();
			},
			onStar: async (memo) => {
				await this.plugin.writer.toggleStar(memo);
				await this.plugin.reloadMemos();
			},
			onArchive: async (memo) => {
				await this.plugin.writer.toggleArchive(memo);
				await this.plugin.reloadMemos();
			},
			onNavigate: (memo) => {
				// Prefer staying in the feed (scroll + flash); fall back to
				// opening the canvas node when the target is filtered out.
				// scrollToMemo renders up to a far target first (virtualized).
				void (async () => {
					if (!(await this.memoList.scrollToMemo(memo.id))) {
						void this.app.workspace.openLinkText(
							`${memo.sourceFile}#${memo.id}`,
							'',
							true,
						);
					}
				})();
			},
			onScrollChange: (down) => this.editor.setScrollDown(down),
		});

		this.tagSidebar = new TagSidebar(this.app, {
			onTagClick: (tag) => {
				this.pushRecentTag(tag);
				this.viewStore.update({ activeTag: tag });
				this.closeDrawerIfPhone();
			},
			onPinTag: (tag) => this.togglePinTag(tag),
			onRenameTag: (from, to) => void this.renameTag(from, to),
			onDeleteTag: (tag) => void this.deleteTag(tag),
			// Drag-reordered pinned tags arrive as the new order of VISIBLE
			// tags (count-0 pinned tags stay hidden), so remap by name into
			// the settings array rather than by index.
			onReorderPinned: (visibleOrder) => {
				let vi = 0;
				this.plugin.settings.pinnedTags = this.plugin.settings.pinnedTags.map(
					(t) => (visibleOrder.includes(t) ? (visibleOrder[vi++] ?? t) : t),
				);
				void this.plugin.saveSettings();
				this.refreshTagSidebar();
			},
		});

		this.heatmap = new Heatmap((date) => {
			this.viewStore.update({ activeDate: date });
			this.closeDrawerIfPhone();
		});
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return VIEW_NAME;
	}

	getIcon(): string {
		return VIEW_ICON;
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('memos-view');
		if (Platform.isMobile) root.addClass('memos-is-mobile');
		if (this.isPhone()) root.addClass('memos-is-phone');

		const main = root.createDiv({ cls: 'memos-main' });
		this.mainEl = main;
		const feed = main.createDiv({ cls: 'memos-feed' });
		const header = feed.createDiv({ cls: 'memos-feed-header' });

		const headerLeft = header.createDiv({ cls: 'memos-feed-header-left' });
		const drawerBtn = headerLeft.createDiv({ cls: 'memos-drawer-btn' });
		setIcon(drawerBtn, 'menu');
		drawerBtn.setAttribute('aria-label', 'Open sidebar');
		drawerBtn.setAttribute('title', 'Open sidebar');
		drawerBtn.addEventListener('click', () => this.openDrawer());
		this.drawerBtn = drawerBtn;
		headerLeft.createEl('h2', { text: 'Memos' });
		header.createDiv({ cls: 'memos-header-actions' });

		this.editor.build(feed);

		// The active-filter chips sit BELOW the composer: above it they
		// read like a second toolbar competing with the editor.
		const filterBar = feed.createDiv({ cls: 'memos-active-filter' });
		filterBar.addClass('is-hidden');

		this.memoList.build(feed);

		const resizer = root.createDiv({ cls: 'memos-sidebar-resizer' });
		this.resizerEl = resizer;
		const sidebar = root.createDiv({ cls: 'memos-sidebar' });
		this.sidebarEl = sidebar;

		const backdrop = root.createDiv({ cls: 'memos-drawer-backdrop' });
		backdrop.addEventListener('click', () => this.closeDrawer());
		this.backdropEl = backdrop;

		const floatBtn = root.createDiv({ cls: 'memos-sidebar-float-btn' });
		floatBtn.setAttribute('aria-label', 'Show sidebar');
		floatBtn.setAttribute('title', 'Show sidebar');
		floatBtn.addEventListener('click', () => {
			if (this.isDrawerMode()) this.openDrawer();
			else this.toggleSidebar();
		});
		this.sidebarFloatBtn = floatBtn;

		const hideBtn = sidebar
			.createDiv({ cls: 'memos-sidebar-topbar' })
			.createDiv({ cls: 'memos-sidebar-hide-btn' });
		hideBtn.setAttribute('aria-label', 'Hide sidebar');
		hideBtn.setAttribute('title', 'Hide sidebar');
		hideBtn.addEventListener('click', () => {
			if (this.isDrawerMode()) this.closeDrawer();
			else this.toggleSidebar();
		});
		this.sidebarHideBtn = hideBtn;

		// Search row: keyword input with the bookmark + funnel icons inside
		// its right edge (flomo-style). The funnel toggles the filter
		// builder panel, which opens below this row.
		const search = sidebar.createDiv({ cls: 'memos-search' });
		this.searchEl = search;
		this.searchInput = search.createEl('input', {
			cls: 'memos-search-input',
			type: 'text',
			attr: {
				spellcheck: 'false',
			},
		});
		// Decorative magnifier lives INSIDE the input (positioned against
		// it) so it paints above the input's own background/border with no
		// z-index juggling. pointer-events:none keeps the caret/text free.
		const searchIcon = this.searchInput.createSpan({ cls: 'memos-search-icon' });
		setIcon(searchIcon, 'search');
		this.searchInput.addEventListener('input', () => {
			this.onSearchInput(this.searchInput.value);
		});
		// Focus opens the suggestion dropdown (「最近」 when empty, 联想 +
		// 最近 while typing); blur closes it — item clicks preventDefault on
		// mousedown, so picking never trips this.
		this.searchInput.addEventListener('focus', () => this.openSearchSuggest());
		this.searchInput.addEventListener('blur', () => this.closeSearchSuggest());
		// Scrolling the sidebar moves the search row out from under the
		// body-mounted popover — drop it instead of leaving it adrift.
		sidebar.addEventListener('scroll', () => this.closeSearchSuggest());
		// Enter commits the keyword into the recent-searches list (the
		// filter panel's content field suggests from it). With the suggest
		// dropdown open, arrows navigate it, Enter picks the highlighted
		// item, Escape dismisses it.
		this.searchInput.addEventListener('keydown', (e) => {
			if (this.searchSuggestEl) {
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					const n = this.searchSuggestItems.length;
					if (n === 0) return;
					const dir = e.key === 'ArrowDown' ? 1 : -1;
					this.setSearchSuggestActive(
						(this.searchSuggestActive + dir + n) % n,
					);
					return;
				}
				if (e.key === 'Enter') {
					const active = this.searchSuggestItems[this.searchSuggestActive];
					if (active) {
						e.preventDefault();
						active.click();
						return;
					}
				}
				if (e.key === 'Escape') {
					e.stopPropagation();
					this.closeSearchSuggest();
					return;
				}
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				this.openSearchSuggest();
				return;
			}
			if (e.key === 'Enter') this.pushRecentKeyword(this.searchInput.value);
		});

		// Right-aligned toolbar button group (the search row's "bottom-
		// right buttons"). Real, vertically-centred icon buttons — not
		// absolute overlays inside the input — so they always align with
		// the input regardless of its height. The funnel alone carries the
		// filter flow: with a keyword typed, it seeds that keyword into the
		// builder as a condition row (the old bookmark button's job).
		const searchActions = search.createDiv({ cls: 'memos-search-actions' });

		this.filterBtnEl = searchActions.createEl('button', {
			cls: 'memos-filter-btn',
			attr: { 'aria-label': 'Filters', title: '筛选器' },
		});
		setIcon(this.filterBtnEl, 'filter');
		this.filterBtnEl.addEventListener('click', () => this.toggleFilterPanel());

		if (this.plugin.settings.showHeatmap) this.heatmap.build(sidebar);

		const nav = sidebar.createDiv({ cls: 'memos-sidebar-nav' });
		const navDefs: Array<{ id: ViewMode; label: string; icon: string }> = [
			{ id: 'timeline', label: 'Memos', icon: 'home' },
			{ id: 'archived', label: 'Archived', icon: 'archive' },
			{ id: 'starred', label: '星标', icon: 'star' },
		];
		for (const def of navDefs) {
			const item = nav.createDiv({ cls: 'memos-nav-item' });
			item.setAttribute('data-mode', def.id);
			item.setAttribute('aria-label', def.label);
			item.setAttribute('title', def.label);
			const ic = item.createDiv({ cls: 'memos-nav-item-icon' });
			setIcon(ic, def.icon);
			item.createSpan({ cls: 'memos-nav-item-label', text: def.label });
			const countEl = item.createSpan({ cls: 'memos-nav-item-count', text: '0' });
			this.navItemCounts.set(def.id, countEl);
			item.addEventListener('click', () => {
				if (def.id === 'timeline') {
					// The Memos button is "show everything": it clears the
					// tag / date / structured-filter constraints in one tap.
					this.viewStore.update({
						viewMode: 'timeline',
						activeTag: null,
						activeDate: null,
						filterQuery: '',
					});
				} else {
					this.viewStore.update({ viewMode: def.id });
				}
			});
			this.navItems.push({ el: item, id: def.id });
		}

		// Saved filters pinned between the nav buttons and the Tags section.
		// The whole section hides when there are no entries (renderFilterList).
		const filterSection = sidebar.createDiv({
			cls: 'memos-lite-sidebar-section memos-filter-section',
		});
		this.filterSectionEl = filterSection;
		filterSection.createDiv({ cls: 'memos-lite-sidebar-title', text: 'Filters' });
		this.filterChipsEl = filterSection.createDiv({ cls: 'memos-filter-chips' });
		this.renderFilterList();

		// Filter builder panel: desktop = fixed popover below the search
		// box; phone = inline section under it. Built here so the host's
		// element references (search row, sidebar) are live. The canonical
		// structured query lives in store.filterQuery — the panel reads and
		// live-applies it; the search box only drives plain keyword search.
		this.filterPanel = new FilterPanelController({
			anchorEl: this.searchEl,
			sidebarEl: sidebar,
			isPhone: () => this.isPhone(),
			getFilterQuery: () => this.viewStore.get().filterQuery,
			applyFilterQuery: (q) => this.viewStore.update({ filterQuery: q }),
			getMemos: () => this.viewStore.get().memos,
			onSaved: (name, query, editing) => this.saveFilter(name, query, editing),
			closeDrawerIfPhone: () => this.closeDrawerIfPhone(),
			onPanelToggle: (open) => {
				this.updateFilterBtnState();
				if (!open) this.panelAnchorFilter = null;
			},
			// The whole search row (box, bookmark, funnel) coexists with the
			// panel — clicking there never dismisses it.
			isPanelTrigger: (t) => t.closest('.memos-search') !== null,
			// Recent entries behind the panel's value-field dropdowns.
			getRecentKeywords: () => this.getRecentList('recentSearches'),
			getRecentTags: () => this.getRecentList('recentFilterTags'),
			pushRecentKeyword: (kw) => this.pushRecent('recentSearches', kw),
			pushRecentTag: (tag) => this.pushRecentTag(tag),
		});
		// Filter rows are rebuilt on every relevant store update, so the
		// sortable delegates on the long-lived container, never on rows.
		// Reordering is entered by long-press (no drag handle icon); the
		// ⋯ actions button is excluded from starting a drag session.
		this.filterSortable?.destroy();
		this.filterSortable = attachSortable(this.filterChipsEl, {
			itemSelector: '.memos-filter-item',
			ignoreSelector: '.memos-lite-tag-more',
			scrollContainer: sidebar,
			onReorder: (from, to) => {
				const filters = this.getSavedFilters();
				if (from < 0 || from >= filters.length) return;
				const moved = filters.splice(from, 1)[0];
				if (!moved) return;
				filters.splice(Math.max(0, Math.min(to, filters.length)), 0, moved);
				this.bumpFilters();
			},
			// Hold still and release: open the entry's edit menu anchored to
			// the row (hold-then-move instead reorders — see sortable.ts).
			// Desktop only: mobile rows use the ⋯ button instead.
			onLongPress: (row, index) => {
				if (Platform.isMobile) return;
				const f = this.getSavedFilters()[index];
				if (!f) return;
				const r = row.getBoundingClientRect();
				this.showFilterMenuAt(r.left + 28, r.bottom + 4, f, row);
			},
		});

		if (this.plugin.settings.showTags) this.tagSidebar.build(sidebar);

		this.setupResize(resizer, sidebar);
		this.applySidebarLayout();
		this.setupCompactObserver();
		this.setupVisibilityObserver();

		if (Platform.isMobile) {
			header.addClass('memos-phone-header-hidden');
			window.setTimeout(() => this.adjustFeedPaddingForHeader(), 100);
			this.registerDomEvent(window, 'resize', () =>
				this.adjustFeedPaddingForHeader(),
			);
		}

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const active = document.activeElement;
				const isSelf = leaf === this.leaf;
				const focusInside = !!(active && this.contentEl.contains(active));
				if (!leaf || isSelf) return;
				if (focusInside) safeSetActiveLeaf(this.app, this.leaf);
			}),
		);

		// layout-change is a broad signal (fires on keyboard, resizes too), so
		// it only drives a cheap editor refresh — the "hidden → re-shown"
		// rebuild is triggered by the visibility observer, which is precise.
		this.registerEvent(
			this.app.workspace.on('layout-change', () =>
				this.refreshEditorThrottled(),
			),
		);

		// Patch setActiveLeaf/revealLeaf to survive mobile leaf thrash
		{
			type SetActiveLeafFn = (
				leaf: WorkspaceLeaf,
				opts?: { focus?: boolean },
			) => void;
			type RevealLeafFn = (leaf: WorkspaceLeaf) => Promise<void>;
			// Route through a typed view of the workspace so the patch never
			// touches the deprecated overload signature directly.
			const w = this.app.workspace as unknown as {
				setActiveLeaf: SetActiveLeafFn;
				revealLeaf: RevealLeafFn;
			};
			const origSet = w.setActiveLeaf.bind(w);
			const origReveal = w.revealLeaf.bind(w);
			// Callers may still pass the legacy boolean overload — normalize.
			const patchedSet = (
				leaf: WorkspaceLeaf,
				opts?: boolean | { focus?: boolean },
			): void => {
				const focus =
					typeof opts === 'boolean' ? opts : (opts?.focus ?? false);
				try {
					origSet(leaf, { focus });
				} catch {
					safeSetActiveLeaf(this.app, leaf, focus);
				}
			};
			const patchedReveal = async (leaf: WorkspaceLeaf): Promise<void> => {
				try {
					await origReveal(leaf);
				} catch (e) {
					if (!warnedRevealFailure) {
						warnedRevealFailure = true;
						logger.warn('workspace.revealLeaf threw:', e);
					}
				}
			};
			w.setActiveLeaf = patchedSet;
			w.revealLeaf = patchedReveal;
			this.register(() => {
				if (w.setActiveLeaf === patchedSet) w.setActiveLeaf = origSet;
				if (w.revealLeaf === patchedReveal) w.revealLeaf = origReveal;
			});
		}

		const unsub = this.viewStore.subscribe((state) => {
			void this.applyState(state, filterBar);
		});
		this.unsubscribes.push(unsub);

		window.setTimeout(() => {
			void this.applyState(this.viewStore.get(), filterBar);
		}, 300);

		if (this.plugin.settings.focusOnOpen && !Platform.isMobile) {
			this.editor.focus(true);
		}
	}

	/** Apply one state snapshot to every pane. Both the ViewStore
	 * subscription and the initial delayed render funnel through here,
	 * so the two always paint identically. */
	private async applyState(
		state: MemosState,
		filterBar: HTMLElement,
	): Promise<void> {
		// reloadMemos always allocates a fresh memos array, so a
		// reference change is a free "content revised" signal — drop
		// the per-filter match-count cache and bump its gate rev.
		if (state.memos !== this.lastMemosRef) {
			this.lastMemosRef = state.memos;
			this.filterCountCache.clear();
			this.filterCountRev++;
		}
		await this.memoList.render(state);
		this.renderFilterBar(filterBar, state);
		if (this.plugin.settings.showTags) {
			this.tagSidebar.render(
				this.viewStore.getTagCounts(),
				state.activeTag,
				this.viewStore.frameMemos().length,
				this.plugin.settings.pinnedTags,
			);
		}
		if (this.plugin.settings.showHeatmap) {
			this.heatmap.render(
				this.viewStore.getDateCounts(),
				state.activeDate,
			);
		}
		this.updateRail(state);
		this.renderFilterList();
		this.updateFilterBtnState();
		this.updateNavCounts();
	}

	async onClose(): Promise<void> {
		await this.teardown();
	}

	private teardownPromise: Promise<void> | null = null;
	private teardownStarted = false;

	/** Idempotent full teardown — callable explicitly (the sidebar command
	 * awaits it so an old Memos view is FULLY destroyed — grafted editor DOM
	 * removed — before the replacement view grafts, preventing two grafted CM6
	 * editors from coexisting mid-teardown) or via Obsidian's onClose. Calling
	 * it twice is a no-op that returns the same promise. */
	async teardown(): Promise<void> {
		if (this.teardownStarted) return this.teardownPromise ?? Promise.resolve();
		this.teardownStarted = true;
		this.teardownPromise = this.doTeardown();
		return this.teardownPromise;
	}

	private async doTeardown(): Promise<void> {
		this.resizeObs?.disconnect();
		this.resizeObs = null;
		this.visObs?.disconnect();
		this.visObs = null;
		this.compact = false;
		for (const u of this.unsubscribes) u();
		this.unsubscribes = [];
		this.viewStore.destroy();
		this.clearDrawerSettle();
		if (this.searchDebounce !== null) {
			window.clearTimeout(this.searchDebounce);
			this.searchDebounce = null;
		}
		this.closeSearchSuggest();
		this.filterPanel?.destroy();
		this.filterPanel = null;
		this.filterSortable?.destroy();
		this.filterSortable = null;
		this.tagSidebar.destroy();
		await this.editor.destroy();
		this.memoList.destroy();
	}

	isPhone(): boolean {
		return Platform.isMobile && !Platform.isTablet;
	}

	/** True while this view's leaf sits in an Obsidian side dock — left or
	 * right split, or the phone drawer (WorkspaceMobileDrawer). Walks the
	 * layout parent chain, same membership test as the dock command. */
	private inObsidianSideDock(): boolean {
		const ws = this.app.workspace;
		for (let p: WorkspaceParent | null = this.leaf.parent; p; p = p.parent) {
			if (p === ws.leftSplit || p === ws.rightSplit) return true;
		}
		return false;
	}

	openDrawer(): void {
		if (!this.isDrawerMode()) return;
		const wasOpen = this.drawerOpen;
		this.drawerOpen = true;
		this.applySidebarLayout();
		if (!wasOpen) {
			this.drawerSettled = false;
			this.scheduleDrawerSettle();
		}
	}

	closeDrawer(): void {
		if (!this.isDrawerMode()) return;
		this.clearDrawerSettle();
		this.drawerOpen = false;
		// The filter panel floats over the drawer — it goes away with it.
		this.filterPanel?.close();
		this.closeSearchSuggest();
		this.applySidebarLayout();
	}

	closeDrawerIfPhone(): void {
		if (this.isDrawerMode() && this.drawerOpen) this.closeDrawer();
	}

	/** Drawer behaviour applies to phones AND to any desktop view squeezed
	 * into a narrow container (an Obsidian side dock) — see `compact`. */
	isDrawerMode(): boolean {
		return this.isPhone() || this.compact;
	}

	/** Flip into/out of compact (floating-drawer) mode as the container
	 * width crosses the threshold — e.g. when the user drags the Obsidian
	 * sidebar narrower, or docks the view into a sidebar. */
	/** Editor recovery (re-assert editability + re-measure), throttled to
	 * 100ms — shared by the resize and re-show observers so a busy
	 * keyboard/dock animation doesn't refresh every frame. */
	private refreshEditorThrottled(): void {
		const now = Date.now();
		if (now - this.lastRefreshAt <= 100) return;
		this.lastRefreshAt = now;
		this.editor.refresh();
	}

	/** Force a repaint of the composer on the "dock opened/collapsed" signal.
	 * The CM6 DOM is already correct after refresh — the persistent blank is a
	 * stale iOS composited surface, so we additionally nudge the compositor.
	 * Throttled coarser than refresh: the reflow it forces is the only
	 * non-free part. */
	private wasHidden = false;
	private rebuildScheduled = false;

	private setupCompactObserver(): void {
		if (typeof ResizeObserver === 'undefined') return;
		this.resizeObs?.disconnect();
		const COMPACT_MAX_W = 640;
		this.resizeObs = new ResizeObserver((entries) => {
			const rect = entries[entries.length - 1]?.contentRect;
			if (!rect || rect.width === 0) {
				// Hidden (no box). Backup re-show signal for the rebuild.
				this.wasHidden = true;
				return;
			}
			// The Obsidian phone-drawer slide-in feeds early frames at a tiny
			// width; the grafted CM6 measures once and renders the composer
			// shrunken until its own observer catches up (~1s). Refresh to kill
			// that first-frame glitch — THROTTLED to 100ms so the first resize
			// re-measures immediately (the composer recovers fast) while a busy
			// keyboard/dock animation doesn't refresh every frame.
			this.refreshEditorThrottled();
			const compact = rect.width < COMPACT_MAX_W;
			if (compact === this.compact) return;
			this.compact = compact;
			this.contentEl.toggleClass('memos-view-compact', compact);
			// Entering a narrow dock: start with the drawer CLOSED so the
			// feed keeps its full width; the editor's panel button reopens
			// the overlay, the sidebar's hide button (or the backdrop)
			// closes it.
			if (compact) this.drawerOpen = false;
			this.applySidebarLayout();
		});
		this.resizeObs.observe(this.contentEl);
	}

	/** Re-show detector: a hidden sidebar tab has no box, so IntersectionObserver
	 * reports it non-intersecting; on return it becomes intersecting even at a
	 * constant size. A grafted CM6 editor's rendering is permanently lost after
	 * a hide/show (the root of the "blank until clicked" bug), so a re-show
	 * REBUILDS the editor — a fresh graft always renders. */
	private setupVisibilityObserver(): void {
		if (typeof IntersectionObserver === 'undefined') return;
		this.visObs?.disconnect();
		this.visObs = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (e.isIntersecting) {
					if (this.wasHidden) {
						this.wasHidden = false;
						this.scheduleEditorRebuild();
					}
				} else {
					this.wasHidden = true;
				}
				break;
			}
		});
		this.visObs.observe(this.contentEl);
	}

	/** Rebuild the grafted editor once per re-show (throttled by a flag). */
	private scheduleEditorRebuild(): void {
		if (this.rebuildScheduled) return;
		this.rebuildScheduled = true;
		window.setTimeout(() => {
			this.rebuildScheduled = false;
			void this.editor.rebuild();
		}, 0);
	}

	adjustFeedPaddingForHeader(): void {
		if (!Platform.isMobile) return;
		// Docked into an Obsidian side dock / phone drawer: the view sits
		// flush in its container and the main-pane's floating header does not
		// overlap it, so any phone header offset is a wasted blank band above
		// the composer — the "blank at the top of the input box" in the
		// sidebar. On iPad the view-header is never an overlay either, so no
		// top padding there too. Only the undocked PHONE main pane keeps the
		// measured header offset below, to clear the floating app header.
		if (this.inObsidianSideDock() || !this.isPhone()) {
			cssProps(this.contentEl, { paddingTop: '0' });
			return;
		}
		const headerEl =
			this.contentEl.closest('.workspace-leaf')?.querySelector('.view-header') ??
			this.contentEl.querySelector('.view-header') ??
			document.querySelector('.workspace-leaf.mod-active .view-header') ??
			document.querySelector('.mod-mobile .view-header');
		const h = headerEl?.getBoundingClientRect().height ?? 0;
		const s = h > 8 ? h : 48;
		const offset = s + 40 + 'px';
		this.contentEl.style.setProperty('--memos-mobile-header-height', offset);
		cssProps(this.contentEl, { paddingTop: offset });
		const feedEl = this.contentEl.querySelector<HTMLElement>(
			'.memos-feed',
		);
		if (feedEl) cssProps(feedEl, { paddingTop: '0' });
		const mainEl = this.contentEl.querySelector<HTMLElement>(
			'.memos-main',
		);
		if (mainEl) cssProps(mainEl, { paddingTop: '0' });
	}

	applySidebarLayout(): void {
		const settings = this.plugin.settings;
		const root = this.contentEl;
		const { mainEl, sidebarEl, resizerEl } = this;
		const left = settings.sidebarPosition === 'left';
		const drawer = this.isPhone() || this.compact;

		if (left) {
			root.appendChild(sidebarEl);
			root.appendChild(resizerEl);
			root.appendChild(mainEl);
			sidebarEl.addClass('memos-sidebar-left');
		} else {
			root.appendChild(mainEl);
			root.appendChild(resizerEl);
			root.appendChild(sidebarEl);
			sidebarEl.removeClass('memos-sidebar-left');
		}

		const w = Math.max(
			MemosView.SIDEBAR_MIN_W,
			Math.min(MemosView.SIDEBAR_MAX_W, settings.sidebarWidth),
		);
		cssProps(sidebarEl, { width: `${w}px` });

		if (drawer) {
			sidebarEl.removeClass('memos-sidebar-hidden');
			sidebarEl.toggleClass('memos-drawer-open', this.drawerOpen);
			resizerEl.addClass('memos-resizer-hidden');
		} else {
			sidebarEl.toggleClass('memos-sidebar-hidden', settings.sidebarHidden);
			resizerEl.toggleClass('memos-resizer-hidden', settings.sidebarHidden);
			sidebarEl.removeClass('memos-drawer-open');
		}

		setIcon(
			this.sidebarHideBtn,
			left ? 'panel-left-close' : 'panel-right-close',
		);
		this.sidebarEl.toggleClass('memos-sidebar-left-align', left);

		const float = this.sidebarFloatBtn;
		setIcon(float, left ? 'panel-left-open' : 'panel-right-open');
		cssProps(
			float,
			left
				? { top: '8px', left: '8px', right: '' }
				: { top: '8px', right: '8px', left: '' },
		);
		float.toggleClass(
			'memos-sidebar-float-hidden',
			drawer || !settings.sidebarHidden,
		);
		this.backdropEl.toggleClass(
			'memos-drawer-backdrop-visible',
			drawer && this.drawerOpen,
		);
	}

	private setupResize(resizer: HTMLElement, sidebar: HTMLElement): void {
		let dragging = false;
		resizer.addEventListener('mousedown', (e) => {
			dragging = true;
			e.preventDefault();
			document.body.addClass('memos-is-resizing');
			resizer.addClass('active');
		});
		this.registerDomEvent(document, 'mousemove', (e: MouseEvent) => {
			if (!dragging) return;
			const rect = sidebar.getBoundingClientRect();
			let w =
				this.plugin.settings.sidebarPosition === 'left'
					? e.clientX - rect.left
					: rect.right - e.clientX;
			w = Math.max(
				MemosView.SIDEBAR_MIN_W,
				Math.min(MemosView.SIDEBAR_MAX_W, w),
			);
			cssProps(sidebar, { width: `${w}px` });
			this.plugin.settings.sidebarWidth = w;
		});
		this.registerDomEvent(document, 'mouseup', () => {
			if (!dragging) return;
			dragging = false;
			document.body.removeClass('memos-is-resizing');
			resizer.removeClass('active');
			void this.plugin.saveSettings();
		});
	}

	toggleSidebar(): void {
		this.plugin.settings.sidebarHidden = !this.plugin.settings.sidebarHidden;
		this.applySidebarLayout();
		void this.plugin.saveSettings();
	}

	/** Focus the composer input. Entry point for the plugin commands —
	 * safe to call immediately after setViewState: if the CM6 graft is
	 * still in flight, MemoEditor defers the focus until it lands. */
	focusEditor(): void {
		this.editor.focus(true);
	}

	/** `@@` creation: write a blank memo and return its ref so the editor
	 * can splice in `[[<file>#<id>|name]]`. */
	private async createBlankMemo(): Promise<{
		sourceFile: string;
		id: string;
	} | null> {
		try {
			const memo = await this.plugin.writer.insertMemo('');
			await this.plugin.reloadMemos();
			return { sourceFile: memo.sourceFile, id: memo.id };
		} catch (e) {
			logger.error('Failed to create blank memo:', e);
			return null;
		}
	}

	/** Jump into a referenced memo's editor (Shift+Enter on a ref): inline
	 * card edit on desktop, composer edit on phone; opens the canvas node
	 * when the target is filtered out of the current list. */
	private async editMemoById(id: string): Promise<void> {
		const memo = this.viewStore.get().memos.find((m) => m.id === id);
		if (!memo) {
			new Notice('引用的笔记不存在');
			return;
		}
		if (this.isPhone()) {
			this.editor.startEdit(memo);
			return;
		}
		if (!(await this.memoList.editMemo(id))) {
			void this.app.workspace.openLinkText(
				`${memo.sourceFile}#${memo.id}`,
				'',
				true,
			);
		}
	}

	/* ── Filter search ──────────────────────────────────────── */

	/**
	 * Reveal the sidebar (desktop) or drawer (phone / compact dock) and
	 * focus the search box. Wired to the composer's search button.
	 */
	focusSearch(): void {
		const focusInput = () => {
			this.searchInput?.focus();
		};
		// Drawer mode covers phones AND narrow docks (iPad split view /
		// Stage Manager pushes the view under the compact threshold, where
		// the sidebar is a translated-off-screen drawer). The desktop
		// branch never opens the drawer, so on a tablet the focus would
		// silently land on the invisible input.
		if (this.isDrawerMode()) {
			this.openDrawer();
			// Synchronous first: iOS only raises the keyboard inside the
			// original touch gesture stack; the timeout is a backup pass.
			// The drawer slides in over 250ms. Focusing immediately would
			// open the body-fixed suggestion popover at the drawer's old
			// (off-screen / wide-layout) position, so hold it until the
			// slide settles.
			if (!this.drawerSettled) this.scheduleDrawerSettle();
			focusInput();
			window.setTimeout(focusInput, 150);
			return;
		}
		if (this.plugin.settings.sidebarHidden) this.toggleSidebar();
		// A just-unhidden input silently swallows focus — retry on the next
		// frame and once more after layout settles (see editor.ts focus).
		focusInput();
		window.requestAnimationFrame(focusInput);
		window.setTimeout(focusInput, 150);
	}

	/** Wait for the drawer slide-in to finish before opening search
	 * suggestions, then open them at the input's settled position. */
	private scheduleDrawerSettle(): void {
		if (this.drawerSettleTimer !== null) return;
		this.drawerSettleTimer = window.setTimeout(() => {
			this.settleDrawer();
		}, 320);
		this.sidebarEl.addEventListener('transitionend', this.onDrawerTransitionEnd);
	}

	private onDrawerTransitionEnd = (e: TransitionEvent): void => {
		if (e.target !== this.sidebarEl || e.propertyName !== 'transform') return;
		this.settleDrawer();
	};

	private settleDrawer(): void {
		if (this.drawerSettleTimer !== null) {
			window.clearTimeout(this.drawerSettleTimer);
			this.drawerSettleTimer = null;
		}
		this.sidebarEl?.removeEventListener(
			'transitionend',
			this.onDrawerTransitionEnd,
		);
		this.drawerSettled = true;
		if (this.searchSuggestPending) {
			this.searchSuggestPending = false;
			this.openSearchSuggest();
		}
	}

	private clearDrawerSettle(): void {
		if (this.drawerSettleTimer !== null) {
			window.clearTimeout(this.drawerSettleTimer);
			this.drawerSettleTimer = null;
		}
		this.sidebarEl?.removeEventListener(
			'transitionend',
			this.onDrawerTransitionEnd,
		);
		this.searchSuggestPending = false;
	}

	private onSearchInput(value: string): void {
		// Suggest popup reads the live input — update it immediately; the
		// store update (filter re-derive + list re-render) is debounced so
		// typing doesn't re-render hundreds of cards per keystroke.
		if (this.searchSuggestEl) this.renderSearchSuggestItems();
		if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce);
		this.searchDebounce = window.setTimeout(() => {
			this.searchDebounce = null;
			this.viewStore.update({ keyword: value });
		}, 150);
	}

	/* ── Search-box suggestion dropdown (联想 + 最近) ─────────────
	   Body-mounted .memos-fb-pop (opaque surface — the token copy there
	   is what keeps it from rendering transparent). 联想 matches over
	   past searches plus every vault tag, prefix hits first; remaining
	   最近 entries follow. */

	private openSearchSuggest(): void {
		if (this.isDrawerMode() && this.drawerSettleTimer !== null) {
			this.searchSuggestPending = true;
			return;
		}
		this.closeSearchSuggest();
		this.searchSuggestEl = document.body.createDiv({
			cls: 'memos-fb-pop memos-search-suggest',
		});
		this.renderSearchSuggestItems();
	}

	private closeSearchSuggest(): void {
		this.searchSuggestEl?.remove();
		this.searchSuggestEl = null;
		this.searchSuggestItems = [];
		this.searchSuggestActive = -1;
		this.searchSuggestPending = false;
	}

	/** The 联想 vocabulary: past searches ∪ every bare tag in the vault —
	 * exactly the terms the plain keyword search will hit. */
	private searchSuggestPool(): string[] {
		const set = new Set<string>();
		for (const kw of this.getRecentList('recentSearches')) set.add(kw);
		for (const m of this.viewStore.get().memos) {
			for (const t of m.tags) set.add(t);
		}
		return [...set];
	}

	private renderSearchSuggestItems(): void {
		const el = this.searchSuggestEl;
		if (!el) return;
		el.empty();
		this.searchSuggestItems = [];
		this.searchSuggestActive = -1;

		const typed = this.searchInput.value.trim().toLowerCase();
		const recents = this.getRecentList('recentSearches');

		const pick = (v: string) => {
			this.closeSearchSuggest();
			this.searchInput.value = v;
			this.searchInput.focus();
			this.onSearchInput(v);
			this.pushRecentKeyword(v);
		};

		const list = el.createDiv({ cls: 'memos-fb-pop-list' });
		const addGroup = (label: string, values: string[]) => {
			if (values.length === 0) return;
			// Empty label = no header row (the search box lists plain recents
			// without a caption).
			if (label) list.createDiv({ cls: 'memos-fb-pop-header', text: label });
			for (const v of values) {
				const item = list.createEl('button', {
					cls: 'memos-fb-pop-item',
					attr: { type: 'button' },
				});
				item.createSpan({ cls: 'memos-fb-pop-item-text', text: v });
				// Swallow mousedown so the click lands without blurring the
				// input; stopPropagation so nothing upstream treats it as an
				// outside tap.
				item.addEventListener('mousedown', (e) => e.preventDefault());
				item.addEventListener('click', (e) => {
					e.stopPropagation();
					pick(v);
				});
				item.addEventListener('mouseenter', () => {
					this.setSearchSuggestActive(
						this.searchSuggestItems.indexOf(item),
					);
				});
				this.searchSuggestItems.push(item);
			}
		};

		if (typed) {
			const matches = this.searchSuggestPool()
				.filter((v) => v.toLowerCase().includes(typed))
				.sort((a, b) => {
					const al = a.toLowerCase();
					const bl = b.toLowerCase();
					const ap = al.startsWith(typed) ? 0 : 1;
					const bp = bl.startsWith(typed) ? 0 : 1;
					return ap - bp || al.localeCompare(bl);
				})
				.slice(0, 8);
			// Recents the 联想 group didn't already claim, kept short so a
			// busy match list doesn't bury them.
			const rest = recents
				.filter(
					(v) =>
						!matches.some((m) => m.toLowerCase() === v.toLowerCase()),
				)
				.slice(0, 6);
			addGroup('联想', matches);
			// Hairline between the match group and the recents tail (no
			// caption — keeps the box quiet while staying scannable).
			if (matches.length > 0 && rest.length > 0) {
				list.createEl('hr', { cls: 'memos-fb-pop-sep' });
			}
			addGroup('', rest);
		} else {
			addGroup('', recents.slice(0, 10));
		}
		if (this.searchSuggestItems.length === 0) {
			list.createDiv({ cls: 'memos-fb-pop-empty', text: '暂无最近搜索' });
		}
		this.placeSearchSuggest();
	}

	private setSearchSuggestActive(idx: number): void {
		this.searchSuggestActive = idx;
		this.searchSuggestItems.forEach((it, i) => {
			it.toggleClass('memos-fb-pop-item-active', i === idx);
		});
		this.searchSuggestItems[idx]?.scrollIntoView({ block: 'nearest' });
	}

	/** Full row width, anchored under the search row and flipped above it
	 * when the space below is tighter (phone soft keyboard aware). */
	private placeSearchSuggest(): void {
		const el = this.searchSuggestEl;
		if (!el) return;
		const r = this.searchEl.getBoundingClientRect();
		const vv = window.visualViewport;
		const vpTop = vv?.offsetTop ?? 0;
		const vpHeight = vv?.height ?? window.innerHeight;
		el.style.width = `${r.width}px`;
		const h = el.offsetHeight;
		let top = vpTop + r.bottom + 4;
		if (top + h > vpTop + vpHeight - 8 && vpTop + r.top - 4 - h > vpTop + 8) {
			top = vpTop + r.top - 4 - h;
		}
		el.style.left = `${Math.max(8, r.left)}px`;
		el.style.top = `${top}px`;
	}

	private toggleFilterPanel(): void {
		if (this.filterPanel?.isOpen) {
			this.filterPanel.close();
			return;
		}
		// The funnel absorbed the removed bookmark button: a pending
		// keyword rides along as a seeded condition row (and lands in the
		// recent-searches list that feeds the content-field suggestions).
		const kw = this.searchInput.value.trim();
		if (kw) this.pushRecentKeyword(kw);
		this.filterPanel?.open(kw ? { seedKeyword: kw } : {});
	}

	/** The funnel button stays lit while the panel is open OR a structured
	 * filter is applied (store.filterQuery non-empty). */
	private updateFilterBtnState(): void {
		this.filterBtnEl.toggleClass(
			'active',
			this.filterPanel?.isOpen === true ||
				this.viewStore.get().filterQuery.trim() !== '',
		);
	}

	private updateNavCounts(): void {
		const memos = this.viewStore.get().memos;
		const total = memos.filter((m) => !m.archived).length;
		const archived = memos.filter((m) => m.archived).length;
		const starred = memos.filter((m) => m.starred).length;
		this.navItemCounts.get('timeline')!.textContent = String(total);
		this.navItemCounts.get('archived')!.textContent = String(archived);
		this.navItemCounts.get('starred')!.textContent = String(starred);
	}

	/** Saved filters rendered as tag-style rows above the Tags section
	 * (same .memos-lite-tag-item markup as the tag rows below: name +
	 * match count), drag-reorderable via the delegated sortable on
	 * filterChipsEl. Gated by (filterQuery, savedFiltersRev,
	 * filterCountRev). The whole section hides with zero entries. */
	private renderFilterList(): void {
		const state = this.viewStore.get();
		const filterQuery = state.filterQuery;
		const key = `${filterQuery}|${this.savedFiltersRev}|${this.filterCountRev}`;
		if (key === this.lastChipsKey) return;
		this.lastChipsKey = key;
		this.filterChipsEl.empty();
		const filters = Array.isArray(this.plugin.settings.savedFilters)
			? this.plugin.settings.savedFilters
			: [];
		if (filters.length === 0) {
			this.filterSectionEl.toggleClass('memos-section-hidden', true);
			return;
		}
		this.filterSectionEl.toggleClass('memos-section-hidden', false);
		for (const f of filters) {
			// Green only when the filter slot owns the highlight (an active
			// tag outranks it — at most one lit row in the whole sidebar).
			const active =
				this.activeSlot(state) === 'filter' && f.query === filterQuery;
			const row = this.filterChipsEl.createDiv({
				cls:
					'memos-lite-tag-item memos-filter-item' + (active ? ' active' : ''),
			});
			row.setAttribute('title', f.query);

			// A panel opened via 调整条件 is anchored to its entry's row;
			// this rebuild just replaced that row — hand over the fresh one.
			if (this.panelAnchorFilter === f) {
				this.filterPanel?.setAnchorEl(row);
			}

			// Leading slot mirrors the tag rows' expand-toggle column so the
			// entry name aligns with the tag names right below this section.
			row.createSpan({ cls: 'memos-lite-tag-toggle' });
			row.createSpan({ cls: 'memos-lite-tag-name', text: f.name });
			row.createSpan({
				cls: 'memos-lite-tag-count',
				text: String(this.filterMatchCount(f.query)),
			});

			row.addEventListener('click', () => {
				this.viewStore.update({ filterQuery: active ? '' : f.query });
				this.closeDrawerIfPhone();
			});
			// Right-click menu — desktop only. Mobile rows expose the same
			// actions via the ⋯ button, so a long-press/contextmenu gesture
			// there would only fight scrolling and text selection.
			if (!Platform.isMobile) {
				row.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					this.showFilterMenuAt(e.clientX, e.clientY, f, row);
				});
			}
			if (Platform.isMobile) {
				const more = row.createSpan({ cls: 'memos-lite-tag-more' });
				setIcon(more, 'more-horizontal');
				more.setAttribute('aria-label', 'Filter actions');
				more.addEventListener('click', (e) => {
					e.stopPropagation();
					// Toggle: second tap on the same ⋯ closes its menu (the
					// isConnected check guards against a menu another component
					// already removed behind our back).
					if (this.filterMenuMore === more && this.filterMenuEl?.isConnected && this.closeFilterMenu) {
						this.closeFilterMenu();
						return;
					}
					this.showFilterMenuAt(e.clientX, e.clientY, f, row, more);
				});
			}
		}
	}

	/** Non-archived memo count matching a filter's query, cached until the
	 * memo set changes (see the subscriber's lastMemosRef check). */
	private filterMatchCount(query: string): number {
		const cached = this.filterCountCache.get(query);
		if (cached !== undefined) return cached;
		const trimmed = query.trim();
		const memos = this.viewStore.get().memos.filter((m) => !m.archived);
		let n = 0;
		if (trimmed) {
			const { ast } = parseFilter(trimmed);
			if (ast) n = memos.filter((m) => evalFilter(ast, m)).length;
		}
		this.filterCountCache.set(query, n);
		return n;
	}

	private showFilterMenuAt(
		x: number,
		y: number,
		filter: SavedFilter,
		rowEl?: HTMLElement,
		anchorEl?: HTMLElement,
	): void {
		if (this.closeFilterMenu) this.closeFilterMenu();
		// Other components (card menu, tag menu) share this class — sweep
		// any survivor so at most one dropdown is ever open.
		document.querySelector('.memos-card-dropdown')?.remove();
		const menu = document.body.createDiv({
			cls: 'memos-card-dropdown memos-tag-dropdown',
		});
		this.filterMenuEl = menu;
		this.filterMenuMore = anchorEl ?? null;
		if (Platform.isMobile && !Platform.isTablet) {
			menu.addClass('memos-dropdown-sheet');
		}

		const add = (
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

		add('调整条件…', 'sliders-horizontal', () => {
			// Anchor the builder to this entry's row (it flips above or
			// below depending on room) instead of the search row. Renaming
			// happens there too: the panel's name field is prefilled and
			// 保存 upserts rename-safe.
			this.panelAnchorFilter = filter;
			this.filterPanel?.open({
				query: filter.query,
				editing: filter,
				anchorEl: rowEl,
			});
		});
		menu.createDiv({ cls: 'memos-card-dropdown-separator' });
		add('删除筛选器', 'trash-2', () => this.deleteFilter(filter), true);

		let px = x;
		let py = y;
		const w = menu.offsetWidth;
		const h = menu.offsetHeight;
		if (px + w > window.innerWidth - 8) px = window.innerWidth - w - 8;
		if (py + h > window.innerHeight - 8) py = window.innerHeight - h - 8;
		menu.style.left = `${Math.max(8, px)}px`;
		menu.style.top = `${Math.max(8, py)}px`;

		const close = () => {
			menu.remove();
			document.removeEventListener('click', onDoc, true);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('resize', close);
			if (this.filterMenuEl === menu) {
				this.filterMenuEl = null;
				this.filterMenuMore = null;
				this.closeFilterMenu = null;
			}
		};
		this.closeFilterMenu = close;
		const onDoc = (ev: MouseEvent) => {
			const t = ev.target as Node;
			// A tap on the ⋯ button itself: leave the menu alone — that
			// button's own click handler performs the toggle.
			if (anchorEl && anchorEl.contains(t)) return;
			if (!menu.contains(t)) close();
		};
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key === 'Escape') close();
		};
		window.setTimeout(() => {
			document.addEventListener('click', onDoc, true);
			document.addEventListener('keydown', onKey);
			window.addEventListener('resize', close);
		}, 0);
	}

	private getSavedFilters(): SavedFilter[] {
		if (!Array.isArray(this.plugin.settings.savedFilters)) {
			this.plugin.settings.savedFilters = [];
		}
		return this.plugin.settings.savedFilters;
	}

	private bumpFilters(): void {
		void this.plugin.saveSettings();
		this.savedFiltersRev++;
		this.renderFilterList();
	}

	/** Rename-safe upsert: drop the entry being edited first, then
	 * overwrite an existing filter of the same name or append. */
	private saveFilter(
		name: string,
		query: string,
		editing: SavedFilter | undefined,
	): void {
		const filters = this.getSavedFilters().filter((f) => f !== editing);
		const idx = filters.findIndex((f) => f.name === name);
		if (idx >= 0) filters[idx] = { name, query };
		else filters.push({ name, query });
		this.plugin.settings.savedFilters = filters;
		this.bumpFilters();
		// A freshly saved filter becomes the active one.
		this.viewStore.update({ filterQuery: query });
		new Notice(`已保存筛选器「${name}」`);
	}

	private deleteFilter(filter: SavedFilter): void {
		// A builder anchored to this entry would float over a ghost row.
		if (this.panelAnchorFilter === filter) this.filterPanel?.close();
		this.plugin.settings.savedFilters = this.getSavedFilters().filter(
			(f) => f !== filter,
		);
		this.bumpFilters();
	}

	/** Recent-entry lists shared with the filter panel's value-field
	 * dropdowns (most recent first, capped, dedup case-insensitively). */
	private getRecentList(key: 'recentSearches' | 'recentFilterTags'): string[] {
		if (!Array.isArray(this.plugin.settings[key])) {
			this.plugin.settings[key] = [];
		}
		return this.plugin.settings[key];
	}

	private pushRecent(
		key: 'recentSearches' | 'recentFilterTags',
		value: string,
	): void {
		const v = value.trim();
		if (!v) return;
		const list = this.getRecentList(key).filter(
			(x) => x.toLowerCase() !== v.toLowerCase(),
		);
		list.unshift(v);
		this.plugin.settings[key] = list.slice(0, 12);
		void this.plugin.saveSettings();
	}

	private pushRecentKeyword(keyword: string): void {
		this.pushRecent('recentSearches', keyword);
	}

	private pushRecentTag(tag: string | null): void {
		// Tags are stored bare (no '#') to match the builder's value field.
		if (!tag) return;
		this.pushRecent('recentFilterTags', tag.replace(/^#/, ''));
	}

	togglePinTag(tag: string): void {
		const set = new Set(this.plugin.settings.pinnedTags);
		if (set.has(tag)) set.delete(tag);
		else set.add(tag);
		this.plugin.settings.pinnedTags = [...set];
		void this.plugin.saveSettings();
		this.refreshTagSidebar();
	}

	async renameTag(from: string, to: string): Promise<void> {
		const fromL = from.toLowerCase();
		const toL = to.toLowerCase();
		const memos = this.plugin.store
			.get()
			.memos.filter((m) =>
				m.tags.some((t) => t === fromL || t.startsWith(fromL + '/')),
			);
		if (memos.length === 0) {
			new Notice('没有找到包含该标签的 memo');
			return;
		}
		await this.plugin.writer.bulkUpdateMemos(memos, (c) =>
			renameTagInContent(c, fromL, toL),
		);
		const active = this.viewStore.get().activeTag;
		if (active && (active === fromL || active.startsWith(fromL + '/'))) {
			this.viewStore.update({
				activeTag: toL + active.slice(fromL.length),
			});
		}
		if (
			this.plugin.settings.pinnedTags.some(
				(t) => t === fromL || t.startsWith(fromL + '/'),
			)
		) {
			this.plugin.settings.pinnedTags = this.plugin.settings.pinnedTags.map(
				(t) =>
					t === fromL || t.startsWith(fromL + '/')
						? toL + t.slice(fromL.length)
						: t,
			);
			await this.plugin.saveSettings();
		}
		await this.plugin.reloadMemos();
		new Notice(`已将 #${from} 重命名为 #${to}（${memos.length} 条 memo）`);
	}

	async deleteTag(tag: string): Promise<void> {
		const t = tag.toLowerCase();
		const memos = this.plugin.store
			.get()
			.memos.filter((m) => m.tags.includes(t));
		if (memos.length === 0) {
			new Notice('没有找到包含该标签的 memo');
			return;
		}
		await this.plugin.writer.bulkUpdateMemos(memos, (c) =>
			removeTagFromContent(c, t),
		);
		if (this.viewStore.get().activeTag === t) {
			this.viewStore.update({ activeTag: null });
		}
		if (this.plugin.settings.pinnedTags.includes(t)) {
			this.plugin.settings.pinnedTags =
				this.plugin.settings.pinnedTags.filter((x) => x !== t);
			await this.plugin.saveSettings();
		}
		await this.plugin.reloadMemos();
		new Notice(`已从 ${memos.length} 条 memo 中移除 #${tag}`);
	}

	refreshTagSidebar(): void {
		if (!this.plugin.settings.showTags) return;
		const state = this.viewStore.get();
		this.tagSidebar.render(
			this.viewStore.getTagCounts(),
			state.activeTag,
			state.memos.length,
			this.plugin.settings.pinnedTags,
		);
	}

	private updateRail(state: MemosState): void {
		// The nav highlight tracks viewMode ONLY: Memos / 归档 / 星标 are the
		// three base frames and stay lit while a tag, date or structured
		// filter stacks on top — those rows carry their own active styling
		// independently (previously the single-slot scheme darkened the nav
		// as soon as any constraint was picked, making it look like the
		// base frame had been left).
		for (const item of this.navItems) {
			item.el.toggleClass('active', item.id === state.viewMode);
		}
	}

	/** Which auxiliary slot is currently constrained — used by the saved
	 * filter rows to light up when THEIR query is the active one. The nav
	 * no longer participates (it always reflects viewMode). */
	private activeSlot(
		state: MemosState,
	): 'tag' | 'filter' | 'date' | 'nav' {
		if (state.activeTag) return 'tag';
		if (state.filterQuery.trim() !== '') return 'filter';
		if (state.activeDate) return 'date';
		return 'nav';
	}

	/** Chips above the composer, one per active constraint: #tag, the
	 * structured filter (saved name when it matches an entry, otherwise the
	 * raw query) and the heatmap date. Each chip carries its own ✕ so the
	 * constraints clear independently. */
	private renderFilterBar(bar: HTMLElement, state: MemosState): void {
		bar.empty();
		const addChip = (
			label: string,
			icon: string | null,
			onClear: () => void,
		) => {
			const chip = bar.createSpan({ cls: 'memos-filter-chip' });
			if (icon) {
				const ic = chip.createSpan({ cls: 'memos-filter-chip-icon' });
				setIcon(ic, icon);
			}
			chip.createSpan({ cls: 'memos-filter-chip-label', text: label });
			chip
				.createSpan({ cls: 'memos-clear-filter', text: '✕' })
				.addEventListener('click', onClear);
		};
		if (state.activeTag) {
			addChip('#' + state.activeTag, null, () =>
				this.viewStore.update({ activeTag: null }),
			);
		}
		const query = state.filterQuery.trim();
		if (query) {
			const saved = this.getSavedFilters().find((f) => f.query === query);
			addChip(saved?.name ?? query, 'filter', () =>
				this.viewStore.update({ filterQuery: '' }),
			);
		}
		if (state.activeDate) {
			addChip(state.activeDate, null, () =>
				this.viewStore.update({ activeDate: null }),
			);
		}
		bar.toggleClass('is-hidden', bar.childElementCount === 0);
	}
}
