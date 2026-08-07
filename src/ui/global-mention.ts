import type { Editor } from 'obsidian';
import type { Memo } from '../types';
import { MentionController } from './mention';

export interface GlobalMentionOptions {
	/** Live settings toggle — checked on every trigger, so flipping it in
	 * the settings tab takes effect immediately (no reload needed). */
	enabled: () => boolean;
	/** Candidate source (the full memo set; archived are excluded here). */
	getMemos: () => Memo[];
	/** `@@` token → create a brand-new BLANK memo; the returned ref
	 * replaces the `@@name` token with `[[<file>#<id>|<name>]]`. */
	onCreateMemo: (
		name: string,
	) => Promise<{ sourceFile: string; id: string } | null>;
}

/** Containers hosting the plugin's OWN editors (composer + inline card
 * editors). Those already carry their own MentionController; the global
 * manager must ignore input from them. */
const OWN_EDITOR_SELECTOR = '.memos-view, .memos-card';

/**
 * `@`-mention / `@@` quick-create for EVERY other editor in Obsidian:
 * regular notes (source mode & live preview) and canvas text nodes.
 *
 * Design: the workspace `editor-change` event hands us the live Obsidian
 * `Editor` of whatever is being typed in — the SAME public API the
 * composer's MentionController drives (no CM6-internal back-references;
 * the `cmView` DOM property turned out to be absent at runtime). A
 * document-level `input` listener only acts as an origin guard: input that
 * did NOT come from a CM6 editor — or came from the plugin's own editors —
 * clears the tracked editor so the popup can't attach to the wrong place.
 * All token/popup/keyboard logic is reused from MentionController.
 */
export class GlobalMentionManager {
	/** The editor most recently reported by `editor-change`, or null when
	 * the last input came from somewhere else (own editors, search boxes). */
	private current: Editor | null = null;
	private mention: MentionController;

	constructor(private opts: GlobalMentionOptions) {
		// The shared controller reads `current` lazily — null (own editor /
		// non-editor input / toggle off) makes it dismiss immediately.
		this.mention = new MentionController(
			{
				getMemos: opts.getMemos,
				getEditor: () => (this.opts.enabled() ? this.current : null),
				onCreateMemo: opts.onCreateMemo,
			},
			document.body,
		);
		document.addEventListener('input', this.onInput, true);
		document.addEventListener('compositionend', this.onInput, true);
	}

	destroy(): void {
		document.removeEventListener('input', this.onInput, true);
		document.removeEventListener('compositionend', this.onInput, true);
		this.mention.destroy();
	}

	/** Wired by main.ts to `workspace.on('editor-change')` — fires for every
	 * content change in a note editor (source & live preview) and canvas
	 * text nodes. Arrives BEFORE the native `input` event for the same
	 * change, so `current` is fresh in time. */
	handleEditorChange(editor: Editor): void {
		this.current = editor;
	}

	/** Origin guard: keep `current` only while input comes from a CM6 editor
	 * that isn't one of our own. */
	private onInput = (e: Event): void => {
		// Toggle off → nothing to track: skip the two closest() walks up to
		// document that would otherwise run on EVERY keystroke app-wide.
		if (!this.opts.enabled()) {
			this.current = null;
			return;
		}
		const t = e.target as HTMLElement | null;
		const inCm = !!t && typeof t.closest === 'function' && !!t.closest('.cm-content');
		const own =
			!!t &&
			typeof t.closest === 'function' &&
			!!t.closest(OWN_EDITOR_SELECTOR);
		if (!inCm || own) this.current = null;
	};
}
