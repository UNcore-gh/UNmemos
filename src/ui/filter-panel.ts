import {
	ButtonComponent,
	DropdownComponent,
	Notice,
	setIcon,
	TextComponent,
} from 'obsidian';
import { evalFilter, parseFilter } from '../filter';
import type { SavedFilter } from '../settings';
import type { Memo } from '../types';

/* Filter builder that opens BELOW the sidebar search row. The visual
 * builder is the only way to compose a structured filter — the search
 * box itself is a plain keyword search. The canonical structured query
 * lives in store.filterQuery: rows apply to it live as they change,
 * saved entries and the funnel button read from it.
 * Always a body-mounted fixed popover (the sidebar clips internal
 * popovers, so it must live on the body). Desktop: anchored under the
 * search row by default — or directly above/below the entry's row when
 * opened via its 调整条件 menu item. Phone: the drawer is too narrow to
 * be useful, so the panel deliberately breaks out — centered at up to
 * screen width (minus margins) and anchored under the row. */

export interface FilterPanelHost {
	/** The whole search row — desktop popover anchors under it. */
	anchorEl: HTMLElement;
	/** Sidebar element (scroll reposition anchor; phone inline parent). */
	sidebarEl: HTMLElement;
	isPhone(): boolean;
	/** Read the canonical structured query (store.filterQuery). */
	getFilterQuery(): string;
	/** Live-apply a structured query (row edits, cancel-rollback). */
	applyFilterQuery(q: string): void;
	getMemos(): Memo[];
	onSaved(name: string, query: string, editing: SavedFilter | undefined): void;
	closeDrawerIfPhone(): void;
	/** Notified on open/close so the funnel button can track "open". */
	onPanelToggle(open: boolean): void;
	/** Outside-click ignore list (the whole search row…). */
	isPanelTrigger(target: HTMLElement): boolean;
	/** Recent entries for the value fields' suggestions (most recent
	 * first): content field ← searched keywords, tag field ← tags used
	 * for filtering. */
	getRecentKeywords(): string[];
	getRecentTags(): string[];
	/** Record an actually-applied value (检索 / 保存 / search commits). */
	pushRecentKeyword(keyword: string): void;
	pushRecentTag(tag: string): void;
}

export interface FilterPanelOpenOpts {
	/** Load this query into the canonical slot before seeding rows
	 * (used by the entry-edit flow). Omit to keep the current one. */
	query?: string;
	/** Entry being edited (passed back to onSaved for rename-safe upsert). */
	editing?: SavedFilter;
	/** Pre-fill / append a keyword row from the search box (bookmark). */
	seedKeyword?: string;
	/** Anchor override — the filter entry's row when opened via 调整条件,
	 * so the popover sits directly above/below that entry instead of the
	 * search row. The list rebuilds rows on store updates; the host keeps
	 * the anchor fresh via setAnchorEl. */
	anchorEl?: HTMLElement;
}

/** One condition row in the visual builder. Serialized to and rebuilt from
 * the text syntax, so both representations stay in sync. */
interface BuilderRow {
	negate: boolean;
	kind: 'tag' | 'time' | 'keyword';
	/** Tag without the leading '#'. */
	tag: string;
	/** Raw keyword text. */
	text: string;
	/** Time value as a syntax label (今天, 2024-06-15, 最近42天) when !timeCustom. */
	timeLabel: string;
	/** Custom date-range mode: serializes as `customStart..customEnd`. */
	timeCustom: boolean;
	customStart: string;
	customEnd: string;
	/** Connective with the PREVIOUS row (ignored for the first row). */
	connector: 'AND' | 'OR';
}

function newBuilderRow(): BuilderRow {
	return {
		negate: false,
		kind: 'tag',
		tag: '',
		text: '',
		timeLabel: '今天',
		timeCustom: false,
		customStart: '',
		customEnd: '',
		connector: 'AND',
	};
}

const TIME_PRESETS = [
	'今天',
	'昨天',
	'前天',
	'本周',
	'上周',
	'本月',
	'上月',
	'今年',
	'去年',
	'最近7天',
	'最近30天',
];

/* Per-field operator menus. The operator folds the row's negate flag
 * (包含/是 = positive, 不包含/不是 = negated), so there is no separate
 * NOT control — matching the Notion/Linear condition-builder model. */
const OPS: Record<BuilderRow['kind'], Array<{ id: string; label: string; negate: boolean }>> = {
	tag: [
		{ id: 'has', label: '包含', negate: false },
		{ id: 'nothas', label: '不包含', negate: true },
	],
	keyword: [
		{ id: 'contains', label: '包含', negate: false },
		{ id: 'notcontains', label: '不包含', negate: true },
	],
	time: [
		{ id: 'is', label: '是', negate: false },
		{ id: 'not', label: '不是', negate: true },
	],
};

const FIELD_LABEL: Record<BuilderRow['kind'], string> = {
	tag: '标签',
	keyword: '内容',
	time: '时间',
};

function opIdFor(kind: BuilderRow['kind'], negate: boolean): string {
	const list = OPS[kind];
	return (negate ? list.find((o) => o.negate) : list.find((o) => !o.negate))?.id ?? list[0]!.id;
}

/* Global combinator across the rows. Uniform AND/OR, or 自定义组合 when
 * a loaded query mixes connectors (the builder can't author a mix, but
 * it preserves one until the user picks AND or OR). */
type FilterMode = 'AND' | 'OR' | 'mixed';
const MODE_LABEL: Record<FilterMode, string> = {
	AND: '满足以下全部条件',
	OR: '满足以下任一条件',
	mixed: '自定义组合（且 / 或）',
};

function computeMode(rows: BuilderRow[]): FilterMode {
	let m: 'AND' | 'OR' | null = null;
	for (let i = 1; i < rows.length; i++) {
		const c = rows[i]!.connector;
		if (m === null) m = c;
		else if (m !== c) return 'mixed';
	}
	return m ?? 'AND';
}

/** Today as YYYY-MM-DD — window.moment (Obsidian global) when available,
 * local-time Date otherwise. */
function todayStr(): string {
	const w = window as unknown as {
		moment?: () => { format(fmt: string): string };
	};
	if (typeof w.moment === 'function') return w.moment().format('YYYY-MM-DD');
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
		d.getDate(),
	).padStart(2, '0')}`;
}

export class FilterPanelController {
	private panelEl: HTMLElement | null = null;
	private rows: BuilderRow[] = [];
	private rowsEl: HTMLElement | null = null;
	private modeWrap: HTMLElement | null = null;
	private addWrap: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;
	private nameInput: TextComponent | null = null;
	private editing: SavedFilter | undefined;
	private resizeObserver: ResizeObserver | null = null;
	/** Row of the filter entry being edited (调整条件); null = anchor to
	 * the host's search row. */
	private anchorOverride: HTMLElement | null = null;
	/** Body-mounted popovers — the tag/content suggestion dropdowns and
	 * the time picker share the .memos-fb-pop look and this anchor/close/
	 * reposition plumbing. (The add-condition type picker is a genuine
	 * native <select> like the mode dropdown — system-drawn popup, no
	 * custom popover.) */
	private suggestEl: HTMLElement | null = null;
	private suggestAnchorEl: HTMLElement | null = null;
	private suggestRow: BuilderRow | null = null;
	private suggestKind: 'tag' | 'keyword' | null = null;
	private suggestItemEls: HTMLElement[] = [];
	private suggestActiveIdx = -1;
	private timePopEl: HTMLElement | null = null;
	private timePopAnchorEl: HTMLElement | null = null;

	constructor(private host: FilterPanelHost) {}

	get isOpen(): boolean {
		return this.panelEl !== null;
	}

	open(opts: FilterPanelOpenOpts = {}): void {
		this.close(); // idempotent: menus close the panel first, then re-open
		this.editing = opts.editing;
		this.anchorOverride = opts.anchorEl ?? null;

		// Edit flow: write the entry's query into the canonical slot first,
		// then read it back so the builder rows mirror the entry being
		// edited (and live-apply keeps the feed in sync from there).
		if (opts.query !== undefined) {
			this.host.applyFilterQuery(opts.query);
		}
		const query = this.host.getFilterQuery().trim();

		const panel = document.body.createDiv({ cls: 'memos-filter-panel' });
		document.body.appendChild(panel);
		this.panelEl = panel;

		// Header: icon badge + title + close ✕
		const header = panel.createDiv({ cls: 'memos-fp-header' });
		const iconBadge = header.createSpan({ cls: 'memos-fp-icon' });
		setIcon(iconBadge, 'filter');
		header.createDiv({
			cls: 'memos-fp-title',
			text: opts.editing ? '编辑智能筛选' : '创建智能筛选',
		});
		const closeBtn = header.createEl('button', {
			cls: 'memos-fp-close',
			attr: { 'aria-label': 'Close', title: '关闭' },
			text: '✕',
		});
		closeBtn.addEventListener('click', () => this.close());

		// Builder body: mode control → rows → add control. Naming and the
		// actions share ONE footer line below it, and the live match count
		// is the panel's last line.

		// Conditions: a single global combinator on top, then one row per
		// condition as [field][operator][value], then the add control.
		const condSection = panel.createDiv({ cls: 'memos-fb-section memos-fb-cond' });
		this.modeWrap = condSection.createDiv({ cls: 'memos-fb-mode-wrap' });
		this.rowsEl = condSection.createDiv({ cls: 'memos-fb-rows' });
		this.addWrap = condSection.createDiv({ cls: 'memos-fb-add-wrap' });
		const addBtn = this.addWrap.createEl('button', {
			cls: 'memos-fb-add',
			text: '+ 添加条件项',
		});
		addBtn.addEventListener('click', () => {
			this.rows.push(newBuilderRow());
			this.renderRows();
			this.syncText();
		});
		// The condition-TYPE picker is a genuine native <select> — exactly
		// the same control (and system-drawn popup) as the "满足以下全部条件"
		// mode dropdown, instead of a hand-built menu. A placeholder option
		// keeps the box chevron-only; picking a type adds the row and the
		// select snaps back to the placeholder.
		const addChevron = this.addWrap.createDiv({ cls: 'memos-fb-add-chevron' });
		const addTypeDd = new DropdownComponent(addChevron);
		addTypeDd.addOption('', '');
		for (const k of ['tag', 'keyword', 'time'] as BuilderRow['kind'][]) {
			addTypeDd.addOption(k, FIELD_LABEL[k]);
		}
		addTypeDd.selectEl.setAttribute('aria-label', '选择条件类型');
		addTypeDd.onChange((v) => {
			if (!v) return;
			const row = newBuilderRow();
			row.kind = v as BuilderRow['kind'];
			this.rows.push(row);
			addTypeDd.setValue('');
			this.renderRows();
			this.syncText();
		});

		// Footer — the name field and all three actions on ONE line:
		// [命名框][保存][取消][检索]. 保存 stays disabled until the name
		// field has text, so an unnamed filter can never be saved;
		// editing prefills the name.
		const footer = panel.createDiv({ cls: 'memos-fp-footer' });
		const nameInput = new TextComponent(footer)
			.setPlaceholder('筛选器保存名称')
			.setValue(opts.editing?.name ?? '');
		nameInput.inputEl.addClass('memos-fb-name');
		this.nameInput = nameInput;

		const saveBtn = new ButtonComponent(footer).setButtonText('保存');
		saveBtn.setDisabled(nameInput.getValue().trim() === '');
		nameInput.onChange(() => {
			saveBtn.setDisabled(nameInput.getValue().trim() === '');
		});
		saveBtn.onClick(() => {
			const name = nameInput.getValue().trim();
			if (!name) return; // the disabled state already guards this
			const queryNow = this.rowsToText().trim();
			if (!queryNow) {
				new Notice('筛选条件为空');
				return;
			}
			const editing = this.editing;
			this.recordRecents();
			this.close();
			this.host.onSaved(name, queryNow, editing);
			this.host.closeDrawerIfPhone();
		});

		new ButtonComponent(footer)
			.setButtonText('取消')
			.onClick(() => {
				// 取消 = hide the panel AND clear the applied filter
				// entirely — "never mind filtering", not "undo my edits".
				this.host.applyFilterQuery('');
				this.close();
			});
		new ButtonComponent(footer)
			.setButtonText('检索')
			.setCta()
			.onClick(() => {
				// 检索 = apply and get out of the way. On phones the
				// drawer closes too, so the filtered feed is visible.
				this.host.applyFilterQuery(this.rowsToText().trim());
				this.recordRecents();
				this.close();
				this.host.closeDrawerIfPhone();
			});

		// Live match count — quiet summary as the panel's LAST line.
		this.previewEl = panel.createDiv({ cls: 'memos-fb-preview' });

		// Initial rows mirror the canonical query.
		this.rows = query ? this.textToRows(query) : [newBuilderRow()];
		// Bookmark flow: fold the search-box keyword into the conditions —
		// replace a lone empty row, otherwise append. Re-serialize only when
		// a seed was applied, so merely opening the panel never rewrites the
		// canonical query (saved-entry active states compare exact strings).
		const seed = opts.seedKeyword?.trim() ?? '';
		if (seed) {
			const kwRow = newBuilderRow();
			kwRow.kind = 'keyword';
			kwRow.text = seed;
			if (this.rows.length === 1 && !this.rowHasCond(this.rows[0]!)) {
				this.rows = [kwRow];
			} else {
				this.rows.push(kwRow);
			}
			this.syncText();
		}
		this.renderRows();
		this.refreshPreview();

		this.reposition();
		this.host.sidebarEl.addEventListener('scroll', this.onRepositionEvent);
		window.addEventListener('resize', this.onRepositionEvent);
		// Phone: the soft keyboard shrinks the visual viewport — re-clamp.
		window.visualViewport?.addEventListener('resize', this.onRepositionEvent);
		// Resizer drag mutates sidebar width with no event; layout flips
		// move the sidebar node — both show up here.
		this.resizeObserver = new ResizeObserver(() => this.reposition());
		this.resizeObserver.observe(this.host.sidebarEl);
		document.addEventListener('pointerdown', this.onDocPointerDown, true);
		document.addEventListener('keydown', this.onKeydown);
		this.host.onPanelToggle(true);
	}

	close(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		const wasOpen = this.panelEl !== null;
		if (this.panelEl) {
			this.closeSuggest();
			this.closeTimePop();
			this.host.sidebarEl.removeEventListener('scroll', this.onRepositionEvent);
			window.removeEventListener('resize', this.onRepositionEvent);
			window.visualViewport?.removeEventListener(
				'resize',
				this.onRepositionEvent,
			);
			document.removeEventListener('pointerdown', this.onDocPointerDown, true);
			document.removeEventListener('keydown', this.onKeydown);
			this.panelEl.remove();
		}
		this.panelEl = null;
		this.rowsEl = null;
		this.modeWrap = null;
		this.addWrap = null;
		this.previewEl = null;
		this.nameInput = null;
		this.editing = undefined;
		this.anchorOverride = null;
		if (wasOpen) this.host.onPanelToggle(false);
	}

	/** Re-anchor mid-session: the filter list rebuilds its rows on every
	 * relevant store update, so the row this panel opened from dies — the
	 * host hands over its replacement. */
	setAnchorEl(el: HTMLElement | null): void {
		this.anchorOverride = el;
		if (this.panelEl) this.reposition();
	}

	destroy(): void {
		this.close();
	}

	/* ── Positioning (desktop popover) ──────────────────────── */

	private onRepositionEvent = (): void => this.reposition();

	private reposition(): void {
		const panel = this.panelEl;
		if (!panel) return;
		const anchor = this.anchorOverride ?? this.host.anchorEl;
		// offsetParent === null → the sidebar is hidden; nothing to anchor to.
		if (!anchor.isConnected || anchor.offsetParent === null) {
			this.close();
			return;
		}
		const rect = anchor.getBoundingClientRect();
		// getBoundingClientRect is in visual-viewport coordinates while fixed
		// positioning is in layout coordinates — shift by the visual offset
		// (non-zero on phones once the soft keyboard scrolls the page) and
		// clamp against the visual height so the panel never extends under
		// the keyboard.
		const vv = window.visualViewport;
		const vpTop = vv?.offsetTop ?? 0;
		const vpHeight = vv?.height ?? window.innerHeight;

		if (this.host.isPhone()) {
			// Break out of the narrow drawer: centered, screen-wide minus
			// margins (still inside the viewport — never wider).
			panel.style.width = `${Math.min(window.innerWidth - 24, 460)}px`;
		} else {
			// Width follows the anchor within a readable range (set before
			// measuring so offsetWidth reflects it).
			panel.style.width = `${Math.max(280, Math.min(rect.width, 420))}px`;
		}
		// Measure the natural height (clear any previous clamp first — a
		// viewport-sized cap is effectively unconstrained) so the above/
		// below decision uses the real content size.
		panel.style.maxHeight = `${vpHeight}px`;
		const pw = panel.offsetWidth;
		const ph = panel.offsetHeight;
		const left = this.host.isPhone()
			? Math.max(12, (window.innerWidth - pw) / 2)
			: Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8));
		// Prefer BELOW the anchor; flip ABOVE when the panel wouldn't fit
		// underneath and the space on top is roomier (entries deep in the
		// sidebar would otherwise push the panel off-screen).
		const spaceBelow = vpTop + vpHeight - 8 - (rect.bottom + 8);
		const spaceAbove = rect.top - 8 - (vpTop + 8);
		let top: number;
		if (ph > spaceBelow && spaceAbove > spaceBelow) {
			top = Math.max(vpTop + 8, rect.top - 8 - ph);
			panel.style.maxHeight = `${Math.max(160, rect.top - 8 - top)}px`;
		} else {
			// Content that outgrows the viewport SHRINKS the panel (internal
			// scroll) instead of floating it up over its anchor — every part
			// stays anchored and reachable.
			top = Math.max(8, vpTop + rect.bottom + 8);
			panel.style.maxHeight = `${Math.max(160, vpTop + vpHeight - top - 8)}px`;
		}
		panel.style.left = `${left}px`;
		panel.style.top = `${top}px`;
		// The rows just moved (panel resize / soft-keyboard drag) — drag any
		// open popover along with its anchor instead of letting it float away
		// or die (closing here would kill the suggest popup the instant the
		// phone keyboard opens on focus).
		this.repositionPopovers();
	}

	private onDocPointerDown = (e: PointerEvent): void => {
		const panel = this.panelEl;
		if (!panel) return;
		const target = e.target as HTMLElement | null;
		if (!target) return;
		// Body-mounted popovers live outside panelEl: a click inside one is
		// handled by its items (keep everything open); a click outside closes
		// that popover and falls through to the panel's own dismiss logic.
		if (this.suggestEl) {
			if (this.suggestEl.contains(target) || target === this.suggestAnchorEl) return;
			this.closeSuggest();
		}
		if (this.timePopEl) {
			if (this.timePopEl.contains(target) || !!target.closest('.memos-fb-time')) return;
			this.closeTimePop();
		}
		if (panel.contains(target)) return;
		// Clicks inside the search row (funnel re-toggle, bookmark, input)
		// must not dismiss the panel.
		if (this.host.isPanelTrigger(target)) return;
		this.close();
	};

	private onKeydown = (e: KeyboardEvent): void => {
		if (e.key !== 'Escape') return;
		// Escape peels layers inside-out: suggest popup → time popup → the
		// panel itself.
		if (this.suggestEl) {
			this.closeSuggest();
			return;
		}
		if (this.timePopEl) {
			this.closeTimePop();
			return;
		}
		this.close();
	};

	/* ── Rows ⇄ text sync ───────────────────────────────────── */

	/** Rows → store.filterQuery (live on every row control change). The
	 * store is canonical: feed filtering and saved-entry active states all
	 * follow via its subscriber. */
	private syncText(): void {
		this.host.applyFilterQuery(this.rowsToText());
		this.refreshPreview();
	}

	private rowsToText(): string {
		const parts: string[] = [];
		for (const row of this.rows) {
			let cond = '';
			if (row.kind === 'tag') {
				const t = row.tag.trim();
				if (t) cond = `#${t}`;
			} else if (row.kind === 'keyword') {
				const t = row.text.trim();
				if (t) cond = t;
			} else if (row.timeCustom) {
				const a = row.customStart;
				const b = row.customEnd;
				if (a && b) cond = a <= b ? `${a}..${b}` : `${b}..${a}`;
				else cond = a || b;
			} else if (row.timeLabel) {
				cond = row.timeLabel;
			}
			if (!cond) continue;
			const neg = row.negate ? 'NOT ' : '';
			parts.push(
				parts.length === 0 ? `${neg}${cond}` : `${row.connector} ${neg}${cond}`,
			);
		}
		return parts.join(' ');
	}

	/** Whether a row contributes a condition (mirrors rowsToText's skip rule). */
	private rowHasCond(row: BuilderRow): boolean {
		if (row.kind === 'tag') return row.tag.trim() !== '';
		if (row.kind === 'keyword') return row.text.trim() !== '';
		if (row.timeCustom) return row.customStart !== '' || row.customEnd !== '';
		return row.timeLabel !== '';
	}

	private textToRows(query: string): BuilderRow[] {
		const { tokens } = parseFilter(query);
		const rows: BuilderRow[] = [];
		let connector: 'AND' | 'OR' = 'AND';
		let negate = false;
		for (const t of tokens) {
			if (t.kind === 'op') {
				if (t.op === 'AND') connector = 'AND';
				else if (t.op === 'OR') connector = 'OR';
				else if (t.op === 'NOT') negate = true;
				continue;
			}
			const row = newBuilderRow();
			row.negate = negate;
			row.connector = connector;
			negate = false;
			connector = 'AND';
			if (t.kind === 'tag') {
				row.kind = 'tag';
				row.tag = t.tag ?? t.label.replace(/^#/, '');
			} else if (t.kind === 'time') {
				row.kind = 'time';
				if (t.label.includes('~')) {
					const [a, b] = t.label.split('~');
					row.timeCustom = true;
					row.customStart = a ?? '';
					row.customEnd = b ?? a ?? '';
				} else {
					row.timeLabel = t.label;
				}
			} else {
				row.kind = 'keyword';
				row.text = t.label;
			}
			rows.push(row);
		}
		return rows;
	}

	private renderRows(): void {
		if (!this.rowsEl) return;
		// Rows are rebuilt in place — any popover anchored to a dying
		// control would float detached, so drop them first.
		this.closeSuggest();
		this.closeTimePop();
		this.rowsEl.empty();
		this.renderModeControl();

		this.rows.forEach((row, i) => {
			const rowEl = this.rowsEl!.createDiv({ cls: 'memos-fb-row' });

			// Field (标签 / 内容 / 时间)
			const kindWrap = rowEl.createDiv({ cls: 'memos-fb-kind' });
			const kindDd = new DropdownComponent(kindWrap);
			kindDd.addOption('tag', FIELD_LABEL.tag);
			kindDd.addOption('keyword', FIELD_LABEL.keyword);
			kindDd.addOption('time', FIELD_LABEL.time);
			kindDd.setValue(row.kind).onChange((v) => {
				row.kind = v as BuilderRow['kind'];
				this.renderRows();
				this.syncText();
			});

			// Operator — folds the negate flag (包含/是 vs 不包含/不是).
			const opWrap = rowEl.createDiv({ cls: 'memos-fb-op' });
			const opDd = new DropdownComponent(opWrap);
			for (const o of OPS[row.kind]) opDd.addOption(o.id, o.label);
			opDd.setValue(opIdFor(row.kind, row.negate)).onChange((v) => {
				const picked = OPS[row.kind].find((o) => o.id === v);
				row.negate = picked?.negate ?? false;
				this.syncText();
			});

			// Value
			const valueWrap = rowEl.createDiv({ cls: 'memos-fb-value' });
			if (row.kind === 'tag') {
				const tagInput = new TextComponent(valueWrap)
					.setPlaceholder('标签名，如 work/todo')
					.setValue(row.tag)
					.onChange((v) => {
						row.tag = v;
						this.syncText();
					});
				this.wireSuggestInput(tagInput.inputEl, row, 'tag');
			} else if (row.kind === 'keyword') {
				const kwInput = new TextComponent(valueWrap)
					.setPlaceholder('搜索')
					.setValue(row.text)
					.onChange((v) => {
						row.text = v;
						this.syncText();
					});
				this.wireSuggestInput(kwInput.inputEl, row, 'keyword');
			} else {
				this.buildTimeControl(valueWrap, row);
			}

			// Delete — quiet, revealed on row hover.
			const del = rowEl.createEl('button', {
				cls: 'memos-fb-del',
				attr: { 'aria-label': 'Remove condition', title: '删除条件' },
			});
			setIcon(del, 'x');
			del.addEventListener('click', () => {
				this.rows.splice(i, 1);
				if (this.rows.length > 0) this.rows[0]!.connector = 'AND';
				this.renderRows();
				this.syncText();
			});
		});
	}

	/* ── Value-field popovers (native-select look) ────────────── */

	/** One row of a .memos-fb-pop popover — plain full-width item, solid
	 * accent highlight on the active entry (native <select> behaviour).
	 * mousedown is swallowed so picking an item never blurs the anchored
	 * input mid-flow. */
	private popItem(
		parent: HTMLElement,
		text: string,
		opts: { active?: boolean; check?: boolean; onPick?: () => void } = {},
	): HTMLElement {
		const item = parent.createEl('button', {
			cls: 'memos-fb-pop-item',
			attr: { type: 'button' },
		});
		item.createSpan({ cls: 'memos-fb-pop-item-text', text });
		if (opts.check) {
			const ic = item.createSpan({ cls: 'memos-fb-pop-check' });
			setIcon(ic, 'check');
		}
		if (opts.active) item.addClass('memos-fb-pop-item-active');
		const pick = opts.onPick;
		if (pick) {
			item.addEventListener('mousedown', (e) => e.preventDefault());
			item.addEventListener('click', (e) => {
				e.stopPropagation();
				pick();
			});
		}
		return item;
	}

	/** Anchor a body-mounted popover under its anchor (flipping above when
	 * the space below is tighter), clamped to the visual viewport so the
	 * phone soft keyboard never covers it. */
	private placePopover(el: HTMLElement, anchor: HTMLElement, minWidth: number): void {
		const r = anchor.getBoundingClientRect();
		const vv = window.visualViewport;
		const vpTop = vv?.offsetTop ?? 0;
		const vpHeight = vv?.height ?? window.innerHeight;
		const w = Math.max(minWidth, Math.min(r.width, 300));
		el.style.width = `${w}px`;
		const h = el.offsetHeight;
		let top = vpTop + r.bottom + 4;
		if (top + h > vpTop + vpHeight - 8 && vpTop + r.top - 4 - h > vpTop + 8) {
			top = vpTop + r.top - 4 - h;
		}
		const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}

	/** Re-anchor every open popover (called from reposition, so sidebar
	 * scrolls and the soft keyboard drag the popovers along). */
	private repositionPopovers(): void {
		if (this.suggestEl && this.suggestAnchorEl) {
			if (this.suggestAnchorEl.isConnected) {
				this.placePopover(this.suggestEl, this.suggestAnchorEl, 160);
			} else this.closeSuggest();
		}
		if (this.timePopEl && this.timePopAnchorEl) {
			if (this.timePopAnchorEl.isConnected) {
				this.placePopover(this.timePopEl, this.timePopAnchorEl, 200);
			} else this.closeTimePop();
		}
	}

	/* ── Tag / content suggestion dropdown ────────────────────── */

	/** Focus on a tag/content value field opens its suggestion dropdown
	 * immediately (最近 entries); typing re-filters it live. */
	private wireSuggestInput(
		inputEl: HTMLInputElement,
		row: BuilderRow,
		kind: 'tag' | 'keyword',
	): void {
		inputEl.addEventListener('focus', () => this.openSuggest(inputEl, row, kind));
		inputEl.addEventListener('input', () => {
			if (this.suggestEl && this.suggestAnchorEl === inputEl) {
				this.renderSuggestItems();
			}
		});
		inputEl.addEventListener('keydown', (e) => this.onSuggestKeydown(e));
	}

	private openSuggest(
		inputEl: HTMLInputElement,
		row: BuilderRow,
		kind: 'tag' | 'keyword',
	): void {
		this.closeSuggest();
		const el = document.body.createDiv({ cls: 'memos-fb-pop memos-fb-suggest' });
		this.suggestEl = el;
		this.suggestAnchorEl = inputEl;
		this.suggestRow = row;
		this.suggestKind = kind;
		this.renderSuggestItems();
		this.placePopover(el, inputEl, 160);
	}

	private closeSuggest(): void {
		this.suggestEl?.remove();
		this.suggestEl = null;
		this.suggestAnchorEl = null;
		this.suggestRow = null;
		this.suggestKind = null;
		this.suggestItemEls = [];
		this.suggestActiveIdx = -1;
	}

	/** Every tag known across the vault's memos — the 联想 pool for the
	 * tag field (a superset of the recent list). */
	private allVaultTags(): string[] {
		const set = new Set<string>();
		for (const m of this.host.getMemos()) {
			for (const t of m.tags) set.add(t);
		}
		return [...set];
	}

	/** Rebuild the suggestion list for the current input text: empty input
	 * → the recent entries; typed text → substring matches (prefix hits
	 * first) under 联想, then the remaining recents under 最近. */
	private renderSuggestItems(): void {
		const el = this.suggestEl;
		const kind = this.suggestKind;
		const row = this.suggestRow;
		if (!el || !kind || !row) return;
		el.empty();
		this.suggestItemEls = [];
		this.suggestActiveIdx = -1;

		const input = this.suggestAnchorEl as HTMLInputElement | null;
		const typed = input?.value.trim().toLowerCase() ?? '';
		const recents =
			kind === 'tag' ? this.host.getRecentTags() : this.host.getRecentKeywords();
		// Tag 联想 draws on every vault tag; keyword suggestions only on
		// past searches (there is no finite "keyword vocabulary").
		const pool =
			kind === 'tag' ? [...new Set([...this.allVaultTags(), ...recents])] : [...recents];

		const matches = typed ? pool.filter((v) => v.toLowerCase().includes(typed)) : [];
		matches.sort((a, b) => {
			const al = a.toLowerCase();
			const bl = b.toLowerCase();
			const ap = al.startsWith(typed) ? 0 : 1;
			const bp = bl.startsWith(typed) ? 0 : 1;
			return ap - bp || al.localeCompare(bl);
		});
		const rest = typed ? recents.filter((v) => !matches.includes(v)) : recents;

		const pick = (v: string) => {
			if (input) input.value = v;
			if (kind === 'tag') row.tag = v;
			else row.text = v;
			this.syncText();
			this.closeSuggest();
		};

		const addGroup = (label: string, values: string[]) => {
			if (values.length === 0) return;
			// Empty label → no header row (the tag box lists its recents
			// without the 「最近」 caption).
			if (label) el.createDiv({ cls: 'memos-fb-pop-header', text: label });
			for (const v of values) {
				const item = this.popItem(el, v, { onPick: () => pick(v) });
				item.addEventListener('mouseenter', () => {
					this.setSuggestActive(this.suggestItemEls.indexOf(item));
				});
				this.suggestItemEls.push(item);
			}
		};
		if (typed) addGroup('联想', matches);
		addGroup(kind === 'tag' ? '' : '最近', rest);
		if (this.suggestItemEls.length === 0) {
			el.createDiv({
				cls: 'memos-fb-pop-empty',
				text: kind === 'tag' ? '暂无最近使用的标签' : '暂无最近搜索',
			});
		}
	}

	private setSuggestActive(idx: number): void {
		this.suggestActiveIdx = idx;
		this.suggestItemEls.forEach((it, i) => {
			it.toggleClass('memos-fb-pop-item-active', i === idx);
		});
		this.suggestItemEls[idx]?.scrollIntoView({ block: 'nearest' });
	}

	private onSuggestKeydown(e: KeyboardEvent): void {
		if (!this.suggestEl) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const n = this.suggestItemEls.length;
			if (n === 0) return;
			const dir = e.key === 'ArrowDown' ? 1 : -1;
			this.setSuggestActive((this.suggestActiveIdx + dir + n) % n);
		} else if (e.key === 'Enter') {
			const active = this.suggestItemEls[this.suggestActiveIdx];
			if (active) {
				e.preventDefault();
				active.click();
			}
		} else if (e.key === 'Escape') {
			e.stopPropagation(); // don't take the whole panel down with it
			this.closeSuggest();
		}
	}

	/** Record the current rows' tag/keyword values into the host's recent
	 * lists — called on 检索 / 保存, when the conditions actually apply. */
	private recordRecents(): void {
		for (const row of this.rows) {
			if (row.kind === 'tag') {
				const t = row.tag.trim();
				if (t) this.host.pushRecentTag(t);
			} else if (row.kind === 'keyword') {
				const t = row.text.trim();
				if (t) this.host.pushRecentKeyword(t);
			}
		}
	}

	/** The global AND/OR/mixed combinator above the rows. Editing it
	 * normalises every inter-row connector; a loaded mixed query shows a
	 * 自定义组合 option until the user picks AND or OR. */
	private renderModeControl(): void {
		if (!this.modeWrap) return;
		this.modeWrap.empty();
		const mode = computeMode(this.rows);
		const dd = new DropdownComponent(this.modeWrap);
		dd.addOption('AND', MODE_LABEL.AND);
		dd.addOption('OR', MODE_LABEL.OR);
		if (mode === 'mixed') dd.addOption('mixed', MODE_LABEL.mixed);
		dd.setValue(mode).onChange((v) => {
			if (v !== 'AND' && v !== 'OR') return;
			for (let i = 1; i < this.rows.length; i++) this.rows[i]!.connector = v;
			this.renderRows();
			this.syncText();
		});
	}

	private buildTimeControl(wrap: HTMLElement, row: BuilderRow): void {
		// A select-like trigger button; the body-mounted popup carries two
		// date bars at its top (从 A / 至 B) for a custom range, followed by
		// the preset list below. The trigger MIRRORS those two bars: custom
		// mode shows two segments (从 A │ 至 B) mapping one-to-one onto the
		// popup's bars, and tapping a segment opens the popup with focus on
		// exactly that bar.
		const trigger = wrap.createEl('button', {
			cls: 'memos-fb-time',
			attr: { type: 'button', 'aria-label': '选择时间条件' },
		});
		const label = trigger.createSpan({ cls: 'memos-fb-time-label' });
		this.renderTimeLabel(label, row);
		const chev = trigger.createSpan({ cls: 'memos-fb-time-chevron' });
		setIcon(chev, 'chevron-down');
		trigger.addEventListener('click', (ev) => {
			ev.stopPropagation();
			const seg = (ev.target as HTMLElement).closest('.memos-fb-time-seg');
			const focusBar = seg?.hasClass('memos-fb-time-seg-a')
				? 'a'
				: seg?.hasClass('memos-fb-time-seg-b')
					? 'b'
					: undefined;
			this.toggleTimePop(trigger, label, row, focusBar);
		});
	}

	/** Trigger face: one segment per date bar in the popup's top section.
	 * Custom ranges read 从 A │ 至 B (each half clickable → focuses its own
	 * bar); presets show a single label. */
	private renderTimeLabel(labelEl: HTMLElement, row: BuilderRow): void {
		labelEl.empty();
		labelEl.parentElement?.setAttribute('title', this.timeLabelText(row));
		if (row.timeCustom && (row.customStart || row.customEnd)) {
			const segA = labelEl.createSpan({ cls: 'memos-fb-time-seg memos-fb-time-seg-a' });
			segA.createSpan({ cls: 'memos-fb-time-k', text: '从' });
			segA.appendText(row.customStart || '…');
			const segB = labelEl.createSpan({ cls: 'memos-fb-time-seg memos-fb-time-seg-b' });
			segB.createSpan({ cls: 'memos-fb-time-k', text: '至' });
			segB.appendText(row.customEnd || '…');
		} else {
			labelEl.createSpan({ cls: 'memos-fb-time-seg', text: row.timeLabel || '今天' });
		}
	}

	private timeLabelText(row: BuilderRow): string {
		if (row.timeCustom) {
			const a = row.customStart;
			const b = row.customEnd;
			if (a && b) return a <= b ? `${a}~${b}` : `${b}~${a}`;
			return a || b || '自定义日期范围';
		}
		return row.timeLabel || '今天';
	}

	private toggleTimePop(
		trigger: HTMLElement,
		labelEl: HTMLElement,
		row: BuilderRow,
		focusBar?: 'a' | 'b',
	): void {
		if (this.timePopEl) {
			this.closeTimePop();
			return;
		}
		this.closeSuggest();
		const pop = document.body.createDiv({ cls: 'memos-fb-pop memos-fb-time-pop' });
		this.timePopEl = pop;
		this.timePopAnchorEl = trigger;

		// Custom range first: pick date A, pick date B, everything between
		// matches (inverted bounds are swapped when the query is built).
		const dates = pop.createDiv({ cls: 'memos-fb-pop-dates' });
		const today = todayStr();
		const seedFromLabel = /^\d{4}-\d{2}-\d{2}$/.test(row.timeLabel) ? row.timeLabel : '';
		const barA = this.dateBar(dates, '从', row.timeCustom ? row.customStart || today : seedFromLabel || today);
		const barB = this.dateBar(dates, '至', row.timeCustom ? row.customEnd || today : seedFromLabel || today);
		pop.createEl('hr', { cls: 'memos-fb-pop-sep' });

		const list = pop.createDiv({ cls: 'memos-fb-pop-list' });
		// Labels the presets don't cover (最近42天, bare dates) stay selectable.
		const extra = !row.timeCustom && row.timeLabel && !TIME_PRESETS.includes(row.timeLabel) ? row.timeLabel : null;
		const presets = extra ? [extra, ...TIME_PRESETS] : [...TIME_PRESETS];
		for (const p of presets) {
			const active = !row.timeCustom && row.timeLabel === p;
			this.popItem(list, p, {
				active,
				check: active,
				onPick: () => {
					row.timeCustom = false;
					row.timeLabel = p;
					this.closeTimePop();
					this.renderRows();
					this.syncText();
				},
			});
		}

		const onDate = () => {
			row.timeCustom = true;
			row.customStart = barA.value;
			row.customEnd = barB.value;
			this.renderTimeLabel(labelEl, row);
			// The bars now own the range — drop any preset highlight.
			list.querySelectorAll('.memos-fb-pop-item-active').forEach((it) =>
				(it as HTMLElement).removeClass('memos-fb-pop-item-active'),
			);
			this.syncText();
		};
		barA.addEventListener('change', onDate);
		barB.addEventListener('change', onDate);

		this.placePopover(pop, trigger, 200);
		// Tapping the 从 / 至 segment on the trigger jumps straight into the
		// matching bar's native picker.
		if (focusBar === 'a') this.openDateBar(barA);
		else if (focusBar === 'b') this.openDateBar(barB);
	}

	/** Focus a date bar and open its native picker where supported. */
	private openDateBar(bar: HTMLInputElement): void {
		bar.focus();
		if (typeof bar.showPicker === 'function') {
			try {
				bar.showPicker();
			} catch {
				// Some platforms refuse without a direct user gesture on the
				// input itself — the bar is focused either way.
			}
		}
	}

	private dateBar(parent: HTMLElement, label: string, value: string): HTMLInputElement {
		const bar = parent.createDiv({ cls: 'memos-fb-pop-date-bar' });
		bar.createSpan({ cls: 'memos-fb-pop-date-label', text: label });
		return bar.createEl('input', {
			type: 'date',
			cls: 'memos-fb-date',
			attr: { value, 'aria-label': label === '从' ? '开始日期' : '结束日期' },
		});
	}

	private closeTimePop(): void {
		this.timePopEl?.remove();
		this.timePopEl = null;
		this.timePopAnchorEl = null;
	}

	private refreshPreview(): void {
		if (!this.previewEl) return;
		const query = this.rowsToText().trim();
		const memos = this.host.getMemos().filter((m) => !m.archived);
		if (!query) {
			this.previewEl.setText(`共 ${memos.length} 条笔记`);
			return;
		}
		const { ast } = parseFilter(query);
		if (!ast) {
			this.previewEl.setText('查询无效');
			return;
		}
		const matched = memos.filter((m) => evalFilter(ast, m)).length;
		this.previewEl.setText(`匹配 ${matched} / ${memos.length} 条笔记`);
	}
}
