import { App, Editor, MarkdownView, Platform, Workspace, WorkspaceLeaf, WorkspaceSplit } from 'obsidian';
import { cssProps } from '../css-props';

const POLL_MS = 50;

export interface GraftedEditorHandle {
	editor: Editor;
	view: MarkdownView;
	isLivePreview: boolean;
	destroy: () => void;
}

/* ── Mobile quick-edit toolbar integration ─────────────────
 *
 * Obsidian's native mobile toolbar (`app.mobileToolbar`, the formatting
 * bar above the soft keyboard) shows when
 * `workspace.activeEditor?.editor.hasFocus()` is true, and its buttons
 * run `editor:*` commands, which resolve their target the same way:
 * `workspace.activeEditor`.
 *
 * That getter is `_activeEditor ?? getActiveViewOfType(MarkdownView)`.
 * Our grafted editor's MarkdownView lives in a DETACHED leaf, so the
 * fallback never finds it — which is exactly why the toolbar refuses to
 * appear in this plugin. The public `activeEditor` setter cannot help:
 * it deliberately ignores MarkdownView instances (Obsidian assumes the
 * active leaf covers those). So while the grafted editor holds focus we
 * write `_activeEditor` directly. Toolbar buttons then behave exactly as
 * they do in a real note, because the command system receives the real
 * MarkdownView + Editor pair.
 */

interface MobileToolbarHost extends App {
	mobileToolbar?: {
		update: () => void;
		animateToKeyboardHeight?: () => void;
	};
}

interface ActiveEditorWorkspace extends Workspace {
	_activeEditor?: unknown;
}

/** A minimal stand-in owner accepted by the public `activeEditor` setter. */
interface EditorOwnerLike {
	editor: Editor;
	view: MarkdownView;
	getMode: () => string;
}

/** Toolbars already patched (per-instance, so a recreated toolbar re-patches). */
const patchedToolbars = new WeakSet<object>();

/** Neutralize the core's keyboard-follow transform animation once. The styles.css
 * is-tablet block already pins the toolbar with top:calc(100vh - …) plus
 * transform/transition:none; but the core's animateToKeyboardHeight writes an
 * inline translateY via a CSS transition whose transient value outranks even
 * !important — the method must be emptied or the toolbar jumps to the
 * double-counted ~363 position. One-time, no runtime cost after patch. */
function neutralizeToolbarKeyboardAnim(app: App): void {
	const mt = (app as unknown as MobileToolbarHost).mobileToolbar;
	// Android gates toolbar visibility on the keyboard being up and doesn't
	// have the iPad double-count — keep its core behavior untouched.
	if (!mt || Platform.isAndroidApp) return;
	if (patchedToolbars.has(mt)) return;
	patchedToolbars.add(mt);
	if (typeof mt.animateToKeyboardHeight === 'function') {
		mt.animateToKeyboardHeight = () => {};
	}
}

export function claimMobileActiveEditor(
	app: App,
	view: MarkdownView,
	/** Force the toolbar refresh even when the claim is unchanged — the
	 * focusin path needs this: the idempotent skip would otherwise leave the
	 * toolbar hidden when the pointerdown update ran before focus landed. */
	force = false,
): void {
	if (!Platform.isMobile) return;
	const ws = app.workspace as unknown as ActiveEditorWorkspace;
	// iOS refocuses around IME gestures, firing focusin several times per
	// keyboard cycle. Each claim used to rewrite _activeEditor and rebuild
	// the ~15-button mobile toolbar — a visible iPad hitch. Skip both when
	// this view already holds the claim.
	let changed = false;
	try {
		if ('_activeEditor' in ws) {
			if (ws._activeEditor !== view) {
				ws._activeEditor = view;
				changed = true;
			}
		} else {
			const cur = (ws as unknown as { activeEditor?: { view?: unknown } })
				.activeEditor;
			if (!cur || cur.view !== view) {
				// Internals renamed: the public setter stores anything that is
				// not a MarkdownView instance, so hand it a minimal owner.
				const owner: EditorOwnerLike = {
					editor: view.editor,
					view,
					getMode: () => 'source',
				};
				(ws as unknown as { activeEditor: unknown }).activeEditor = owner;
				changed = true;
			}
		}
	} catch {
		/* toolbar simply stays hidden — editing still works */
	}
	if (changed || force) {
		try {
			neutralizeToolbarKeyboardAnim(app);
			(app as unknown as MobileToolbarHost).mobileToolbar?.update();
		} catch {
			/* ignore */
		}
	}
}

export function releaseMobileActiveEditor(app: App, view: MarkdownView): void {
	if (!Platform.isMobile) return;
	const ws = app.workspace as unknown as ActiveEditorWorkspace;
	try {
		if ('_activeEditor' in ws) {
			if (ws._activeEditor === view) ws._activeEditor = null;
		} else {
			const cur = (ws as unknown as { activeEditor?: { view?: unknown } })
				.activeEditor;
			if (cur && cur.view === view) {
				(ws as unknown as { activeEditor: unknown }).activeEditor = null;
			}
		}
	} catch {
		/* ignore */
	}
	try {
		(app as unknown as MobileToolbarHost).mobileToolbar?.update();
	} catch {
		/* ignore */
	}
}

/** Safely call Workspace.setActiveLeaf via prototype chain (mobile-safe). */
export function safeSetActiveLeaf(
	app: App,
	leaf: WorkspaceLeaf,
	focus = false,
): string {
	try {
		interface WsProto {
			setActiveLeaf?: (leaf: WorkspaceLeaf, opts?: { focus?: boolean }) => void;
		}
		const ws = app.workspace;
		let proto: WsProto | null = Object.getPrototypeOf(ws) as WsProto | null;
		while (
			proto &&
			!Object.prototype.hasOwnProperty.call(proto, 'setActiveLeaf')
		) {
			proto = Object.getPrototypeOf(proto) as WsProto | null;
		}
		if (!proto) return 'no-proto';
		proto.setActiveLeaf?.call(ws, leaf, { focus });
		return 'ok';
	} catch (e) {
		return 'err:' + String(e).slice(0, 60);
	}
}

function stripChrome(host: HTMLElement): void {
	host
		.querySelectorAll('.embedded-backlinks, .backlink-pane, .outline-pane')
		.forEach((el) => el.remove());
}

/** Mobile: only touch .cm-content editability — never .cm-editor user-modify. */
export function applyMobileEditability(host: HTMLElement): void {
	if (!Platform.isMobile) return;
	const apply = () => {
		const editor = host.querySelector<HTMLElement>('.cm-editor');
		const content = host.querySelector<HTMLElement>('.cm-content');
		for (const el of [editor, content]) {
			if (!el) continue;
			cssProps(el, {
				userSelect: 'text',
				touchAction: 'manipulation',
				pointerEvents: 'auto',
			});
			// Legacy vendor prefix — still needed by some mobile webviews.
			(el.style as unknown as Record<string, string>).webkitUserSelect = 'text';
		}
		if (content) {
			content.setAttribute('contenteditable', 'true');
			(
				content.style as CSSStyleDeclaration & { webkitUserModify?: string }
			).webkitUserModify = 'read-write';
		}
	};
	apply();
	window.requestAnimationFrame(apply);
}

/** Seed the DOM selection at `offset` (default: doc start) BEFORE the
 * editor is focused. iOS places the caret at the END when a contenteditable
 * with no existing selection is focused programmatically (CM6's focus
 * handler then reads that DOM position back into state) — pre-seeding the
 * selection is the standard mobile recipe: focus() finds an existing
 * selection, honours it, and the soft keyboard opens at that position.
 * On desktop this is a harmless no-op equivalent to a setCursor. */
export function seedDomCaret(
	editor: Editor,
	offset = 0,
	doc: Document = document,
): void {
	try {
		const cm = (
			editor as Editor & {
				cm?: { domAtPos?: (pos: number) => { node: Node; offset: number } };
			}
		).cm;
		if (!cm?.domAtPos) return;
		const pos = cm.domAtPos(offset);
		const range = doc.createRange();
		range.setStart(pos.node, pos.offset);
		range.setEnd(pos.node, pos.offset);
		const sel = doc.getSelection();
		if (!sel) return;
		sel.removeAllRanges();
		sel.addRange(range);
	} catch {
		/* focus falls back to the platform's default placement */
	}
}

/* ── Offscreen editor hosting ──────────────────────────────
 *
 * To obtain a real Obsidian MarkdownView/CM6 editor we must create a
 * workspace leaf. The old approach used `getLeaf('split')`, which splits
 * the user's visible panes for the (async) duration of editor init — on
 * iPad that rendered as a brief, jarring split-screen flash. Instead we
 * build a DETACHED WorkspaceSplit whose container we park offscreen and
 * create the leaf inside it via the internal `createLeafInParent` (the
 * same mechanism obsidian-hover-editor uses to host leaves). The user's
 * layout is never touched on any platform, so there is nothing to flash.
 */

interface HiddenLeaf {
	leaf: WorkspaceLeaf;
	/** Remove the detached split's container from the DOM. */
	teardown: () => void;
}

interface WorkspaceInternals extends Workspace {
	createLeafInParent: (parent: WorkspaceSplit, index: number) => WorkspaceLeaf;
	setActiveLeaf: (leaf: WorkspaceLeaf, params?: unknown) => void;
}

/** A WorkspaceSplit that exposes its (internal) container element. */
type WorkspaceSplitWithEl = WorkspaceSplit & { containerEl: HTMLElement };

function spawnHiddenLeaf(app: App, holder: HTMLElement): HiddenLeaf {
	const ws = app.workspace as unknown as WorkspaceInternals;
	const SplitCtor = WorkspaceSplit as unknown as new (
		workspace: Workspace,
		direction: 'vertical' | 'horizontal',
	) => WorkspaceSplitWithEl;
	const split = new SplitCtor(app.workspace, 'vertical');
	// The detached split has no ancestor chain; point root/container at the
	// real workspace root so internal sizing/measure code has something sane.
	const splitPatch = split as unknown as {
		getRoot: () => unknown;
		getContainer: () => unknown;
	};
	splitPatch.getRoot = () => app.workspace.rootSplit;
	splitPatch.getContainer = () => app.workspace.rootSplit;
	holder.appendChild(split.containerEl);

	// createLeafInParent() activates the new leaf — stub setActiveLeaf so we
	// don't steal focus or move the user's active tab.
	const realSetActiveLeaf = ws.setActiveLeaf;
	ws.setActiveLeaf = () => {};
	let leaf: WorkspaceLeaf;
	try {
		leaf = ws.createLeafInParent(split, 0);
	} finally {
		ws.setActiveLeaf = realSetActiveLeaf;
	}

	return {
		leaf,
		teardown: () => {
			try {
				split.containerEl.detach();
			} catch {
				split.containerEl.remove();
			}
		},
	};
}

/** Offscreen but fully rendered (not display:none / visibility:hidden) so
 * CM6 measures real dimensions and initializes its editor reliably. */
function createGraftHolder(): HTMLElement {
	return document.body.createDiv({
		cls: 'memos-graft-holder',
		attr: {
			style:
				'position:absolute;left:-99999px;top:0;width:320px;height:240px;' +
				'pointer-events:none;overflow:hidden;',
		},
	});
}

function detectLivePreview(
	host: HTMLElement | null,
	label = '',
	skipCss = false,
): boolean {
	try {
		if (!host) return false;
		if (!skipCss) {
			const sv = host.querySelector('.markdown-source-view');
			if (
				sv &&
				(sv.classList.contains('is-live-preview') ||
					sv.classList.contains('mod-live-preview'))
			) {
				return true;
			}
		}
		const formatting = host.querySelectorAll('.cm-formatting');
		for (let n = 0; n < Math.min(formatting.length, 10); n++) {
			const o = formatting[n] as HTMLElement;
			const a = o.style;
			if (
				a.display === 'none' ||
				a.fontSize === '0px' ||
				a.width === '0px' ||
				o.classList.contains('cm-hidden') ||
				o.getAttribute('aria-hidden') === 'true'
			) {
				return true;
			}
			const cs = window.getComputedStyle(o);
			if (
				cs.display === 'none' ||
				cs.fontSize === '0px' ||
				parseFloat(cs.width) === 0
			) {
				return true;
			}
		}
		const headerLine = host.querySelector('.cm-line.HyperMD-header');
		if (headerLine) {
			const n = headerLine.querySelector('.cm-header');
			if (n) {
				const a = parseFloat(window.getComputedStyle(n).fontSize);
				const other =
					host.querySelector('.cm-line:not(.HyperMD-header)') ?? headerLine;
				const m = parseFloat(window.getComputedStyle(other).fontSize);
				if (a > m * 1.05) return true;
			}
		}
		return !!host.querySelector('.cm-embed-block');
	} catch {
		return false;
	}
}

function viewHasLivePreview(view: MarkdownView, label = ''): boolean {
	return detectLivePreview(view.containerEl, label);
}

/**
 * Graft a real Obsidian MarkdownView/CM6 editor into `host`.
 * Creates a temp file, opens it in an OFFSCREEN detached leaf (never in the
 * user's layout), steals the editor DOM, tears the leaf down, and neutralizes
 * CM destroy so the editor survives inside `host`.
 *
 * SERIALISED through graftQueue: init temporarily stubs the global
 * workspace.setActiveLeaf and reuses a shared temp-file convention, so two
 * grafts initialising at once would corrupt each other — worst case a
 * botched restore leaves setActiveLeaf permanently stubbed, which breaks
 * focus/tab-switching for ALL of Obsidian, not just this plugin. Running
 * grafts one at a time (this also covers several live editors, e.g. the
 * composer + an inline card edit + a second Memos view) removes the race.
 */
let graftQueue: Promise<unknown> = Promise.resolve();

/** Chain of in-flight editor TEARDOWNS. `graftNativeEditor` waits on this
 * before grafting, so a newly created Memos view never initializes its CM6
 * while another grafted editor is being destroyed — the coexistence race that
 * leaves the new composer blank until clicked ("only when the main pane is
 * Memos": the main view is mid-detach while the sidebar view grafts). */
let teardownChain: Promise<void> = Promise.resolve();

/** Queue an editor teardown (CM6 destroy + temp-file removal) behind any
 * already-queued ones. Callers MUST invoke this synchronously before the
 * replacement view's graft reads the chain, or the ordering is lost. */
export function queueEditorTeardown(fn: () => Promise<void> | void): void {
	teardownChain = teardownChain.then(fn).catch(() => {});
}

/* ── Temp-file removal noise ───────────────────────────────
 *
 * A graft creates and deletes its temp file within ~1s. Obsidian's
 * file-explorer occasionally processes the deletion before it finishes
 * adding the file and throws an unhandled
 * `TypeError: Cannot read properties of null (reading 'children')` deep in
 * app.js. Harmless (the graft already succeeded), but it spams the console
 * and looks like the plugin is broken. While a removal window is open,
 * main.ts silences exactly that rejection.
 */
let tempRemoveWindows = 0;

/** True while (and briefly after) a graft temp-file removal is in flight. */
export function tempRemoveInFlight(): boolean {
	return tempRemoveWindows > 0;
}

async function quietRemove(app: App, path: string): Promise<void> {
	tempRemoveWindows++;
	window.setTimeout(() => {
		tempRemoveWindows = Math.max(0, tempRemoveWindows - 1);
	}, 3000);
	await app.vault.adapter.remove(path).catch(() => {});
}

export function graftNativeEditor(
	app: App,
	host: HTMLElement,
	initialContent: string,
	tempPath: string,
	timeoutMs = 6000,
	wantLivePreview = true,
): Promise<GraftedEditorHandle> {
	const run = async (): Promise<GraftedEditorHandle> => {
		// Never graft while another editor is mid-teardown — the coexistence
		// race that blanks the new composer until it is clicked.
		await teardownChain;
		return graftNativeEditorImpl(
			app,
			host,
			initialContent,
			tempPath,
			timeoutMs,
			wantLivePreview,
		);
	};
	// Run after everything queued so far, whether those succeeded or threw.
	const result = graftQueue.then(run, run);
	// Keep the queue alive even if THIS graft fails, so later grafts still go.
	graftQueue = result.catch(() => {
		/* swallow — the caller already receives the rejection via `result` */
	});
	return result;
}

async function graftNativeEditorImpl(
	app: App,
	host: HTMLElement,
	initialContent: string,
	tempPath: string,
	timeoutMs = 6000,
	wantLivePreview = true,
): Promise<GraftedEditorHandle> {
	let leaf: WorkspaceLeaf | null = null;
	let hidden: HiddenLeaf | null = null;
	let holder: HTMLElement | null = null;
	let realDestroy: (() => void) | null = null;

	try {
		if (await app.vault.adapter.exists(tempPath)) {
			await quietRemove(app, tempPath);
		}
		await app.vault.create(tempPath, initialContent);

		// Host the editor in a detached split parked offscreen — the user's
		// panes are never split/resized, so no flash on any platform.
		holder = createGraftHolder();
		hidden = spawnHiddenLeaf(app, holder);
		leaf = hidden.leaf;
		await leaf.setViewState({
			type: 'markdown',
			state: wantLivePreview
				? { file: tempPath, mode: 'source', source: false }
				: { file: tempPath, mode: 'source' },
			active: false,
		});

		let view: MarkdownView | null = null;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			view = (leaf.view as MarkdownView) ?? null;
			if (view?.editor && view.containerEl.querySelector('.cm-editor')) break;
			view = null;
			await new Promise((r) => window.setTimeout(r, POLL_MS));
		}
		if (!view?.editor) throw new Error(`editor not ready within ${timeoutMs}ms`);

		let isLivePreview = false;
		if (wantLivePreview) {
			// A detached leaf cannot (and must not) be activated, so live preview
			// comes from the `source:false` view state alone (set above). DETECT
			// it, but never mutate: the old fallbacks re-called
			// sourceMode.setLivePreview(true) and re-ran leaf.setViewState on the
			// LIVE editor, and each mid-life reconfiguration stranded CM6
			// extensions' StateField references — "Field is not present in this
			// state" thrown inside the per-keystroke update cycle aborted DOM /
			// selection sync, and iOS CM6 fell back to poll-based catch-up: the
			// 1–2s "input lands late" lag. If LP hasn't kicked in from the birth
			// state alone, accept it: the editor stays fully usable, just
			// detected as non-LP (a cosmetic gutter/class difference).
			isLivePreview = viewHasLivePreview(view);
			if (!isLivePreview) {
				const lpDeadline = Date.now() + 400;
				while (Date.now() < lpDeadline && !(isLivePreview = viewHasLivePreview(view))) {
					await new Promise((r) => window.setTimeout(r, 50));
				}
			}
			if (isLivePreview) await new Promise((r) => window.setTimeout(r, 120));
		}

		const sourceView =
			view.containerEl.querySelector('.markdown-source-view') ??
			view.containerEl.querySelector('.cm-editor')?.parentElement;
		// Remove any host fallback surface (e.g. the composer's persistent
		// .memos-editor-textarea) BEFORE grafting CM6 in — otherwise textarea +
		// CM6 coexist in the same flow for one frame and the box spikes to
		// max-height (a visible jump even with matched min-heights).
		host.querySelector('textarea.memos-editor-textarea')?.remove();
		if (sourceView) host.appendChild(sourceView);
		else host.appendChild(view.contentEl);

		stripChrome(host);
		applyMobileEditability(host);
		view.editor.refresh();

		const editor = view.editor;
		window.requestAnimationFrame(() => {
			try {
				view.editor.refresh();
				(
					editor as Editor & { cm?: { requestMeasure?: () => void } }
				).cm?.requestMeasure?.();
			} catch {
				/* ignore */
			}
		});

		const cm = (view.editor as Editor & { cm?: { destroy?: () => void } }).cm;
		if (!cm || typeof cm.destroy !== 'function') {
			throw new Error('could not reach the CM6 view');
		}
		realDestroy = cm.destroy.bind(cm);
		cm.destroy = () => {
			/* neutralize — host owns lifetime */
		};

		const mdView = view as MarkdownView & {
			onClose?: () => Promise<void>;
			unload?: () => void;
		};
		const realUnload = mdView.unload?.bind(view) ?? null;
		mdView.onClose = async () => {};
		mdView.unload = () => {};
		// Kill the autosave pipeline too: TextFileView's editor-change wiring
		// still calls requestSave() while the user types, debouncing into
		// save() → vault.modify — against the temp file we delete right
		// below. On iPad that meant periodic ghost-file recreation, metadata
		// re-indexing and sync churn mid-typing. Instance-shadow both (public
		// TextFileView API); any this.save() inside realUnload's original
		// chain then dispatches into the no-op, which is strictly safer now
		// that the backing file is gone.
		mdView.requestSave = () => {};
		mdView.save = async () => {};
		// The leaf would title itself after the temp file's basename
		// (memos-temp-editor-…). Once the composer is claimed as the
		// workspace's active editor, Obsidian's mobile header/tab reads this
		// view's display text — surface a proper name instead of the leak.
		mdView.getDisplayText = () => 'Memos';
		// Kill the never-unloaded preview machinery too: with mdView.unload a
		// no-op, previewMode's workspace handlers (css-change / resize / layout-
		// change → rerender) survive forever, and each iPad keyboard frame could
		// queue a full MarkdownRenderer pass over the composer content — the
		// keyboard expand/collapse hitch. The composer never displays the preview
		// tab; shadow its render entry point (same instance-shadow pattern).
		const preview = (
			view as MarkdownView & {
				previewMode?: { rerender?: () => void };
			}
		).previewMode;
		if (preview && typeof preview.rerender === 'function') {
			preview.rerender = () => {};
		}

		leaf.detach();
		leaf = null;
		hidden?.teardown();
		hidden = null;
		holder?.remove();
		holder = null;
		await quietRemove(app, tempPath);
		stripChrome(host);
		applyMobileEditability(host);

		const stillAlive =
			!!host.querySelector('.cm-editor') &&
			(() => {
				try {
					view.editor.getValue();
					return true;
				} catch {
					return false;
				}
			})();
		if (!stillAlive) throw new Error('editor lost after leaf teardown');

		return {
			editor: view.editor,
			view,
			isLivePreview,
			destroy: () => {
				if (realDestroy) {
					try {
						realDestroy();
					} catch {
						/* ignore */
					}
					realDestroy = null;
				}
				if (realUnload) {
					try {
						realUnload();
					} catch {
						/* ignore */
					}
				}
			},
		};
	} catch (err) {
		if (leaf) {
			try {
				leaf.detach();
			} catch {
				/* ignore */
			}
		}
		try {
			hidden?.teardown();
		} catch {
			/* ignore */
		}
		holder?.remove();
		await quietRemove(app, tempPath);
		throw err;
	}
}

/** Remove leftover temp editor files from vault root. */
export async function cleanupTempEditors(app: App): Promise<void> {
	try {
		const { files } = await app.vault.adapter.list('/');
		for (const f of files) {
			const a = /^memos-(temp-editor|inline-edit-)[^/]*\.md$/.test(f);
			const b = /^\.memos-(edit-[^/]*|temp-editor)\.md$/.test(f);
			if (a || b) await quietRemove(app, f);
		}
	} catch {
		/* ignore */
	}
}
