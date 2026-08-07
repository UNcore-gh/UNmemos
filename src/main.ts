import {
	App,
	debounce,
	Notice,
	Platform,
	Plugin,
	TFile,
	WorkspaceLeaf,
	WorkspaceParent,
	WorkspaceWindow,
} from 'obsidian';
import { DEFAULT_SETTINGS, type MemosSettings } from './settings';
import { setLang, t, tf, type Lang } from './i18n';
import { applyAccent, clearAccent } from './color';
import * as logger from './logger';
import { MemosStore } from './store';
import { WriteGuard } from './write-guard';
import { MemoWriter } from './writer';
import { parseCanvasMemos } from './parser';
import { migrateToCanvasIfNeeded } from './migrate';
import { cleanupTempEditors, tempRemoveInFlight } from './ui/editor-graft';
import { MemosView, VIEW_TYPE } from './ui/view';
import { MemosSettingTab } from './ui/settings-tab';
import { GlobalMentionManager } from './ui/global-mention';

export default class MemosPlugin extends Plugin {
	settings: MemosSettings = { ...DEFAULT_SETTINGS };
	store = new MemosStore();
	writer!: MemoWriter;
	writeGuard = new WriteGuard();
	globalMention!: GlobalMentionManager;
	private ribbonEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		setLang(this.settings.language);
		applyAccent(this.settings.accentColor);

		// Opt-in debug log (src/logger.ts): silent + zero capture until the
		// user flips the settings switch. The env provider feeds version /
		// platform / settings context into the enable snapshot and exports.
		logger.setEnvProvider(() => this.collectLogEnv());
		logger.setDebugEnabled(this.settings.debugLog);

		await cleanupTempEditors(this.app);

		// Swallow a known CM6 RangeError noise on mobile when detaching grafted
		// editors. The graft no longer reconfigures the live editor mid-flight
		// (that reconfiguration stranded CM6 extensions' StateField references
		// and fired this per keystroke — the iPad typing-lag root cause), so
		// this is now a safety net: log the first few with their stack so any
		// residual source stays reportable, then go quiet.
		let rangeErrLogged = 0;
		const onError = (ev: ErrorEvent) => {
			if (
				ev.error instanceof RangeError &&
				ev.message?.includes('Field is not present in this state')
			) {
				ev.preventDefault();
				ev.stopImmediatePropagation();
				if (rangeErrLogged < 3) {
					rangeErrLogged++;
					logger.warn('swallowed CM6 RangeError:', ev.error.stack);
				}
			}
		};
		window.addEventListener('error', onError);
		this.register(() => window.removeEventListener('error', onError));

		// Debug-log capture hooks (no-op unless the opt-in switch is on).
		// Registered AFTER the swallowers above: errors they silence via
		// stopImmediatePropagation stay out of the buffer, everything else
		// — including errors from other code paths — lands in it.
		const captureError = (ev: ErrorEvent) => {
			if (logger.isDebugEnabled()) {
				logger.error('[window error]', ev.error ?? ev.message);
			}
		};
		window.addEventListener('error', captureError);
		this.register(() => window.removeEventListener('error', captureError));

		// Known core race: removing a graft temp file can make the
		// file-explorer process a deletion for a file it never finished
		// adding — an unhandled `TypeError ... (reading 'children')` from
		// app.js. Harmless; silenced only while a temp removal is in flight
		// (see editor-graft quietRemove) so real errors still surface.
		const onRejection = (ev: PromiseRejectionEvent): void => {
			const r: unknown = ev.reason;
			if (
				tempRemoveInFlight() &&
				r instanceof TypeError &&
				r.message.includes('children')
			) {
				ev.preventDefault();
			}
		};
		window.addEventListener('unhandledrejection', onRejection);
		this.register(() =>
			window.removeEventListener('unhandledrejection', onRejection),
		);

		const captureRejection = (ev: PromiseRejectionEvent) => {
			if (logger.isDebugEnabled()) {
				logger.warn('[unhandled rejection]', ev.reason);
			}
		};
		window.addEventListener('unhandledrejection', captureRejection);
		this.register(() =>
			window.removeEventListener('unhandledrejection', captureRejection),
		);

		this.writeGuard = new WriteGuard();
		this.writer = new MemoWriter(this.app, this.settings, this.writeGuard);

		this.registerView(VIEW_TYPE, (leaf) => new MemosView(leaf, this));

		this.ribbonEl = this.addRibbonIcon('message-square', t('ribbonOpen'), () => {
			// Mobile: behave like the "打开 Memos" command (always open a fresh
			// view) — the smart reveal-or-create below relies on setActiveLeaf,
			// which the phone drawer doesn't surface, so the button felt dead.
			// Desktop keeps the smart reveal to avoid duplicate tabs.
			if (Platform.isMobile) void this.openView();
			else void this.revealOrCreateView();
		});

		this.registerCommands();

		this.addSettingTab(new MemosSettingTab(this.app, this));

		// `@` mention / `@@` quick-create work EVERYWHERE — regular notes
		// (source & live preview) and canvas text nodes, not only the Memos
		// composer. The manager tracks the live editor via the workspace
		// `editor-change` event and skips the plugin's own grafted editors
		// (those carry their own MentionController). Reads
		// settings.globalMention live, so the toggle takes effect without a
		// reload.
		this.globalMention = new GlobalMentionManager({
			enabled: () => this.settings.globalMention,
			getMemos: () => this.store.get().memos,
			onCreateMemo: () => this.createBlankMemoForMention(),
		});
		this.register(() => this.globalMention.destroy());
		// Feed it the live editor of whatever note/canvas text is being
		// edited — the only public channel that survives across Obsidian
		// builds (the CM6 DOM back-references do not).
		this.registerEvent(
			this.app.workspace.on('editor-change', (editor) =>
				this.globalMention.handleEditorChange(editor),
			),
		);

		// Register with the 'Page preview' core plugin as a hover-link emitter, so
		// hovering a [[wiki-link]] in a memo card pops the native preview popup.
		// defaultMod:false → the preview opens on a plain hover (no Cmd held).
		// (registerHoverLinkSource is a Plugin method, not a Workspace method.)
		this.registerHoverLinkSource('memos', {
			display: 'Memos',
			defaultMod: false,
		});

		this.registerEvent(
			this.app.vault.on(
				'modify',
				debounce(
					(file) => {
						if (!(file instanceof TFile) || file.extension !== 'canvas') return;
						if (this.writeGuard.isOwnWrite(file.path)) return;
						if (this.isStorageFile(file.path)) void this.reloadMemos();
					},
					300,
					true,
				),
			),
		);

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (!(file instanceof TFile) || file.extension !== 'canvas') return;
				if (this.isStorageFile(file.path)) void this.reloadMemos();
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (!(file instanceof TFile) || file.extension !== 'canvas') return;
				if (this.isStorageFile(file.path)) void this.reloadMemos();
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile) || file.extension !== 'canvas') return;
				if (this.isStorageFile(file.path) || this.isStorageFile(oldPath)) {
					void this.reloadMemos();
				}
			}),
		);

		// Defer migration + initial load until vault file index is ready.
		this.app.workspace.onLayoutReady(() => {
			void migrateToCanvasIfNeeded(
				this.app,
				this.settings,
				this.writeGuard,
				() => this.saveSettings(),
			).then((migrated) => {
				void this.reloadMemos().then(() => {
					// Apply the retention policy once at startup (covers time
					// passed while Obsidian was closed).
					void this.purgeExpiredArchived();
				});
				if (migrated) {
					// Refresh any open view
					for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
						if (leaf.view instanceof MemosView) {
							void leaf.view.onClose();
							void leaf.view.onOpen();
						}
					}
				}
			});
		});

		// Re-check the archive retention policy hourly while running.
		this.registerInterval(
			window.setInterval(() => {
				void this.purgeExpiredArchived();
			}, 3600000),
		);

		logger.info('plugin loaded');
	}

	onunload(): void {
		// Safety net: if a view's onClose flushDraft raced with app exit,
		// the in-memory settings are correct but the disk write may not
		// have landed. Persist once more here so data.json is authoritative.
		void this.saveSettings();
		logger.info('plugin unloaded');
		this.writeGuard.destroy();
		this.store.destroy();
		clearAccent();
	}

	async reloadMemos(): Promise<void> {
		const files = this.getStorageFiles();
		const all = [];
		for (const file of files) {
			try {
				const text = await this.app.vault.read(file);
				const memos = parseCanvasMemos(text, file.path);
				all.push(...memos);
			} catch (e) {
				logger.error('Failed to read', file.path, e);
			}
		}
		this.store.update({ memos: all, isLoading: false });
		logger.info(`reloaded ${all.length} memos from ${files.length} file(s)`);
	}

	/**
	 * Delete archived memos older than `settings.archiveRetentionDays`.
	 * 0 (the default) disables purging entirely. Memos archived before the
	 * archivedAt timestamp existed carry none and are ALWAYS kept — deleting
	 * data whose age we cannot prove would be unsafe. Runs at startup, hourly,
	 * and right after the retention setting changes.
	 */
	async purgeExpiredArchived(): Promise<void> {
		const days = this.settings.archiveRetentionDays;
		if (!days || days <= 0) return;
		const cutoff = Date.now() - days * 86400000;
		const expired = this.store.get().memos.filter((m) => {
			if (!m.archived || !m.archivedAt) return false;
			const t = Date.parse(m.archivedAt);
			return Number.isFinite(t) && t < cutoff;
		});
		if (expired.length === 0) return;
		for (const m of expired) {
			await this.writer.deleteMemo(m);
		}
		await this.reloadMemos();
		logger.info(`purged ${expired.length} expired archived memo(s)`);
		new Notice(tf('purgeNotice', { n: expired.length }));
	}

	/**
	 * Open Memos in a NEW main-pane tab — always a fresh view, even when a
	 * sidebar Memos instance is already open. (Each view rebuilds its own
	 * grafted editor on re-show, so main + sidebar can coexist without the
	 * blank bug.) Then focus its composer so capture can start immediately.
	 */
	async openView(): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
		this.focusLeafView(leaf);
	}

	/**
	 * Ribbon entry point: reveal an already-open Memos view when one
	 * exists, open a fresh tab otherwise. Unlike the openView() command,
	 * clicking the ribbon never spawns duplicate tabs.
	 */
	private async revealOrCreateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.setActiveLeaf(existing[0]!);
			return;
		}
		await this.openView();
	}

	/**
	 * Open (or MOVE) the Memos view into the RIGHT sidebar, then focus its
	 * composer. Three cases:
	 *  - already docked right → reveal that exact instance (expanding a
	 *    collapsed dock) and focus it;
	 *  - open elsewhere (tab / left dock) → detach those leaves and dock a
	 *    fresh one on the right, so the command always ends with Memos IN
	 *    the sidebar;
	 *  - not open → take the right leaf and set the view on it.
	 * On mobile the right split is a swipe-open drawer (WorkspaceMobileDrawer)
	 * rather than a persistent sidedock; the same dock path applies — reveal
	 * plus expand swings the drawer open — and any failure falls back to a
	 * main-pane tab so the command always ends with Memos visible.
	 */
	async openViewInSidebar(): Promise<void> {
		try {
			const dock = this.app.workspace.rightSplit;
			const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
			// Membership by parent-chain walk, not getRoot() identity: on
			// mobile the dock is a WorkspaceMobileDrawer, and leaves inside
			// it don't always report it from getRoot() the way a desktop
			// WorkspaceSidedock's do.
			const docked = existing.find((l) => isInsideSplit(l, dock));
			if (docked) {
				await this.app.workspace.revealLeaf(docked);
				if (dock.collapsed) dock.expand();
				this.focusLeafView(docked);
				return;
			}
			// Prefer moving an existing (main-pane) Memos leaf INTO the dock —
			// the grafted editor and its state travel with the leaf, no re-graft,
			// no flash. A leaf in a popout window is a different document — can't
			// move that, rebuild instead.
			const movable = existing.find(
				(l) => !(l.getRoot() instanceof WorkspaceWindow),
			);
			if (movable && (await this.moveLeafToDock(movable, dock))) {
				await this.app.workspace.revealLeaf(movable);
				if (dock.collapsed) dock.expand();
				this.focusLeafView(movable);
				return;
			}
			// Move unavailable — tear down existing and rebuild in the dock.
			for (const leaf of existing) {
				const view = leaf.view as MemosView | null;
				leaf.detach();
				if (view) await view.teardown();
			}
			// ensureSideLeaf is the mobile-aware docking helper: it creates /
			// reuses a leaf in the side dock — or the phone's swipe drawer —
			// correctly, where getRightLeaf + revealLeaf could end up with an
			// invisible leaf. Purpose-built since Obsidian 1.7.2 (our
			// minAppVersion), so it is always present at runtime.
			const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE, 'right', {
				active: true,
				reveal: true,
			});
			if (!(leaf.view instanceof MemosView)) {
				await leaf.setViewState({ type: VIEW_TYPE, active: true });
			}
			await this.app.workspace.revealLeaf(leaf);
			if (dock.collapsed) dock.expand();
			this.focusLeafView(leaf);
		} catch (e) {
			logger.warn('sidebar dock failed, opening a tab instead:', e);
			await this.openView();
		}
	}

	/**
	 * Open (or MOVE) the single Memos view into its own popout OS window —
	 * handy for dragging to a second monitor. Single-instance by design:
	 *  - already popped out → just bring that window forward and focus it
	 *    (never spawn a second Memos window);
	 *  - open in the main window (tab / sidebar) → close it and reopen in a
	 *    fresh popout. We recreate rather than moveLeafToPopout() because a
	 *    popout lives in a SEPARATE document, and dragging the grafted CM6
	 *    editor across documents is fragile — a clean rebuild in the new
	 *    document is safer;
	 *  - not open → openPopoutLeaf() + set the view.
	 * Popout windows are desktop-only; on mobile openPopoutLeaf() throws, so
	 * we fall back to a normal tab.
	 */
	async openViewInWindow(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		const popped = existing.find((l) => l.getRoot() instanceof WorkspaceWindow);
		if (popped) {
			await this.app.workspace.revealLeaf(popped);
			this.focusLeafView(popped);
			return;
		}
		for (const leaf of existing) {
			const view = leaf.view as MemosView | null;
			leaf.detach();
			// Same teardown-await as openViewInSidebar — never let a half-destroyed
			// grafted editor coexist with the replacement view's CM6 init.
			if (view) await view.teardown();
		}
		try {
			const leaf = this.app.workspace.openPopoutLeaf();
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
			await this.app.workspace.revealLeaf(leaf);
			this.focusLeafView(leaf);
		} catch {
			// No popout support (mobile) — open as a regular tab instead.
			await this.openView();
		}
	}

	/** Focus the Memos view inside a leaf (no-op if it isn't one yet). */
	private focusLeafView(leaf: WorkspaceLeaf): void {
		if (leaf.view instanceof MemosView) leaf.view.focusEditor();
	}

	/**
	 * Move an existing Memos leaf into the side dock WITHOUT recreating its
	 * view — the grafted CM6 editor and its composer state travel with the
	 * leaf, so no re-graft, no flash, and no second editor is ever created.
	 * Uses the internal Workspace.moveLeafTo; returns false when unavailable.
	 */
	private async moveLeafToDock(
		leaf: WorkspaceLeaf,
		dock: WorkspaceParent,
	): Promise<boolean> {
		try {
			const ws = this.app.workspace as unknown as {
				moveLeafTo?: (
					leaf: WorkspaceLeaf,
					parent: WorkspaceParent,
					index: number,
				) => boolean;
			};
			if (typeof ws.moveLeafTo !== 'function') return false;
			return !!ws.moveLeafTo(leaf, dock, 0);
		} catch {
			return false;
		}
	}

	/**
	 * Focus the composer of an ALREADY OPEN Memos view — never opens a new
	 * view itself (falls back to openView() when no instance exists).
	 * Priority order:
	 *  1. the active leaf is Memos → focus in place, no navigation;
	 *  2. an instance docked in the left/right sidebar (first choice when
	 *     we have to navigate — the sidebar is where Memos lives for
	 *     quick capture);
	 *  3. a main-area tab / split;
	 *  4. a popout window (lowest — the window is just brought forward).
	 */
	async focusMemosEditor(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length === 0) {
			await this.openView();
			return;
		}
		const active = this.app.workspace.getMostRecentLeaf();
		if (active && leaves.includes(active)) {
			this.focusLeafView(active);
			return;
		}
		const inSidebar = leaves.find((l) => {
			const root = l.getRoot();
			return (
				root === this.app.workspace.leftSplit ||
				root === this.app.workspace.rightSplit
			);
		});
		if (inSidebar) {
			await this.app.workspace.revealLeaf(inSidebar);
			this.focusLeafView(inSidebar);
			return;
		}
		const inMain = leaves.find(
			(l) => !(l.getRoot() instanceof WorkspaceWindow),
		);
		const target = inMain ?? leaves[0]!;
		await this.app.workspace.revealLeaf(target);
		this.focusLeafView(target);
	}

	/**
	 * Create a brand-new BLANK memo and return its ref coordinates — the
	 * `@@` quick-create backend for the global mention manager (notes and
	 * canvas text nodes). The typed name is only used as the link's display
	 * text; the card itself stays empty.
	 */
	private async createBlankMemoForMention(): Promise<{
		sourceFile: string;
		id: string;
	} | null> {
		try {
			const memo = await this.writer.insertMemo('');
			await this.reloadMemos();
			return { sourceFile: memo.sourceFile, id: memo.id };
		} catch (e) {
			logger.error('Failed to create blank memo:', e);
			return null;
		}
	}

	/** Open the app settings dialog on the Memos tab. */
	private openSettings(): void {
		// `setting` exists on App at runtime but not in the public typings.
		const app = this.app as App & {
			setting?: { open?: () => void; openTabById?: (id: string) => unknown };
		};
		app.setting?.open?.();
		app.setting?.openTabById?.(this.manifest.id);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<MemosSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	/**
	 * (Re-)register the plugin commands with names in the active language.
	 * Called at load and again whenever the settings language switch is
	 * flipped. Removing first keeps the ids stable, so any hotkeys the
	 * user customized in Obsidian's hotkey settings survive the swap.
	 * Legacy ids ('new-memo', 'open-memos-another') are removed without
	 * replacement — their behaviour folded into 'open-memos-view', which
	 * now always opens a fresh view.
	 */
	registerCommands(): void {
		// `commands` exists on App at runtime but not in the public typings.
		const commands = (this.app as unknown as {
			commands?: { removeCommand?: (id: string) => void };
		}).commands;
		for (const id of [
			'open-memos-view',
			'open-memos-in-sidebar',
			'open-memos-in-window',
			'focus-memos-editor',
			'open-memos-settings',
			// Legacy — no longer registered, just cleaned up.
			'new-memo',
			'open-memos-another',
		]) {
			commands?.removeCommand?.(`${this.manifest.id}:${id}`);
		}
		this.addCommand({
			id: 'open-memos-view',
			name: t('cmdOpenView'),
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'M' }],
			callback: () => void this.openView(),
		});
		this.addCommand({
			id: 'open-memos-in-sidebar',
			name: t('cmdOpenSidebar'),
			callback: () => void this.openViewInSidebar(),
		});
		this.addCommand({
			id: 'open-memos-in-window',
			name: t('cmdOpenWindow'),
			callback: () => void this.openViewInWindow(),
		});
		this.addCommand({
			id: 'focus-memos-editor',
			name: t('cmdFocusEditor'),
			callback: () => void this.focusMemosEditor(),
		});
		this.addCommand({
			id: 'open-memos-settings',
			name: t('cmdOpenSettings'),
			callback: () => this.openSettings(),
		});
	}

	/** Switch the settings/command language at runtime. */
	async applyLanguage(lang: Lang): Promise<void> {
		this.settings.language = lang;
		setLang(lang);
		await this.saveSettings();
		this.registerCommands();
		this.ribbonEl?.setAttribute('aria-label', t('ribbonOpen'));
	}

	/** Change the accent color at runtime: persist it, then re-publish the
	 *  CSS vars on <body> so every open view/popover re-themes immediately. */
	async setAccent(hex: string): Promise<void> {
		this.settings.accentColor = hex;
		await this.saveSettings();
		applyAccent(hex);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Keep the debug-log capture switch in lockstep with the setting —
		// every toggle flows through saveSettings, so this single sync point
		// covers load, the settings tab, and programmatic saves.
		logger.setDebugEnabled(this.settings.debugLog);
		this.writer = new MemoWriter(this.app, this.settings, this.writeGuard);
	}

	/** Version / platform / settings context for the debug-log report.
	 * composerDraft is user-typed text — excluded even from opt-in exports. */
	private collectLogEnv(): Record<string, string> {
		const { composerDraft: _draft, ...safe } = this.settings;
		void _draft;
		// `version` is exposed on App at runtime but not in the typings.
		const appVersion = (this.app as App & { version?: string }).version;
		return {
			'plugin version': this.manifest.version,
			'obsidian version': appVersion ?? 'unknown',
			platform: Platform.isMobileApp
				? Platform.isIosApp
					? 'iOS app'
					: 'Android app'
				: Platform.isMobile
					? 'mobile'
					: 'desktop',
			settings: JSON.stringify(safe),
		};
	}

	getStorageFiles(): TFile[] {
		const path = this.settings.storagePath;
		if (path.includes('{year}')) {
			const slash = path.lastIndexOf('/');
			const dir = slash > 0 ? path.substring(0, slash) : '';
			const re = new RegExp('^' + escapeRegExp(dir) + '/\\d{4}\\.canvas$');
			return this.app.vault.getFiles().filter((f) => re.test(f.path));
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? [file] : [];
	}

	isStorageFile(path: string): boolean {
		const tpl = this.settings.storagePath;
		if (tpl.includes('{year}')) {
			const slash = tpl.lastIndexOf('/');
			const dir = slash > 0 ? tpl.substring(0, slash) : '';
			return new RegExp('^' + escapeRegExp(dir) + '/\\d{4}\\.canvas$').test(path);
		}
		return path === tpl;
	}
}

/** True when `leaf` sits inside `split` — walks the layout parent chain,
 * which is robust for mobile drawers: leaves in a WorkspaceMobileDrawer do
 * not always report it from getRoot(), unlike a desktop WorkspaceSidedock. */
function isInsideSplit(leaf: WorkspaceLeaf, split: WorkspaceParent): boolean {
	for (let p: WorkspaceParent | null = leaf.parent; p; p = p.parent) {
		if (p === split) return true;
	}
	return false;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
