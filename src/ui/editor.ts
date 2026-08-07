import { App, Platform, setIcon, type Editor, type MarkdownView } from 'obsidian';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { cssProps } from '../css-props';
import {
	applyMobileEditability,
	claimMobileActiveEditor,
	graftNativeEditor,
	queueEditorTeardown,
	releaseMobileActiveEditor,
	seedDomCaret,
	type GraftedEditorHandle,
} from './editor-graft';
import { MentionController } from './mention';
import { TagSuggestController } from './tag-suggest';
import { refIdAtCursor } from '../parser';
import * as logger from '../logger';
import type { Memo } from '../types';

/** Per-editor temp-file sequence so several live editors (multiple Memos
 * views, or the composer + an inline card edit) never graft against the same
 * temp path. Grafts are serialised upstream, but unique paths also keep each
 * editor's destroy() from deleting another editor's in-flight temp file. */
let EDITOR_SEQ = 0;
const ATTACH_POLL_MS = 100;
const ATTACH_MAX_TRIES = 60;
const COMPOSER_PLACEHOLDER = '@引用卡片，@@创建新卡片';

export interface MemoEditorOptions {
	onSave: (content: string) => Promise<void>;
	onOpenSidebar?: () => void;
	/** Reveal the sidebar (or phone drawer) and focus its search box. */
	onSearch?: () => void;
	/** Candidate source for `@` mentions (full memo set). */
	getMemos?: () => Memo[];
	/** Unsent composer text persistence (survives view close/reopen).
	 * setDraft returns a Promise so destroy() can await the disk write
	 * before Obsidian exits — otherwise a clear-then-close loses the
	 * empty state and the old draft resurrects on next launch. */
	getDraft?: () => string;
	setDraft?: (text: string) => Promise<void>;
	/** Save an existing memo being edited in the composer (touch flow). */
	onEditSave?: (memo: Memo, content: string) => Promise<void>;
	/** `@@` in the composer: create a blank memo; its ref replaces the
	 * `@@name` token (see MentionController). */
	onCreateMemo?: (
		name: string,
	) => Promise<{ sourceFile: string; id: string } | null>;
	/** Shift+Enter with the caret on a memo ref: open that memo's editor. */
	onRefOpen?: (id: string) => void;
	/** Show Obsidian's native mobile quick-edit toolbar. When false the
	 * composer is never claimed as the active editor, so the toolbar (which
	 * lags ~2s on iPad) never appears. Called live on every claim so flipping
	 * the setting takes effect without a reload. Mobile only. */
	showMobileToolbar?: () => boolean;
	/** Jump the memo list back to the first card (the "back to top" button
	 * that appears when the user has scrolled the feed down). */
	onScrollToTop?: () => void;
}

export class MemoEditor {
	private container!: HTMLElement;
	private editorWrap!: HTMLElement;
	private sendBtn!: HTMLElement;
	private expandBtn: HTMLElement | null = null;
	private sidebarBtn: HTMLElement | null = null;
	private searchBtn: HTMLElement | null = null;
	/** Shown only while the memo list is scrolled away from the top. */
	private topBtn: HTMLElement | null = null;
	private feedEl: HTMLElement | null = null;
	private expanded = false;
	private saving = false;
	private handle: GraftedEditorHandle | null = null;
	private fallbackTa: HTMLTextAreaElement | null = null;
	/** True while a native CM6 graft is in flight. Auto-focus uses this to
	 * wait for the real editor instead of parking in the temporary textarea,
	 * which is removed when the graft lands (that drop is the "caret blinks
	 * once at the wrong corner, then vanishes" on first open). */
	private graftInProgress = false;
	/** Caret offset captured when the temporary textarea loses focus to the
	 * graft, so CM6 can restore the user's caret after the swap. */
	private fallbackCaretPos: number | null = null;
	/** focus() was called before the native editor finished grafting
	 * (view.onOpen runs first) — honour it once the editor exists. */
	private focusWhenReady: { caretToEnd: boolean } | null = null;
	private mention: MentionController | null = null;
	private tagSuggest: TagSuggestController | null = null;
	private destroyed = false;
	/** Memo loaded into the composer for editing (touch flow), or null when
	 * the composer is in its normal "new memo" mode. */
	private editingMemo: Memo | null = null;
	private attachTimer: number | null = null;
	private readyTimer: number | null = null;
	private draftTimer: number | null = null;
	/** Tracks the in-flight flushDraft() promise so destroy() can await it
	 * — prevents a 600ms-timer-fired flush from racing with teardown. */
	private pendingFlush: Promise<void> | null = null;
	/** Disconnects the keyboard-height watcher (see build()). */
	private kbWatcherCleanup: (() => void) | null = null;
	/** Unique temp file this editor grafts from (see EDITOR_SEQ). */
	private readonly tempPath: string;

	constructor(
		private app: App,
		private opts: MemoEditorOptions,
	) {
		this.tempPath = `memos-temp-editor-${Date.now().toString(36)}-${(
			EDITOR_SEQ++
		).toString(36)}.md`;
	}

	build(feedEl: HTMLElement): void {
		this.destroyed = false;
		this.saving = false;
		this.expanded = false;
		this.fallbackTa = null;
		this.handle = null;
		this.graftInProgress = false;
		this.fallbackCaretPos = null;
		this.focusWhenReady = null;
		this.mention = null;
		this.editingMemo = null;
		this.topBtn = null;
		this.feedEl = feedEl;
		this.container = feedEl.createDiv({ cls: 'memos-editor' });
		this.editorWrap = this.container.createDiv({ cls: 'memos-editor-native' });
		// 立即渲染兜底输入：CM6 graft 异步完成前，composer 永远不是空盒
		// （修后续加载"输入框没渲染、点击才出现"）。graft 完成后会被替换。
		this.renderFallbackInput('');

		const actionsRight = this.container
			.createDiv({ cls: 'memos-editor-actions' })
			.createDiv({ cls: 'memos-editor-actions-right' });

		this.searchBtn = actionsRight.createEl('button', {
			cls: 'memos-editor-search-btn',
			attr: { 'aria-label': 'Search memos', title: 'Search memos' },
		});
		setIcon(this.searchBtn, 'search');
		this.searchBtn.addEventListener('click', () => this.opts.onSearch?.());

		// "Back to top" button — hidden by default, shown when the user scrolls
		// the memo list away from the first card (see setScrollDown).
		this.topBtn = actionsRight.createEl('button', {
			cls: 'memos-editor-top-btn',
			attr: { 'aria-label': '跳转到顶部', title: '跳转到顶部' },
		});
		setIcon(this.topBtn, 'arrow-up');
		this.topBtn.addClass('is-hidden');
		this.topBtn.addEventListener('click', () => {
			this.opts.onScrollToTop?.();
		});

		this.sidebarBtn = actionsRight.createEl('button', {
			cls: 'memos-editor-sidebar-btn',
			attr: { 'aria-label': 'Open sidebar', title: 'Open sidebar' },
		});
		setIcon(this.sidebarBtn, 'panel-right-open');
		this.sidebarBtn.addEventListener('click', () => this.opts.onOpenSidebar?.());

		// 移动端屏幕小、展开无意义——彻底移除展开功能。
		if (!Platform.isMobile) {
			this.expandBtn = actionsRight.createEl('button', {
				cls: 'memos-editor-expand',
				attr: { 'aria-label': 'Expand editor', title: 'Expand editor' },
			});
			setIcon(this.expandBtn, 'maximize-2');
			this.expandBtn.addEventListener('click', () => this.toggleExpanded());
		}

		this.sendBtn = actionsRight.createEl('button', {
			cls: 'memos-editor-send',
			attr: {
				'aria-label': 'Send',
				title: 'Send (Cmd/Ctrl + Enter)',
			},
		});
		setIcon(this.sendBtn, 'send');
		this.sendBtn.addEventListener('click', () => void this.save());

		this.scheduleAttach();

		// Taps/clicks that land INSIDE .cm-content must not trigger a
		// programmatic focus(): on iOS, touchend fires before WebKit applies
		// the tap's caret position, and editor.focus() (plus the rAF retry
		// inside focus()) then races the native caret placement — the caret
		// snaps back and appears immovable. In-content taps are CM6's to
		// handle. Programmatic focus is only for the dead zone: the wrap's
		// padding around the editable surface.
		const focusIfOutsideContent = (e: Event) => {
			const t = e.target;
			if (t instanceof Element && t.closest('.cm-content')) return;
			this.focus();
		};
		this.editorWrap.addEventListener('click', focusIfOutsideContent);
		this.editorWrap.addEventListener('touchend', focusIfOutsideContent);
		if (Platform.isMobile) {
			// Obsidian mobile keeps re-stripping contenteditable/user-select
			// on editors it doesn't consider active (a grafted leaf never
			// is). CSS shields user-select permanently; the contenteditable
			// ATTRIBUTE has no CSS shield — re-assert it on every press,
			// before the browser decides whether the tap can edit. Cheap and
			// idempotent; a no-op until the graft has delivered .cm-content.
			this.editorWrap.addEventListener(
				'pointerdown',
				() => {
						applyMobileEditability(this.editorWrap);
					// Focus and claim the workspace "active editor" as early as the
					// tap lands, before the iOS keyboard animation and the delayed
					// focusin finish. The mobile toolbar's update() runs off the
					// claim and gates its show on editor.hasFocus() — focus first
					// (below), then claim. The later focusin re-claims with force.
					if (this.handle) {
						// iPad: focus synchronously in the pointerdown gesture FIRST.
						// The mobile toolbar's update(), fired by the claim below,
						// gates its show on editor.hasFocus(); claiming first meant
						// update() saw hasFocus()=false and the toolbar only appeared
						// when the delayed focusin landed (~2s after the keyboard).
						// No-op when already focused, so caret moves inside existing
						// text are unaffected.
						if (Platform.isTablet) {
							const doc = this.editorWrap.ownerDocument ?? document;
							const ac = doc.activeElement;
							if (!ac || !this.editorWrap.contains(ac)) {
								// editor.focus() routes to CM6's .cm-editor wrapper,
								// which the graft can leave unfocusable (a silent
								// no-op). Focus the contenteditable directly so the
								// DOM focus event — what flips hasFocus(), the
								// toolbar's show gate — lands inside the gesture.
								this.handle.editor.focus();
								if (!this.handle.editor.hasFocus()) {
									const content =
										this.editorWrap.querySelector<HTMLElement>(
											'.cm-content',
										);
									content?.focus();
								}
							}
						}
						this.claimToolbar(this.handle.view, false);
					}
				},
				true,
			);
		}
		this.editorWrap.addEventListener('input', () => {
			this.syncComposerPlaceholder();
			this.scheduleDraftSave();
		});
		// The graft removes the temporary textarea from under a focused user.
		// Capture the caret and hand focus to CM6 once it lands, instead of
		// leaving the composer caretless after the swap.
		this.editorWrap.addEventListener('focusout', (e) => {
			if (e.target !== this.fallbackTa || !this.graftInProgress) return;
			this.fallbackCaretPos =
				this.fallbackTa?.selectionStart ?? this.fallbackTa?.value.length ?? null;
			// A real user caret in the temporary textarea wins over any pending
			// auto-focus: keep their position instead of jumping to the end.
			this.focusWhenReady = { caretToEnd: false };
		});
		// CM6 handles many edits — deletions foremost — by preventing
		// beforeinput's default and applying its own transaction, so the
		// browser fires NO `input` event for them. Without this listener a
		// cleared composer never re-saves its draft, and reopening the
		// view resurrects text the user deleted. beforeinput still fires
		// for every user edit; by the time it bubbles here CM6 has applied
		// the change, so the debounced draft save sees the fresh value.
		this.editorWrap.addEventListener('beforeinput', () => {
			this.scheduleDraftSave();
		});
		this.editorWrap.addEventListener('compositionend', () => {
			// Via the coalescer: an IME commit fires `input` too, so a
			// synchronous getValue() here would serialize the whole doc a
			// second time on every commit.
			this.scheduleDraftSave();
		});

		if (Platform.isMobile) {
			// Keyboard collapse on iPad may not blur the contenteditable (focus
			// stays put), so the core toolbar lingers ~2s after the keyboard
			// goes down. Core writes --keyboard-height to <html> when the
			// keyboard toggles; once it drops to 0, release the active-editor
			// claim so the toolbar retracts immediately. MutationObserver (not
			// a visualViewport listener) — fires only when the var actually
			// changes, not on every animation frame. release is idempotent.
			const root = document.documentElement;
			let khTimer: number | null = null;
			const mo = new MutationObserver(() => {
				if (khTimer !== null) return;
				khTimer = window.setTimeout(() => {
					khTimer = null;
					if (!this.handle) return;
					const kh = parseFloat(
						window
							.getComputedStyle(root)
							.getPropertyValue('--keyboard-height'),
					);
					if (Number.isFinite(kh) && kh <= 0) {
						releaseMobileActiveEditor(this.app, this.handle.view);
					}
				}, 200);
			});
			mo.observe(root, { attributes: true, attributeFilter: ['style'] });
			this.kbWatcherCleanup?.();
			this.kbWatcherCleanup = () => mo.disconnect();
		}
	}

	/** Show/hide the "back to top" button. Called by the view when the list's
	 * scroll position changes. The topBtn element is created in build(). */
	setScrollDown(down: boolean): void {
		if (!this.topBtn) return;
		this.topBtn.toggleClass('is-hidden', !down);
	}

	toggleExpanded(): void {
		if (Platform.isMobile || !this.expandBtn) return;
		this.expanded = !this.expanded;
		this.container.toggleClass('memos-editor-is-expanded', this.expanded);
		this.feedEl?.toggleClass('memos-editor-expanded', this.expanded);
		setIcon(this.expandBtn, this.expanded ? 'minimize-2' : 'maximize-2');
		const label = this.expanded ? 'Collapse editor' : 'Expand editor';
		this.expandBtn.setAttribute('aria-label', label);
		this.expandBtn.setAttribute('title', label);
		window.setTimeout(() => {
			if (this.destroyed) return;
			this.handle?.editor.refresh();
			if (this.expanded) this.focus(true);
		}, 60);
	}

	/** Claim the composer as the workspace's active editor so the core mobile
	 * quick-edit toolbar can target it — but only if the user enabled the
	 * toolbar. When disabled (the default on the 2s-delay iPads), skip the
	 * claim and release any existing one so the delayed/overheating toolbar
	 * never appears. */
	private claimToolbar(view: MarkdownView, force: boolean): void {
		// 仅平板（存在约 2s 延迟的设备）尊重"移动端快速编辑栏"开关；手机端
		// 工具栏正常无延迟，保持原样。
		const want = !Platform.isTablet || !!this.opts.showMobileToolbar?.();
		if (!want) {
			// CSS 兜底：这个 body 类让 styles.css 的
			// body.memos-toolbar-off .mobile-toolbar 规则强制隐藏工具栏 + spacer，
			// 无论核心如何 show() 都不会出现（根治 iPad 白底/2s 延迟）。composer
			// 失焦时移除，普通笔记的工具栏不受影响。
			document.body.addClass('memos-toolbar-off');
			releaseMobileActiveEditor(this.app, view);
		} else {
			document.body.removeClass('memos-toolbar-off');
			claimMobileActiveEditor(this.app, view, force);
		}
	}

	private scheduleAttach(): void {
		let tries = 0;
		const tick = () => {
			if (this.destroyed) return;
			if (this.container?.isConnected) {
				this.attachTimer = null;
				void this.initNativeEditor();
				return;
			}
			if (++tries >= ATTACH_MAX_TRIES) {
				this.attachTimer = null;
				logger.warn('container never attached — using fallback textarea');
				this.useFallback('container never attached');
				return;
			}
			this.attachTimer = window.setTimeout(tick, ATTACH_POLL_MS);
		};
		tick();
	}

	private async initNativeEditor(): Promise<void> {
		this.graftInProgress = true;
		try {
			this.handle = await graftNativeEditor(
				this.app,
				this.editorWrap,
				'',
				this.tempPath,
				6000,
				true,
			);
			if (this.destroyed) {
				this.handle.destroy();
				this.handle = null;
				this.graftInProgress = false;
				return;
			}
			// build() 预渲染的兜底 textarea 一直在，直到 CM6 graft 成功才移除——
			// 期间 composer 永远有输入界面（修后续加载"输入框没渲染、点击才出现"）。
			// 用户可能在等待期间输入了内容，先存进 draft 让 CM6 恢复。graft 已
			// 摘掉 textarea，此处只补 fallbackTa 引用（值仍在 detached 元素上）。
			if (this.fallbackTa) {
				if (this.fallbackTa.value && !this.editingMemo) {
					void this.opts.setDraft?.(this.fallbackTa.value);
				}
				this.fallbackTa.remove();
				this.fallbackTa = null;
			}

			// 强化 CM6 可见化：graft 内部的 refresh/requestMeasure 跑在 textarea
			// 移除前；移除后重新断言可编辑性并 refresh + requestMeasure，确保后续
			// 加载时 CM6 立即布局可见（不点输入框才渲染）。
			// graft 内部已在编辑器就绪时设过占位符，但 setValue('') 会触发
			// Obsidian 重置为默认值——setValue + refresh 之后会重新设置。
			applyMobileEditability(this.editorWrap);
			this.handle.editor.refresh();
			const cmRef = this.handle.editor as Editor & {
				cm?: { requestMeasure?: () => void };
			};
			window.requestAnimationFrame(() => {
				if (this.destroyed || !this.handle) return;
				this.handle.editor.refresh();
				cmRef.cm?.requestMeasure?.();
			});
			// Restore unsent draft (empty string when none) instead of blanking —
			// or the memo being edited when Edit was tapped before we were ready.
			this.handle.editor.setValue(
				this.editingMemo
					? this.editingMemo.content
					: this.resolveDraft(),
			);
			// If the user was typing in the temporary textarea when the
			// graft swapped it out, restore their caret in CM6 too.
			if (this.fallbackCaretPos !== null && !this.editingMemo) {
				const pos = Math.min(
					this.fallbackCaretPos,
					this.handle.editor.getValue().length,
				);
				try {
					(
						this.handle.editor as Editor & {
							cm?: { dispatch: (s: unknown) => void };
						}
					).cm?.dispatch({ selection: { anchor: pos } });
				} catch {
					/* caret restore is best-effort */
				}
			}
			this.fallbackCaretPos = null;
			if (this.editingMemo) {
				// Caret at the end of the memo being edited. NB: collapsed
				// setSelection — Editor.setCursor only exists on ≥1.13 runtimes.
				const e = this.handle.editor;
				const last = e.lineCount() - 1;
				e.setSelection({ line: last, ch: e.getLine(last).length });
				this.markEditing();
			}
			this.ensureComposerPlaceholder();
			this.syncComposerPlaceholder();
			this.handle.editor.refresh();

			const sc = this.editorWrap.querySelector('.cm-scroller');
			this.editorWrap.scrollTop = 0;
			if (sc) sc.scrollTop = 0;

			if (this.handle.isLivePreview) {
				this.editorWrap.addClass('memos-editor-live-preview');
			}

			// CM6 updateListener: fires on every transaction — including
			// deletions that produce NO DOM input/beforeinput event (the
			// root cause of the "deleted text resurrects on reload" bug).
			// This is the authoritative change-detection for CM6; the DOM
			// listeners on editorWrap remain as fallbacks for the textarea.
			try {
				const cm = (this.handle.editor as Editor & {
					cm?: EditorView;
				}).cm;
				if (cm) {
					cm.dispatch({
						effects: StateEffect.appendConfig.of(
							EditorView.updateListener.of(
								(update: ViewUpdate) => {
									if (update.docChanged) {
										this.syncComposerPlaceholder();
										if (
											!this.destroyed &&
											!this.editingMemo
										) {
											this.scheduleDraftSave();
										}
									}
								},
							),
						),
					});
				}
			} catch {
				/* CM6 internal API mismatch — DOM listeners still cover us */
			}

			this.readyTimer = window.setTimeout(() => {
				this.readyTimer = null;
				if (this.destroyed) return;
				this.handle?.editor.refresh();
				const s = this.editorWrap.querySelector(
					'.cm-scroller',
				);
				this.editorWrap.scrollTop = 0;
				if (s) s.scrollTop = 0;
			}, 120);

			const content = this.editorWrap.querySelector('.cm-content');
			if (content) {
				const mdView = this.handle.view;
				content.addEventListener('focusin', () => {
					this.editorWrap.addClass('memos-editor-focused');
					// Mobile: register this editor as the workspace "active editor"
					// so Obsidian's native quick-edit toolbar shows and its buttons
					// target us (see claimMobileActiveEditor). We deliberately keep
					// the claim after blur — like a normal note, whose active editor
					// stays addressable while its leaf is active — and release only
					// on destroy. Workspace clears it on every leaf switch for us.
					// Force the toolbar refresh on the TRUE focus-landed signal:
					// the pointerdown claim ran before iOS applied focus, so its
					// update() saw hasFocus()=false; without the force, the
					// idempotent skip here would leave the toolbar hidden until
					// some later event (~2s on iPad).
					this.claimToolbar(mdView, true);
				});
				content.addEventListener('focusout', () => {
					this.editorWrap.removeClass('memos-editor-focused');
					// Composer no longer focused — release the CSS toolbar
					// suppression so normal notes' toolbar still works.
					document.body.removeClass('memos-toolbar-off');
					// Release the active-editor claim only once the keyboard is
					// truly gone — a real focus move. During IME / toolbar-tap
					// interactions the keyboard stays up and transient blurs must
					// not kill the toolbar (its buttons target the claimed
					// editor). Gating on core's --keyboard-height lets the
					// toolbar retract promptly when the keyboard collapses after
					// a tap-away, instead of lingering ~2s.
					const kh = parseFloat(
						window
							.getComputedStyle(document.documentElement)
							.getPropertyValue('--keyboard-height'),
					);
					if (!Number.isFinite(kh) || kh <= 0) {
						releaseMobileActiveEditor(this.app, mdView);
					}
				});
				if (Platform.isMobile) {
					window.requestAnimationFrame(() => {
						this.editorWrap
							.querySelectorAll('.cm-scroller, .cm-content')
							.forEach((el) => {
								cssProps(el, {
									paddingLeft: '0',
									paddingRight: '0',
								});
							});
					});
				}
			}

			const cmEditor = this.editorWrap.querySelector('.cm-editor');
			cmEditor?.addEventListener(
				'keydown',
				(ev) => {
					const e = ev as KeyboardEvent;
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
						e.preventDefault();
						e.stopPropagation();
						void this.save();
					} else if (
						e.key === 'Enter' &&
						e.shiftKey &&
						!e.isComposing &&
						this.opts.onRefOpen &&
						this.handle
					) {
						// Shift+Enter with the caret inside/beside a memo ref:
						// jump straight into that memo's editor.
						const id = refIdAtCursor(this.handle.editor);
						if (id) {
							e.preventDefault();
							e.stopPropagation();
							this.opts.onRefOpen(id);
						}
					}
				},
				true,
			);

			// `@`-mention autocomplete, anchored on the native-editor wrap (the
			// outer `.memos-editor` has overflow:hidden and would clip the popup;
			// the popup itself is position:fixed on document.body anyway).
			this.mention = new MentionController(
				{
					getMemos: () => this.opts.getMemos?.() ?? [],
					getEditor: () => this.handle?.editor ?? null,
					onCreateMemo: this.opts.onCreateMemo,
				},
				this.editorWrap,
			);

			this.tagSuggest = new TagSuggestController(
				{
					getTagCounts: () => {
						const memos = this.opts.getMemos?.() ?? [];
						const counts = new Map<string, number>();
						for (const m of memos) {
							for (const t of m.tags) {
								counts.set(t, (counts.get(t) || 0) + 1);
							}
						}
						return counts;
					},
					getEditor: () => this.handle?.editor ?? null,
				},
				this.editorWrap,
			);

			this.graftInProgress = false;
			this.applyPendingFocus();
		} catch (e) {
			this.graftInProgress = false;
			logger.error('Failed to init native editor:', e);
			this.handle = null;
			this.useFallback(
				'exception: ' + (e instanceof Error ? e.message : String(e)),
			);
		}
	}

	/**
	 * Create the fallback <textarea> input surface. Called IMMEDIATELY on build
	 * so the composer is never an empty box while the CM6 graft is in flight
	 * (fixes "input doesn't render until you click" on later view loads), and
	 * again on graft failure. Any text typed here is preserved via the draft
	 * before the graft swaps it out (see initNativeEditor).
	 */
	private renderFallbackInput(reason: string): void {
		if (this.fallbackTa || this.destroyed) return;
		if (reason) logger.warn('native editor fallback —', reason);
		this.editorWrap.empty();
		this.editorWrap.createDiv({
			cls: 'memos-editor-placeholder',
			text: COMPOSER_PLACEHOLDER,
		});
		this.fallbackTa = this.editorWrap.createEl('textarea', {
			cls: 'memos-editor-textarea',
			attr: {
				'aria-label': reason
					? `native editor failed: ${reason}`
					: 'new memo',
				'data-fallback-reason': reason ?? '',
				placeholder: COMPOSER_PLACEHOLDER,
			},
		});
		this.fallbackTa.value = this.editingMemo
			? this.editingMemo.content
			: this.resolveDraft();
		if (this.editingMemo) {
			const len = this.fallbackTa.value.length;
			this.fallbackTa.setSelectionRange(len, len);
			this.markEditing();
		}
		this.syncComposerPlaceholder();
		this.fallbackTa.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				void this.save();
			}
		});

		this.applyPendingFocus();
	}

	private useFallback(reason: string): void {
		this.renderFallbackInput(reason);
	}

	/** A persisted draft made only of whitespace must not hide the
	 * placeholder: opening the view would show an apparently empty box while
	 * CM6 still holds one invisible space, and the placeholder stays hidden. */
	private resolveDraft(): string {
		const raw = this.opts.getDraft?.() ?? '';
		return raw.trim() === '' ? '' : raw;
	}

	/** Keep the placeholder overlay in the DOM and at the end of the wrapper
	 * (after the grafted CM6 source view), so it can never be covered by the
	 * editor's own layers. */
	private ensureComposerPlaceholder(): void {
		if (this.destroyed) return;
		let ph = this.editorWrap.querySelector<HTMLElement>(
			'.memos-editor-placeholder',
		);
		if (!ph) {
			ph = this.editorWrap.createDiv({
				cls: 'memos-editor-placeholder',
				text: COMPOSER_PLACEHOLDER,
			});
		} else if (ph.textContent !== COMPOSER_PLACEHOLDER) {
			ph.textContent = COMPOSER_PLACEHOLDER;
		}
		this.editorWrap.appendChild(ph);
	}

	/** Focus the composer. With `caretToEnd`, also park the caret at the
	 * end of any restored draft — used by the programmatic auto-focus
	 * paths (view open, plugin commands). The click/tap handlers pass
	 * nothing: there the user's own click position must win. */
	focus(caretToEnd = false): void {
		if (!this.handle && !this.fallbackTa) {
			// The native editor is still grafting — there is nothing focusable
			// yet. Remember the request; applyPendingFocus() runs once the
			// editor (or the fallback textarea) lands.
			this.focusWhenReady = { caretToEnd };
			return;
		}
		const doc = this.container.ownerDocument ?? document;
		// 自动聚焦不因 Obsidian 把 activeElement 暂放回 workspace/body 而放弃：
		// 那正是 graft 收尾时的正常状态，跳过会导致"光标闪烁一下后消失"。
		// 只有用户已经落到另一个可编辑区域（输入框、textarea、contenteditable）
		// 时才让路，避免抢走用户正在输入的焦点。
		const focusIsElsewhereEditable = () => {
			const active = doc.activeElement;
			if (
				active &&
				active !== doc.body &&
				!this.container.contains(active)
			) {
				if (
					active.instanceOf(HTMLInputElement) ||
					active.instanceOf(HTMLTextAreaElement)
				) {
					return true;
				}
				if (
					active.instanceOf(HTMLElement) &&
					active.isContentEditable
				) {
					return true;
				}
			}
			return false;
		};
		const doFocus = () => {
			if (this.destroyed) return;
			if (this.handle) {
				try {
					const cm = (
						this.handle.editor as {
							cm?: {
								state?: { doc?: { length: number } };
								dispatch: (s: unknown) => void;
							};
						}
					).cm;
					const cmDoc = cm?.state?.doc;
					if (cm && cmDoc) {
						// 空文档（含 Obsidian 可能保留的一个空行）时始终把光标
						// 放回 0，避免聚焦落在第二个空行上、看起来偏下/偏右。
						const empty = this.handle.editor
							.getValue()
							.trim().length === 0;
						if (empty) {
							seedDomCaret(
								this.handle.editor,
								0,
								this.container.ownerDocument ?? document,
							);
						} else if (caretToEnd) {
							seedDomCaret(
								this.handle.editor,
								cmDoc.length,
								this.container.ownerDocument ?? document,
							);
						}
					}
				} catch {
					/* ignore */
				}
				this.handle.editor.focus();
				try {
					const cm = (
						this.handle.editor as {
							cm?: {
								state?: { doc?: { length: number } };
								dispatch: (s: unknown) => void;
							};
						}
					).cm;
					const cmDoc = cm?.state?.doc;
					if (cm && cmDoc) {
						const empty = this.handle.editor
							.getValue()
							.trim().length === 0;
						if (empty) {
							cm.dispatch({ selection: { anchor: 0 } });
							const s = this.editorWrap.querySelector(
								'.cm-scroller',
							);
							this.editorWrap.scrollTop = 0;
							if (s) s.scrollTop = 0;
						} else if (caretToEnd) {
							cm.dispatch({ selection: { anchor: cmDoc.length } });
						}
					}
				} catch {
					/* ignore */
				}
			} else if (this.fallbackTa) {
				if (
					caretToEnd &&
					(this.attachTimer !== null || this.graftInProgress)
				) {
					// Auto-focus must not park in the temporary textarea: the
					// graft removes it moments later, dropping the caret. Wait
					// for the real CM6 editor instead.
					this.focusWhenReady = { caretToEnd };
					return;
				}
				this.fallbackTa.focus();
				if (caretToEnd) {
					const len = this.fallbackTa.value.length;
					this.fallbackTa.setSelectionRange(len, len);
				}
			}
		};
		if (this.handle && caretToEnd) {
			// Auto-focus can land on the very frame the grafted editor first
			// lays out, while its geometry is still stale: the caret parks in
			// the wrong corner and disappears on the follow-up refresh. Wait
			// until the editor's own 120ms settle timer has refreshed it, then
			// re-measure on the visible composer, and only then focus with the
			// DOM caret already seeded. The extra rAF lets CM6 paint the caret
			// at its final coordinates instead of a stale offscreen position.
			window.setTimeout(() => {
				if (this.destroyed || focusIsElsewhereEditable()) return;
				const cm = (
					this.handle?.editor as Editor & {
						cm?: { requestMeasure?: () => void };
					}
				)?.cm;
				// Force layout now, then let CM6 measure against the composer's
				// real (visible) box before the caret is placed.
				void this.editorWrap.getBoundingClientRect();
				cm?.requestMeasure?.();
				this.handle?.editor.refresh();
				window.requestAnimationFrame(() => {
					if (this.destroyed || focusIsElsewhereEditable()) return;
					doFocus();
					// One final measure after the browser has painted the caret,
					// so an in-flight CM6 reflow cannot move it afterwards.
					window.requestAnimationFrame(() => {
						if (this.destroyed || focusIsElsewhereEditable()) return;
						const c = (
							this.handle?.editor as Editor & {
								cm?: { requestMeasure?: () => void };
							}
						)?.cm;
						c?.requestMeasure?.();
					});
				});
				// Obsidian can hand focus back to the workspace on the first
				// layout pass after a grafted leaf detaches. If that happened,
				// the caret blinks once and disappears; retry the auto-focus a
				// few times once the view has fully settled. The editable-
				// elsewhere check keeps this from fighting a deliberate move.
				let retries = 3;
				const guardedRetry = () => {
					if (this.destroyed || focusIsElsewhereEditable()) return;
					const hasFocus = (
						this.handle?.editor as { hasFocus?: () => boolean }
					).hasFocus?.();
					if (hasFocus === false) {
						doFocus();
						if (--retries > 0) {
							window.setTimeout(guardedRetry, 250);
						}
					}
				};
				window.setTimeout(guardedRetry, 450);
			}, 200);
			return;
		}
		doFocus();
		window.requestAnimationFrame(doFocus);
	}

	/** Honour a focus() that arrived before the editor existed (the view
	 * opens before the graft finishes). Skip if the user has since focused
	 * something outside this composer, so a slow graft doesn't steal focus
	 * back from wherever they went. */
	private applyPendingFocus(): void {
		const pending = this.focusWhenReady;
		if (!pending || this.destroyed) return;
		this.focusWhenReady = null;
		// Popout windows have their own document — the global `document` is
		// the main window's, whose activeElement is never inside this view.
		const doc = this.container.ownerDocument ?? document;
		const active = doc.activeElement;
		// 同样只给"已在其他可编辑区域输入"的用户让路；workspace/body 的
		// 临时焦点不阻断打开视图后的自动聚焦。
		if (active && active !== doc.body && !this.container.contains(active)) {
			const elsewhereEditable =
				active.instanceOf(HTMLInputElement) ||
				active.instanceOf(HTMLTextAreaElement) ||
				(active.instanceOf(HTMLElement) && active.isContentEditable);
			if (elsewhereEditable) return;
		}
		this.focus(pending.caretToEnd);
	}

	/** DIAGNOSTIC (temporary): log the composer's rendered height + contents at
	 * a lifecycle stage so the first-open height jump can be traced on-device.
	 * Remove once Bug A is confirmed fixed. */
	getValue(): string {
		if (this.handle) return this.handle.editor.getValue().trim();
		if (this.fallbackTa) return this.fallbackTa.value.trim();
		return '';
	}

	/** Re-measure the grafted CM6 editor after the container resizes
	/** Re-measure the grafted CM6 editor after the container resizes
	 * (Obsidian phone-drawer slide-in, keyboard viewport shrink). CM6's own
	 * ResizeObserver eventually catches up, but a refresh here kills the ~1s
	 * shrunk-then-recovers first frame. requestMeasure is coalesced. */
	refresh(): void {
		this.handle?.editor.refresh();
	}

	/**
	 * Rebuild the grafted editor from scratch. A grafted CM6 editor's rendering
	 * is permanently lost once its container is hidden and re-shown (the "blank
	 * until clicked" bug — every view gets one normal chance), while a FRESH
	 * graft always renders. So the view rebuilds on every re-show. The fallback
	 * textarea covers the ~1s re-graft window (already height-matched, restores
	 * the draft), so the composer is never blank. No-op until the first graft
	 * has landed.
	 */
	async rebuild(): Promise<void> {
		if (this.destroyed || !this.handle) return;
		if (this.pendingFlush) {
			await this.pendingFlush;
		}
		await this.flushDraft();
		if (this.mention) {
			this.mention.destroy();
			this.mention = null;
		}
		if (this.tagSuggest) {
			this.tagSuggest.destroy();
			this.tagSuggest = null;
		}
		if (this.handle) {
			this.handle.destroy();
			this.handle = null;
		}
		this.editorWrap.empty();
		// handle is null until the fresh graft lands, so a re-show during the
		// re-graft early-returns instead of stacking another rebuild.
		this.fallbackTa = null;
		this.renderFallbackInput('rebuild-on-show');
		void this.initNativeEditor();
	}

	clearValue(): void {
		if (this.handle) this.handle.editor.setValue('');
		if (this.fallbackTa) this.fallbackTa.value = '';
		this.syncComposerPlaceholder();
	}

	async save(): Promise<void> {
		if (this.saving || this.destroyed) return;
		const value = this.getValue();
		const editing = this.editingMemo;
		if (editing) {
			// Touch edit flow: the send button saves the existing memo.
			if (!value || !this.opts.onEditSave) return;
			if (value === editing.content) {
				this.exitEdit();
				return;
			}
			this.saving = true;
			try {
				await this.opts.onEditSave(editing, value);
				this.exitEdit();
			} finally {
				this.saving = false;
			}
			return;
		}
		if (!value) return;
		this.saving = true;
		try {
			await this.opts.onSave(value);
			this.clearValue();
			void this.opts.setDraft?.('');
		} finally {
			this.saving = false;
		}
	}

	/** Load an existing memo into the composer for editing. Used on touch
	 * devices, where the in-card editor is unusable once the virtual keyboard
	 * opens — the composer sits above the feed and stays reachable. Unsaved
	 * input from a previous edit is discarded (deliberate: no edit drafts). */
	startEdit(memo: Memo): void {
		if (this.destroyed) return;
		this.editingMemo = memo;
		if (this.handle || this.fallbackTa) {
			if (this.handle) {
				this.handle.editor.setValue(memo.content);
			} else if (this.fallbackTa) {
				this.fallbackTa.value = memo.content;
			}
			this.syncComposerPlaceholder();
			this.markEditing();
		}
		// Bring the composer into view before focusing: the tapped card can sit
		// far down the feed, and the soft keyboard must open onto the composer
		// (above the feed), not the card. focus() alone can land off-screen.
		this.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
		this.placeDomCaretAtEnd();
		this.focus();
		this.moveCaretToEnd();
	}

	/** Seed the DOM selection at the END of the content BEFORE focusing, so
	 * every platform opens the edit with the caret after the last character:
	 * iOS honours an existing selection when focus() runs, and desktop CM6
	 * syncs the DOM caret from this instead of wherever the click that
	 * opened Edit left it. moveCaretToEnd re-asserts after focus. */
	private placeDomCaretAtEnd(): void {
		if (this.handle) {
			seedDomCaret(
				this.handle.editor,
				this.handle.editor.getValue().length,
				this.container.ownerDocument ?? document,
			);
		} else if (this.fallbackTa) {
			const len = this.fallbackTa.value.length;
			this.fallbackTa.setSelectionRange(len, len);
		}
	}

	/** Re-assert the caret at the end AFTER focusing (belt and braces after
	 * placeDomCaretAtEnd): a selection-only dispatch on a focused editor
	 * moves the caret on desktop, and covers the fallback textarea path.
	 * focus() runs its own rAF pass, so queue behind it (rAF callbacks fire
	 * in registration order). Uses setSelection — Editor.setCursor only
	 * exists on Obsidian ≥1.13 runtimes. */
	private moveCaretToEnd(): void {
		const apply = () => {
			if (this.destroyed || !this.editingMemo) return;
			try {
				if (this.handle) {
					const e = this.handle.editor;
					const last = e.lineCount() - 1;
					e.setSelection({ line: last, ch: e.getLine(last).length });
				} else if (this.fallbackTa) {
					const len = this.fallbackTa.value.length;
					this.fallbackTa.setSelectionRange(len, len);
				}
			} catch {
				/* never let caret placement break the edit flow */
			}
		};
		apply();
		window.requestAnimationFrame(apply);
	}

	private markEditing(): void {
		this.sendBtn.setAttribute('aria-label', 'Save changes');
		this.sendBtn.setAttribute('title', 'Save (Cmd/Ctrl + Enter)');
	}

	/** Leave edit mode and restore the persisted composer draft. */
	exitEdit(): void {
		if (!this.editingMemo) return;
		this.editingMemo = null;
		this.sendBtn.setAttribute('aria-label', 'Send');
		this.sendBtn.setAttribute('title', 'Send (Cmd/Ctrl + Enter)');
		const draft = this.resolveDraft();
		if (this.handle) this.handle.editor.setValue(draft);
		else if (this.fallbackTa) this.fallbackTa.value = draft;
		this.syncComposerPlaceholder();
	}

	/** Show the composer placeholder only for an empty new-memo composer.
	 * The layer is a fixed overlay, so it never drifts or flickers while the
	 * grafted editor settles. */
	private syncComposerPlaceholder(): void {
		if (this.destroyed) return;
		const text = this.handle
			? this.handle.editor.getValue()
			: (this.fallbackTa?.value ?? '');
		this.editorWrap.toggleClass(
			'memos-editor-empty',
			text.trim().length === 0 && !this.editingMemo,
		);
	}

	/** Debounced persist of the raw composer text (200ms after typing stops).
	 * Reduced from 600ms to 200ms to shrink the race window: a shorter
	 * debounce means the disk write starts sooner, so destroy()/onunload()
	 * have less work to wait for when the user clears text and exits. */
	private scheduleDraftSave(): void {
		// Never let memo-edit content leak into the composer draft.
		if (!this.opts.setDraft || this.destroyed || this.editingMemo) return;
		if (this.draftTimer !== null) window.clearTimeout(this.draftTimer);
		this.draftTimer = window.setTimeout(() => {
			this.draftTimer = null;
			// Track the promise so destroy() can await it — prevents a
			// timer-fired flush from racing with teardown.
			this.pendingFlush = this.flushDraft().finally(() => {
				if (this.pendingFlush === null) return;
				this.pendingFlush = null;
			});
		}, 200);
	}

	private async flushDraft(): Promise<void> {
		if (!this.opts.setDraft || this.destroyed || this.editingMemo) return;
		if (!this.handle && !this.fallbackTa) return;
		const v = this.handle
			? this.handle.editor.getValue()
			: (this.fallbackTa?.value ?? '');
		const clean = v.trim() === '' ? '' : v;
		// Skip the settings write when nothing changed — destroy() flushes
		// unconditionally, and most closes don't touch the draft.
		if (this.opts.getDraft && this.opts.getDraft() === clean) return;
		await this.opts.setDraft(clean);
	}

	async destroy(): Promise<void> {
		// Persist the latest text before tearing the editor down — always,
		// not just when a save is pending: a CM6 deletion fires no input
		// event, so without an unconditional flush the old draft survives
		// a clear-then-close. MUST await the setDraft promise so the
		// async saveData() disk write completes before Obsidian exits.
		if (this.draftTimer !== null) {
			window.clearTimeout(this.draftTimer);
			this.draftTimer = null;
		}
		// If a timer-fired flush is in flight (pendingFlush), await it
		// FIRST — it may already be writing the correct value to disk.
		// Then run a final flushDraft to catch any changes that landed
		// between the timer fire and this destroy() call.
		if (this.pendingFlush) {
			await this.pendingFlush;
		}
		await this.flushDraft();
		this.destroyed = true;
		this.kbWatcherCleanup?.();
		this.kbWatcherCleanup = null;
		if (this.attachTimer !== null) {
			window.clearTimeout(this.attachTimer);
			this.attachTimer = null;
		}
		if (this.readyTimer !== null) {
			window.clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
		this.container?.remove();
		if (this.mention) {
			this.mention.destroy();
			this.mention = null;
		}
		if (this.tagSuggest) {
			this.tagSuggest.destroy();
			this.tagSuggest = null;
		}
		// Chain the CM6 teardown + temp-file removal onto the teardown gate so a
		// replacement editor (e.g. a Memos re-created in the sidebar while this
		// main-pane one is mid-detach) does NOT graft until this editor is fully
		// gone — two grafted CM6 editors coexisting mid-teardown is what leaves
		// the new composer blank until clicked. The container was removed above,
		// so this delay only affects the orphaned CM6 instance, not the UI.
		queueEditorTeardown(async () => {
			if (this.handle) {
				releaseMobileActiveEditor(this.app, this.handle.view);
				this.handle.destroy();
				this.handle = null;
			}
			// Only remove OUR temp file — a broad sweep here could delete a temp
			// file another live editor is still grafting from.
			await this.app.vault.adapter.remove(this.tempPath).catch(() => {});
		});
		this.fallbackTa = null;
	}
}
