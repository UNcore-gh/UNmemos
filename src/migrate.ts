import { App, Notice, TFile } from 'obsidian';
import type { MemosSettings } from './settings';
import type { Memo } from './types';
import type { WriteGuard } from './write-guard';
import {
	buildNodeText,
	columnCount,
	measureContentHeight,
	NODE_WIDTH,
	H_GAP,
	V_GAP,
	type CanvasNode,
} from './writer';
import { parseMarkdownMemos } from './parser';
import { MEMO_ID_RE, allocateMemoId, legacyToBaseId } from './id';
import * as logger from './logger';

/**
 * One-shot migration: markdown storage (`Memos/YYYY.md`, heading or legacy
 * callout format) → canvas storage (`Memos/YYYY.canvas`).
 *
 * Each markdown memo becomes one canvas text node whose id is the 16-digit
 * timestamp id. Legacy callout ids (8-hex) are re-assigned to proper
 * timestamp ids. The original `.md` is backed up to
 * `<path>.pre-canvas-migration` and left in place (the live loader only
 * matches `.canvas`, so the leftover markdown is ignored).
 *
 * Runs after layout is ready so the vault file index is complete.
 */
export async function migrateToCanvasIfNeeded(
	app: App,
	settings: MemosSettings,
	writeGuard: WriteGuard,
	saveSettings: () => Promise<void>,
): Promise<boolean> {
	if (settings.migratedToCanvas) return false;

	const mdFiles = findMarkdownStorageFiles(app, settings.storagePath);
	if (mdFiles.length === 0) {
		settings.migratedToCanvas = true;
		await saveSettings();
		return false;
	}

	let migratedCount = 0;

	for (const file of mdFiles) {
		const text = await app.vault.read(file);
		const memos = parseMarkdownMemos(text, file.path);
		if (memos.length === 0) continue;

		// Normalize ids to 16-digit timestamps; legacy callout ids are 8-hex.
		const used = new Set<string>();
		const normalized: Memo[] = [];
		for (const m of memos) {
			if (MEMO_ID_RE.test(m.id)) {
				used.add(m.id);
				normalized.push(m);
			} else {
				const base = legacyToBaseId(m.date, m.time || '00:00:00');
				const id = allocateMemoId(base, used);
				used.add(id);
				normalized.push({ ...m, id, time: id, month: m.date.slice(5, 7) });
			}
		}

		// Layout: chronological (oldest first). Size each node to its content
		// (no internal scroll) and arrange in a near-square grid — columns ≈ √N,
		// each column stacking with its own running y so varied heights fit cleanly.
		normalized.sort((a, b) => a.id.localeCompare(b.id));
		const canvasPath = file.path.replace(/\.md$/, '.canvas');
		const heights: number[] = [];
		for (const m of normalized) {
			heights.push(await measureContentHeight(app, m.content, canvasPath));
		}
		const cols = columnCount(normalized.length);
		const colW = NODE_WIDTH + H_GAP;
		const runningY = new Array<number>(cols).fill(0);
		const nodes: CanvasNode[] = normalized.map((m, i) => {
			let col = 0;
			for (let c = 1; c < cols; c++) if (runningY[c]! < runningY[col]!) col = c;
			const node: CanvasNode = {
				id: m.id,
				type: 'text',
				x: col * colW,
				y: runningY[col]!,
				width: NODE_WIDTH,
				height: heights[i]!,
				text: buildNodeText({
					id: m.id,
					content: m.content,
					updatedAt: m.updatedAt,
					pinned: m.pinned,
					archived: m.archived,
				}),
			};
			runningY[col] = runningY[col]! + heights[i]! + V_GAP;
			return node;
		});
		const canvasData = JSON.stringify({ nodes, edges: [] });

		// Backup the markdown source; never delete the original.
		const backupPath = file.path + '.pre-canvas-migration';
		try {
			if (!app.vault.getAbstractFileByPath(backupPath)) {
				await app.vault.create(backupPath, text);
			}
		} catch (e) {
			logger.error('canvas backup failed', backupPath, e);
		}

		// Write the canvas file under the write guard.
		writeGuard.setWriting(true);
		writeGuard.recordWrite(canvasPath);
		try {
			const existing = app.vault.getAbstractFileByPath(canvasPath);
			if (existing instanceof TFile) {
				await app.vault.modify(existing, canvasData);
			} else {
				const slash = canvasPath.lastIndexOf('/');
				if (slash > 0) {
					await app.vault
						.createFolder(canvasPath.substring(0, slash))
						.catch(() => null);
				}
				await app.vault.create(canvasPath, canvasData);
			}
			migratedCount += normalized.length;
		} finally {
			window.setTimeout(() => writeGuard.setWriting(false), 100);
		}
	}

	settings.migratedToCanvas = true;
	await saveSettings();
	new Notice(
		`Memos: migrated ${migratedCount} memo(s) to canvas. Backups: *.pre-canvas-migration`,
	);
	return true;
}

/** Find legacy markdown storage files for the configured template. */
function findMarkdownStorageFiles(app: App, tpl: string): TFile[] {
	if (tpl.includes('{year}')) {
		const slash = tpl.lastIndexOf('/');
		const dir = slash > 0 ? tpl.substring(0, slash) : '';
		const re = new RegExp('^' + escapeRegExp(dir) + '/\\d{4}\\.md$');
		return app.vault.getFiles().filter((f) => re.test(f.path));
	}
	if (/\.md$/.test(tpl)) {
		const f = app.vault.getAbstractFileByPath(tpl);
		return f instanceof TFile ? [f] : [];
	}
	return [];
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
