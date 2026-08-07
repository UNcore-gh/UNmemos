import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	Platform,
	setIcon,
	TextComponent,
} from 'obsidian';
import { attachSortable, type SortableHandle } from './sortable';

export interface TagSidebarCallbacks {
	onTagClick: (tag: string | null) => void;
	onPinTag: (tag: string) => void;
	onRenameTag: (from: string, to: string) => void;
	onDeleteTag: (tag: string) => void;
	/** Pinned tags reordered by drag: the new order of VISIBLE pinned
	 * tags (count-0 pinned tags are hidden, so this is a subset of the
	 * settings array — the consumer remaps by name, not by index). */
	onReorderPinned: (orderedTags: string[]) => void;
}

interface TagNode {
	name: string;
	displayName: string;
	count: number;
	children: TagNode[];
}

export class TagSidebar {
	private container!: HTMLElement;
	private expandedTags = new Set<string>();
	private sortable: SortableHandle | null = null;
	/** The ⋯ button whose tag menu is currently open — a second tap on the
	 * same button toggles the menu closed instead of reopening it. */
	private tagMenuMore: HTMLElement | null = null;
	private tagMenuEl: HTMLElement | null = null;
	private closeTagMenu: (() => void) | null = null;
	private lastRender: {
		tagCounts: Map<string, number>;
		activeTag: string | null;
		totalMemos: number;
		pinnedTags: string[];
	} | null = null;
	/** Bumped on every expand/collapse so the render-skip signature notices
	 * internal state changes the outside args don't reflect. */
	private expandRev = 0;
	private lastSig = '';
	private lastCounts: Map<string, number> | null = null;

	constructor(
		private app: App,
		private callbacks: TagSidebarCallbacks,
	) {}

	build(parent: HTMLElement): void {
		this.container = parent.createDiv({ cls: 'memos-lite-sidebar-section' });
		// Delegated on the long-lived section container: render() empties
		// the children on every store update, so row-level listeners would
		// die. Only pinned rows are draggable — the `>` child combinator
		// keeps an expanded pinned parent's nested child rows out of the
		// drag set (and out of the reorder reading below).
		this.sortable?.destroy();
		this.sortable = attachSortable(this.container, {
			itemSelector: '.memos-lite-pinned > .memos-lite-tag-item',
			ignoreSelector: '.memos-lite-tag-more',
			scrollContainer: this.container.closest<HTMLElement>('.memos-sidebar'),
			onReorder: () => {
				const ordered = Array.from(
					this.container.querySelectorAll<HTMLElement>(
						'.memos-lite-pinned > .memos-lite-tag-item',
					),
				)
					.map((el) => el.dataset.tag ?? '')
					.filter((t) => t.length > 0);
				this.callbacks.onReorderPinned(ordered);
			},
			// Hold still and release: open the tag's edit menu anchored to
			// the row (hold-then-move instead reorders — see sortable.ts).
			// Desktop only: mobile rows use the ⋯ button instead.
			onLongPress: (row) => {
				if (Platform.isMobile) return;
				const tag = row.dataset.tag;
				if (!tag) return;
				const r = row.getBoundingClientRect();
				this.showTagMenuAt(r.left + 28, r.bottom + 4, tag, true);
			},
		});
	}

	destroy(): void {
		this.sortable?.destroy();
		this.sortable = null;
	}

	render(
		tagCounts: Map<string, number>,
		activeTag: string | null,
		totalMemos = 0,
		pinnedTags: string[] = [],
	): void {
		// Render-skip: the view calls this on every store notification
		// (keystrokes, date clicks, …), but with the ViewStore's memoized
		// counts the map ref only changes when memo data or the base frame
		// actually changes — so navigation-only updates rebuild nothing.
		const sig = `${this.expandRev}|${activeTag ?? ''}|${totalMemos}|${pinnedTags.join(',')}`;
		if (sig === this.lastSig && tagCounts === this.lastCounts) return;
		this.lastSig = sig;
		this.lastCounts = tagCounts;
		this.lastRender = { tagCounts, activeTag, totalMemos, pinnedTags };
		this.container.empty();
		const titleEl = this.container.createDiv({
			cls: 'memos-lite-sidebar-title',
		});
		titleEl.createSpan({ text: 'Tags' });
		titleEl.createSpan({ cls: 'memos-lite-tag-count', text: String(tagCounts.size) });

		// (The old "All memos" row is gone: the Memos nav button above the
		// sidebar already resets to the full list — two ways to do the same
		// thing was one too many.)

		// One tree build feeds both sections: the pinned rows and the main
		// tag tree below. Counts are propagated first, so a pinned parent's
		// number covers its whole subtree — and a pinned tag shows whenever
		// it OR any descendant has memos (the map holds every path the tree
		// knows about, including intermediate parents with no direct memos).
		const { roots: tree, byName: tagNodes } = this.buildTagTree(tagCounts);

		const pinned = pinnedTags.filter((t) => tagNodes.has(t));
		if (pinned.length > 0) {
			// No section title: the pin icon on each row already says 置顶.
			const section = this.container.createDiv({ cls: 'memos-lite-pinned' });
			for (const t of pinned) {
				const node = tagNodes.get(t);
				if (!node) continue;
				const hasChildren = node.children.length > 0;
				const expanded = this.expandedTags.has(t);
				this.createTagItem(
					section,
					t,
					t,
					node.count,
					activeTag,
					true,
					hasChildren,
					expanded,
					() => this.toggleExpanded(t),
				);
				// Pinned parents reuse the tree's expand/collapse: their
				// children render into the same indented children block.
				if (hasChildren && expanded) {
					const childEl = section.createDiv({ cls: 'memos-lite-tag-children' });
					this.renderTree(childEl, node.children, activeTag);
				}
			}
		}

		// Tags render as a collapsible tree. Every row carries a leading
		// slot where the '#' glyph used to be: parents hold an expand/
		// collapse chevron there, leaves an empty slot of the same width
		// so names align at each depth. Pinned tags (and their subtrees)
		// are pruned out — they live exclusively in the pinned section
		// above, where a pinned parent can be expanded the same way.
		const pinnedSet = new Set(pinned);
		const prunePinned = (nodes: TagNode[]): TagNode[] => {
			const out: TagNode[] = [];
			for (const n of nodes) {
				if (pinnedSet.has(n.name)) continue;
				if (n.children.length > 0) n.children = prunePinned(n.children);
				out.push(n);
			}
			return out;
		};
		const treeEl = this.container.createDiv({ cls: 'memos-lite-tag-tree' });
		this.renderTree(treeEl, prunePinned(tree), activeTag);
	}

	rerender(): void {
		if (!this.lastRender) return;
		this.render(
			this.lastRender.tagCounts,
			this.lastRender.activeTag,
			this.lastRender.totalMemos,
			this.lastRender.pinnedTags,
		);
	}

	private createTagItem(
		parent: HTMLElement,
		fullName: string,
		displayName: string,
		count: number,
		activeTag: string | null,
		isPinned: boolean,
		hasChildren = false,
		expanded = false,
		onToggle?: () => void,
	): HTMLElement {
		const active = activeTag === fullName;
		const el = parent.createDiv({
			cls: 'memos-lite-tag-item' + (active ? ' active' : ''),
		});

		if (isPinned) {
			// Read back via dataset.tag on drop (order remaps by name).
			el.dataset.tag = fullName;
		}

		// Leading slot in the old '#' position. Parents get an expand/
		// collapse chevron; leaves and pinned rows keep an empty slot of
		// the same width so every name aligns at its depth.
		const toggle = el.createSpan({ cls: 'memos-lite-tag-toggle' });
		if (hasChildren && onToggle) {
			toggle.addClass('has-children');
			if (expanded) toggle.addClass('is-expanded');
			setIcon(toggle, 'chevron-right');
			toggle.setAttribute('aria-label', expanded ? 'Collapse' : 'Expand');
			toggle.addEventListener('click', (e) => {
				e.stopPropagation();
				onToggle();
			});
		}

		el.createSpan({ cls: 'memos-lite-tag-name', text: displayName });
		// Pin marker lives between the name and the count — a quiet pair
		// at the row's right edge.
		if (isPinned) {
			const pin = el.createSpan({ cls: 'memos-lite-tag-pin' });
			setIcon(pin, 'pin');
		}
		el.createSpan({ cls: 'memos-lite-tag-count', text: String(count) });

		if (Platform.isMobile) {
			const more = el.createSpan({ cls: 'memos-lite-tag-more' });
			setIcon(more, 'more-horizontal');
			more.setAttribute('aria-label', 'Tag actions');
			more.addEventListener('click', (e) => {
				e.stopPropagation();
				// Toggle: second tap on the same ⋯ closes its menu (the
				// isConnected check guards against a menu another component
				// already removed behind our back).
				if (this.tagMenuMore === more && this.tagMenuEl?.isConnected && this.closeTagMenu) {
					this.closeTagMenu();
					return;
				}
				this.showTagMenuAt(e.clientX, e.clientY, fullName, isPinned, more);
			});
		}

		el.addEventListener('click', () => {
			this.callbacks.onTagClick(active ? null : fullName);
		});
		// Right-click menu — desktop only. Mobile rows expose the same
		// actions via the ⋯ button, so a long-press/contextmenu gesture
		// there would only fight scrolling and text selection.
		if (!Platform.isMobile) {
			el.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.showTagMenuAt(e.clientX, e.clientY, fullName, isPinned);
			});
		}
		return el;
	}

	private renderTree(
		parent: HTMLElement,
		nodes: TagNode[],
		activeTag: string | null,
	): void {
		for (const node of nodes) {
			const hasChildren = node.children.length > 0;
			const expanded = this.expandedTags.has(node.name);
			this.createTagItem(
				parent,
				node.name,
				node.displayName,
				node.count,
				activeTag,
				false,
				hasChildren,
				expanded,
				() => this.toggleExpanded(node.name),
			);
			if (hasChildren && expanded) {
				const childEl = parent.createDiv({ cls: 'memos-lite-tag-children' });
				this.renderTree(childEl, node.children, activeTag);
			}
		}
	}

	private toggleExpanded(name: string): void {
		if (this.expandedTags.has(name)) {
			this.expandedTags.delete(name);
		} else {
			this.expandedTags.add(name);
		}
		this.expandRev++;
		this.rerender();
	}

	/** Builds the tag tree AND returns a name→node map covering every path
	 * it knows about (leaves AND intermediate parents), so the pinned
	 * section can look up children of a pinned parent even when that
	 * parent itself has no direct memos. */
	private buildTagTree(tagCounts: Map<string, number>): {
		roots: TagNode[];
		byName: Map<string, TagNode>;
	} {
		const roots: TagNode[] = [];
		const map = new Map<string, TagNode>();
		const entries = [...tagCounts.entries()];

		for (const [name, count] of entries) {
			const parts = name.split('/');
			let parentPath = '';
			for (let i = 0; i < parts.length; i++) {
				const path = parts.slice(0, i + 1).join('/');
				const display = parts[i]!;
				if (!map.has(path)) {
					const node: TagNode = {
						name: path,
						displayName: display,
						count: 0,
						children: [],
					};
					map.set(path, node);
					if (i === 0) roots.push(node);
					else map.get(parentPath)?.children.push(node);
				}
				if (i === parts.length - 1) {
					const node = map.get(path)!;
					node.count = count;
				}
				parentPath = path;
			}
		}
		this.propagateCounts(roots);
		this.sortByCount(roots);
		return { roots, byName: map };
	}

	/** Count-descending at every level (name as deterministic tiebreak).
	 * Runs AFTER propagateCounts: parent totals are meaningless before. */
	private sortByCount(nodes: TagNode[]): void {
		nodes.sort(
			(a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName),
		);
		for (const n of nodes) {
			if (n.children.length > 0) this.sortByCount(n.children);
		}
	}

	private propagateCounts(nodes: TagNode[]): number {
		let total = 0;
		for (const n of nodes) {
			if (n.children.length > 0) n.count += this.propagateCounts(n.children);
			total += n.count;
		}
		return total;
	}

	private showTagMenuAt(
		x: number,
		y: number,
		tag: string,
		isPinned: boolean,
		anchorEl?: HTMLElement,
	): void {
		if (this.closeTagMenu) this.closeTagMenu();
		// Other components (card menu, filter menu) share this class — sweep
		// any survivor so at most one dropdown is ever open.
		document.querySelector('.memos-card-dropdown')?.remove();
		const menu = document.body.createDiv({
			cls: 'memos-card-dropdown memos-tag-dropdown',
		});
		this.tagMenuEl = menu;
		this.tagMenuMore = anchorEl ?? null;
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

		add(isPinned ? '取消置顶' : '置顶', 'pin', () =>
			this.callbacks.onPinTag(tag),
		);
		add('重命名…', 'pencil', () => this.openRenameModal(tag));
		menu.createDiv({ cls: 'memos-card-dropdown-separator' });
		add('删除标签…', 'trash-2', () => this.openDeleteModal(tag), true);

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
			if (this.tagMenuEl === menu) {
				this.tagMenuEl = null;
				this.tagMenuMore = null;
				this.closeTagMenu = null;
			}
		};
		this.closeTagMenu = close;
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

	private openRenameModal(tag: string): void {
		new RenameTagModal(this.app, tag, (to) => {
			this.callbacks.onRenameTag(tag, to);
		}).open();
	}

	private openDeleteModal(tag: string): void {
		const count = this.lastRender?.tagCounts.get(tag) ?? 0;
		new DeleteTagModal(this.app, tag, count, () => {
			this.callbacks.onDeleteTag(tag);
		}).open();
	}
}

class RenameTagModal extends Modal {
	constructor(
		app: App,
		private tag: string,
		private onConfirm: (to: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('memos-tag-modal');
		contentEl.createEl('h3', { text: '重命名标签' });
		contentEl.createEl('p', {
			cls: 'memos-tag-modal-hint',
			text: `将批量更新所有包含 #${this.tag} 的 memo（含其子标签），其余标签不受影响。`,
		});

		let value = this.tag;
		const input = new TextComponent(contentEl)
			.setValue(this.tag)
			.onChange((v) => {
				value = v;
			});
		input.inputEl.addClass('memos-tag-modal-input');

		const actions = contentEl.createDiv({ cls: 'memos-tag-modal-actions' });
		new ButtonComponent(actions).setButtonText('取消').onClick(() => this.close());

		const submit = () => {
			const next = value.trim().replace(/^#+/, '').trim();
			if (!next || /[\s#]/.test(next)) {
				new Notice('标签名不能为空，且不能包含空格或 #');
				return;
			}
			if (next.toLowerCase() === this.tag.toLowerCase()) {
				this.close();
				return;
			}
			this.onConfirm(next);
			this.close();
		};
		new ButtonComponent(actions).setButtonText('重命名').setCta().onClick(submit);
		input.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class DeleteTagModal extends Modal {
	constructor(
		app: App,
		private tag: string,
		private count: number,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('memos-tag-modal');
		contentEl.createEl('h3', { text: '删除标签' });
		contentEl.createEl('p', {
			cls: 'memos-tag-modal-hint',
			text: `将从 ${this.count} 条 memo 中移除标签 #${this.tag}（子标签不受影响）。这会直接修改笔记内容，且无法撤销。`,
		});
		const actions = contentEl.createDiv({ cls: 'memos-tag-modal-actions' });
		new ButtonComponent(actions).setButtonText('取消').onClick(() => this.close());
		new ButtonComponent(actions)
			.setButtonText('删除')
			.setWarning()
			.onClick(() => {
				this.onConfirm();
				this.close();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
