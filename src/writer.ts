import { App, Component, MarkdownRenderer, TFile, normalizePath } from 'obsidian';
import type { MemosSettings } from './settings';
import type { BuildMemoOptions, Memo } from './types';
import type { WriteGuard } from './write-guard';
import { allocateMemoId, baseIdFromMoment, MEMO_ID_RE } from './id';
import { splitNodeText, extractLinks } from './parser';
import * as logger from './logger';

/** Structural type of Obsidian's global moment() — only what we need. */
type WindowMoment = (inp?: unknown, fmt?: string) => {
	format: (fmt: string) => string;
};

/* Canvas node layout.
 * Memo cards live in a compact near-square grid (cols ≈ √N): chronological
 * order (id ascending = oldest → newest), each card stacked into the
 * currently-shortest column, H_GAP between columns and V_GAP between rows.
 *  - INSERT moves nothing that's already there: nextSlot fills a hole at a
 *    column top when one fits, otherwise extends the shortest column.
 *  - DELETE and content EDIT (which changes a card's height) re-flow ALL
 *    memo cards via relayoutMemos, so the board always settles back into a
 *    tight rectangle — no lingering gaps, no drifted stacks.
 *  - Non-memo nodes (the user's own cards/groups/links on the same canvas)
 *    are never moved or resized. */
export const NODE_WIDTH = 360;
export const NODE_HEIGHT = 200; // minimum node height
export const V_GAP = 40; // vertical gap between stacked nodes
export const H_GAP = 60; // horizontal gap between columns

/* Obsidian's canvas text node renders its content with a little internal
 * padding. We mimic that width when measuring off-screen, then add padding +
 * slack to the measured height so content never quite overflows into the
 * node's internal scrollbar. Slight over-estimation is the safe direction. */
const NODE_PAD = 16;
const HEIGHT_SLACK = 16;

/** Extensions that are never "attachments" — notes and canvases are content
 * in their own right and must never be orphan-collected on memo deletion. */
const NOTE_EXTS = new Set(['md', 'canvas']);

export interface CanvasNode {
	id: string;
	type: string;
	text?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	[key: string]: unknown;
}
export interface CanvasEdge {
	id?: string;
	fromNode?: string;
	toNode?: string;
	[key: string]: unknown;
}
export interface CanvasData {
	nodes?: CanvasNode[];
	edges?: CanvasEdge[];
	[key: string]: unknown;
}

/**
 * Serialize memo content + metadata into a canvas node's `text`.
 * The meta marker line is parsed back by parser.ts:splitNodeText/parseCanvasMeta.
 */
export function buildNodeText(opts: BuildMemoOptions): string {
	const tokens = [`updated: ${opts.updatedAt}`];
	if (opts.pinned) tokens.push('pinned');
	if (opts.starred) tokens.push('starred');
	if (opts.archived) tokens.push('archived');
	// Separate token (the parser strict-matches bare `archived`), so older
	// readers still see a plain archived flag and just ignore the timestamp.
	if (opts.archived && opts.archivedAt) {
		tokens.push(`archivedAt: ${opts.archivedAt}`);
	}
	const body = opts.content.replace(/\s+$/, '');
	return `${body}\n<!-- memos-meta | ${tokens.join(' | ')} -->`;
}

/** Number of columns for a near-square layout of n nodes. */
export function columnCount(n: number): number {
	return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
}

/**
 * Render `content` into a hidden off-screen container at the node's content
 * width and measure the resulting height, so the canvas node can be sized to
 * fit without an internal scrollbar. Runs once per write (rare) — cheap at
 * this app's scale. Falls back to NODE_HEIGHT on any failure.
 */
export async function measureContentHeight(
	app: App,
	content: string,
	sourcePath: string,
): Promise<number> {
	const host = document.body.createDiv({
		attr: {
			style:
				`position:absolute;left:-99999px;top:0;visibility:hidden;` +
				`pointer-events:none;width:${NODE_WIDTH - NODE_PAD * 2}px;`,
		},
	});
	const comp = new Component();
	comp.load();
	let h = 0;
	try {
		await MarkdownRenderer.render(app, content, host, sourcePath, comp);
		h = host.scrollHeight;
	} catch (e) {
		logger.error('Failed to measure memo height', e);
	} finally {
		comp.unload();
		host.remove();
	}
	return Math.max(NODE_HEIGHT, h + NODE_PAD * 2 + HEIGHT_SLACK);
}

/**
 * Placement for a new node of height `newHeight`.
 * 1. Fill a hole: any column whose topmost card starts at y ≥ newHeight+V_GAP
 *    has room above it — prefer those (lowest bottom first = the column with
 *    the most missing area, ties → leftmost). An entirely empty column counts
 *    as a hole at y=0, which grows the grid sideways for the near-square shape.
 * 2. Otherwise append to the shortest column.
 * Existing nodes are only read (to infer each column's top/bottom), never
 * mutated — so a user's manual arrangement is left intact.
 */
export function nextSlot(
	nodes: CanvasNode[],
	newHeight: number,
): { x: number; y: number } {
	const cols = columnCount(nodes.length + 1);
	const colW = NODE_WIDTH + H_GAP;
	const tops = new Array<number>(cols).fill(Number.POSITIVE_INFINITY);
	const bottoms = new Array<number>(cols).fill(0);
	for (const n of nodes) {
		const x = typeof n.x === 'number' ? n.x : 0;
		const col = Math.max(0, Math.min(cols - 1, Math.round(x / colW)));
		const y = typeof n.y === 'number' ? n.y : 0;
		const hgt = typeof n.height === 'number' ? n.height : NODE_HEIGHT;
		if (y < tops[col]!) tops[col] = y;
		const b = y + hgt + V_GAP;
		if (b > bottoms[col]!) bottoms[col] = b;
	}
	let hole = -1;
	for (let i = 0; i < cols; i++) {
		if (tops[i]! < newHeight + V_GAP) continue;
		if (hole === -1 || bottoms[i]! < bottoms[hole]!) hole = i;
	}
	if (hole !== -1) return { x: hole * colW, y: 0 };
	let col = 0;
	for (let i = 1; i < cols; i++) if (bottoms[i]! < bottoms[col]!) col = i;
	return { x: col * colW, y: bottoms[col]! };
}

/**
 * Re-flow every memo node into the canonical compact grid: chronological
 * order (id ascending), packed into the shortest column of a near-square
 * layout starting at (0,0). Deterministic — the same set of memos always
 * produces the same arrangement. Nodes that aren't plugin memos (the user's
 * own canvas content) are left exactly where they are. Called after deletes
 * and content edits so the board settles back into a tight rectangle.
 */
export function relayoutMemos(nodes: CanvasNode[]): void {
	const memos = nodes.filter(
		(n) =>
			n.type === 'text' &&
			typeof n.id === 'string' &&
			MEMO_ID_RE.test(n.id),
	);
	if (memos.length === 0) return;
	memos.sort((a, b) => a.id.localeCompare(b.id));
	const cols = columnCount(memos.length);
	const colW = NODE_WIDTH + H_GAP;
	const bottoms = new Array<number>(cols).fill(0);
	for (const n of memos) {
		let col = 0;
		for (let i = 1; i < cols; i++) if (bottoms[i]! < bottoms[col]!) col = i;
		n.x = col * colW;
		n.y = bottoms[col]!;
		n.width = NODE_WIDTH;
		bottoms[col] =
			bottoms[col]! +
			(typeof n.height === 'number' ? n.height : NODE_HEIGHT) +
			V_GAP;
	}
}

export class MemoWriter {
	constructor(
		private app: App,
		private settings: MemosSettings,
		private writeGuard: WriteGuard,
	) {}

	getPath(forDate?: { format: (f: string) => string }): string {
		const m = forDate ?? windowMoment();
		const year = m.format('YYYY');
		return normalizePath(this.settings.storagePath.replace(/\{year\}/g, year));
	}

	async ensureFile(path?: string): Promise<TFile> {
		const p = path ?? this.getPath();
		const existing = this.app.vault.getAbstractFileByPath(p);
		if (existing instanceof TFile) return existing;
		if (!existing) {
			const slash = p.lastIndexOf('/');
			if (slash > 0) {
				await this.app.vault
					.createFolder(p.substring(0, slash))
					.catch(() => null);
			}
			return await this.app.vault.create(p, '{"nodes":[],"edges":[]}');
		}
		throw new Error(`Memos storage path is blocked by a folder: ${p}`);
	}

	/** Read-modify-write helpers. We preserve every top-level key Obsidian
	 * writes (notably `metadata`) by round-tripping the whole parsed object. */
	private async readCanvas(file: TFile): Promise<CanvasData> {
		const raw = await this.app.vault.read(file);
		try {
			const data = JSON.parse(raw) as CanvasData;
			if (data && typeof data === 'object') {
				if (!Array.isArray(data.nodes)) data.nodes = [];
				return data;
			}
		} catch (e) {
			logger.error('Failed to parse canvas', file.path, e);
		}
		return { nodes: [], edges: [] };
	}

	private async writeCanvas(file: TFile, data: CanvasData): Promise<void> {
		this.writeGuard.setWriting(true);
		this.writeGuard.recordWrite(file.path);
		try {
			await this.app.vault.modify(file, JSON.stringify(data));
		} finally {
			window.setTimeout(() => this.writeGuard.setWriting(false), 100);
		}
	}

	async insertMemo(content: string): Promise<Memo> {
		const now = windowMoment();
		const month = now.format('MM');
		const updatedAt = now.format('YYYY-MM-DD HH:mm:ss');
		const file = await this.ensureFile();

		const data = await this.readCanvas(file);
		const nodes = data.nodes!;
		const existing = new Set(
			nodes.map((n) => (typeof n.id === 'string' ? n.id : '')),
		);
		const id = allocateMemoId(baseIdFromMoment(now), existing);
		const height = await measureContentHeight(this.app, content, file.path);
		const { x, y } = nextSlot(nodes, height);

		nodes.push({
			id,
			type: 'text',
			x,
			y,
			width: NODE_WIDTH,
			height,
			text: buildNodeText({ id, content, updatedAt }),
		});
		await this.writeCanvas(file, data);

		return {
			id,
			date: now.format('YYYY-MM-DD'),
			month,
			time: id,
			content,
			updatedAt,
			sourceFile: file.path,
			lineStart: 0,
			pinned: false,
			starred: false,
			archived: false,
			tags: [],
			links: [],
			reactions: [],
			comments: [],
		} satisfies Memo;
	}

	async updateMemo(memo: Memo, newContent: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(memo.sourceFile);
		if (!(file instanceof TFile)) return;

		const updatedAt = windowMoment().format('YYYY-MM-DD HH:mm:ss');
		const data = await this.readCanvas(file);
		const node = data.nodes!.find((n) => n.id === memo.id);
		if (!node) return;

		const { content: oldContent } = splitNodeText(
			typeof node.text === 'string' ? node.text : '',
		);
		node.text = buildNodeText({
			id: memo.id,
			content: newContent,
			updatedAt,
			pinned: memo.pinned,
			starred: memo.starred,
			archived: memo.archived,
			archivedAt: memo.archivedAt,
		});
		// Only re-measure when the content actually changed (pin/archive flips
		// touch metadata only, so height stays the same — skip the render).
		if (newContent !== oldContent) {
			node.height = await measureContentHeight(this.app, newContent, file.path);
			// Height changed → re-flow the whole grid so it stays compact.
			relayoutMemos(data.nodes!);
		}
		await this.writeCanvas(file, data);
	}

	async deleteMemo(memo: Memo): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(memo.sourceFile);
		if (!(file instanceof TFile)) return;

		const data = await this.readCanvas(file);
		const remaining = data.nodes!.filter((n) => n.id !== memo.id);
		data.nodes = remaining;
		if (Array.isArray(data.edges)) {
			data.edges = data.edges.filter(
				(e) => e.fromNode !== memo.id && e.toNode !== memo.id,
			);
		}
		// Re-flow the remaining memo cards into a compact grid (the user's
		// own non-memo canvas content is left where it is).
		if (data.nodes.length > 0) relayoutMemos(data.nodes);
		await this.writeCanvas(file, data);

		await this.cleanupOrphanedAttachments(memo, remaining);
	}

	/** Delete attachments the removed memo referenced — but ONLY ones no
	 * other note still references (any remaining node of the same canvas,
	 * any other canvas node/text, or any metadata-cache-indexed file). A
	 * shared image survives its first referrer's deletion; an exclusively
	 * used one goes to the vault trash (respects the user's "Deleted files"
	 * setting, so it stays recoverable). */
	private async cleanupOrphanedAttachments(
		memo: Memo,
		remainingNodes: CanvasNode[],
	): Promise<void> {
		// ── Candidates: non-note files this memo linked/embedded ──
		const candidates = new Map<string, TFile>();
		for (const target of extractLinks(memo.content)) {
			const linkpath = target.split('#')[0]!.trim();
			if (!linkpath) continue;
			const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, memo.sourceFile);
			if (!(dest instanceof TFile)) continue;
			if (NOTE_EXTS.has(dest.extension.toLowerCase())) continue;
			candidates.set(dest.path, dest);
		}
		if (candidates.size === 0) return;

		// ── Reference sources 1+2: every OTHER canvas node in the vault ──
		// text nodes (wikilinks resolved against that canvas) and file
		// nodes (an image pinned straight onto the board counts as a ref).
		const canvasSources: Array<{ path: string; text: string }> = [];
		const canvasFileRefs = new Set<string>();
		const collect = (sourcePath: string, nodes: CanvasNode[]): void => {
			for (const n of nodes) {
				if (typeof n.text === 'string') canvasSources.push({ path: sourcePath, text: n.text });
				if (typeof n.file === 'string') canvasFileRefs.add(normalizePath(n.file));
			}
		};
		collect(memo.sourceFile, remainingNodes);
		for (const cf of this.app.vault.getFiles()) {
			if (cf.extension !== 'canvas' || cf.path === memo.sourceFile) continue;
			try {
				const data = JSON.parse(await this.app.vault.cachedRead(cf)) as CanvasData;
				if (Array.isArray(data.nodes)) collect(cf.path, data.nodes);
			} catch {
				// Unreadable canvas — skip it; cleanup must never fail the delete.
			}
		}
		const referencedByCanvas = (filePath: string): boolean => {
			if (canvasFileRefs.has(filePath)) return true;
			for (const src of canvasSources) {
				for (const link of extractLinks(src.text)) {
					const lp = link.split('#')[0]!.trim();
					if (!lp) continue;
					if (this.app.metadataCache.getFirstLinkpathDest(lp, src.path)?.path === filePath) {
						return true;
					}
				}
			}
			return false;
		};

		// ── Reference source 3: every other indexed file (markdown etc.) ──
		// resolvedLinks aggregates ALL of a source file's refs (canvas nodes
		// included where Obsidian indexes them), so the deleted memo's own
		// canvas is excluded — its surviving nodes were checked above.
		const otherRefs = new Set<string>();
		for (const [src, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (src === memo.sourceFile) continue;
			for (const t of Object.keys(links)) otherRefs.add(t);
		}

		for (const [path, file] of candidates) {
			if (referencedByCanvas(path) || otherRefs.has(path)) continue;
			try {
				// FileManager.trashFile honours the user's "Deleted files"
				// preference (vault .trash vs system trash).
				await this.app.fileManager.trashFile(file);
			} catch {
				// Already gone / locked — nothing more to do.
			}
		}
	}

	async togglePin(memo: Memo): Promise<void> {
		memo.pinned = !memo.pinned;
		await this.updateMemo(memo, memo.content);
	}

	/** Star ≠ pin: starring collects the memo into the sidebar 星标 view;
	 * pinning (togglePin) sorts it to the top. Independent flags. */
	async toggleStar(memo: Memo): Promise<void> {
		memo.starred = !memo.starred;
		await this.updateMemo(memo, memo.content);
	}

	async toggleArchive(memo: Memo): Promise<void> {
		memo.archived = !memo.archived;
		// Stamp the archive time so the retention purge knows when the clock
		// started; unarchiving clears it (re-archiving starts a fresh period).
		memo.archivedAt = memo.archived ? new Date().toISOString() : undefined;
		await this.updateMemo(memo, memo.content);
	}

	async bulkUpdateMemos(
		memos: Memo[],
		transform: (content: string) => string,
	): Promise<void> {
		const byFile = new Map<string, Memo[]>();
		for (const m of memos) {
			const list = byFile.get(m.sourceFile) ?? [];
			list.push(m);
			byFile.set(m.sourceFile, list);
		}

		for (const [path, group] of byFile) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			const data = await this.readCanvas(file);
			let changed = false;
			for (const memo of group) {
				const node = data.nodes!.find((n) => n.id === memo.id);
				if (!node || typeof node.text !== 'string') continue;

				const { content: oldContent } = splitNodeText(node.text);
				const newContent = transform(oldContent);
				if (newContent === oldContent) continue;

				const updatedAt =
					memo.updatedAt || windowMoment().format('YYYY-MM-DD HH:mm:ss');
				node.text = buildNodeText({
					id: memo.id,
					content: newContent,
					updatedAt,
					pinned: memo.pinned,
					archived: memo.archived,
					archivedAt: memo.archivedAt,
				});
				node.height = await measureContentHeight(
					this.app,
					newContent,
					file.path,
				);
				changed = true;
			}
			if (changed) {
				// Content (and thus heights) changed → re-flow into a compact grid.
				relayoutMemos(data.nodes!);
				await this.writeCanvas(file, data);
			}
		}
	}
}

function windowMoment(): ReturnType<WindowMoment> {
	return (window as unknown as { moment: WindowMoment }).moment();
}
