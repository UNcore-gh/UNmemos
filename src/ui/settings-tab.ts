import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type MemosPlugin from '../main';
import { getLang, t, tf, type Lang } from '../i18n';
import { applyAccent } from '../color';
import * as logger from '../logger';
import { FLOMO_IMPORT_GUIDE } from '../flomo-guide';
import { MemosView, VIEW_TYPE } from './view';

export class MemosSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: MemosPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('memos-settings');
		new Setting(containerEl).setName("").setHeading();

		// ── Language ────────────────────────────────────────────────
		// Segmented 中文 / EN switch; flipping it re-renders this whole
		// tab and re-registers the commands in the new language.
		const langRow = new Setting(containerEl)
			.setName(t('langLabel'))
			.setDesc(t('langDesc'));
		const seg = langRow.controlEl.createDiv({ cls: 'memos-lang-switch' });
		const langs: Array<[Lang, string]> = [
			['zh', '中文'],
			['en', 'EN'],
		];
		for (const [value, label] of langs) {
			const btn = seg.createEl('button', {
				cls:
					'memos-lang-btn' +
					(getLang() === value ? ' active' : ''),
				text: label,
				attr: { type: 'button' },
			});
			btn.addEventListener('click', () => {
				if (getLang() === value) return;
				void this.plugin.applyLanguage(value).then(() => this.display());
			});
		}

		// ── Appearance ──────────────────────────────────────────────
		// Accent color: a row of preset swatches plus a native color
		// picker for any custom hex. Changing it publishes new --memos-accent*
		// vars on <body>, so every open view/popover re-themes live.
		this.section(containerEl, t('secAppearance'));

		const accentRow = new Setting(containerEl)
			.setName(t('accentName'))
			.setDesc(t('accentDesc'));
		const wrap = accentRow.controlEl.createDiv({ cls: 'memos-accent-row' });
		const swatches = wrap.createDiv({ cls: 'memos-swatch-row' });
		const PRESETS = [
			'#07c160',
			'#3b82f6',
			'#6366f1',
			'#a855f7',
			'#ec4899',
			'#ef4444',
			'#f97316',
			'#14b8a6',
			'#64748b',
		];
		const cur = (): string =>
			(this.plugin.settings.accentColor || '#07c160').toLowerCase();
		for (const hex of PRESETS) {
			const sw = swatches.createEl('button', {
				cls:
					'memos-swatch' +
					(cur() === hex.toLowerCase() ? ' active' : ''),
				attr: { type: 'button', 'aria-label': hex, title: hex },
			});
			// color drives the active-ring (currentColor); background paints
			// the chip. Inline styles beat Obsidian's global button rules.
			sw.style.background = hex;
			sw.style.color = hex;
			sw.addEventListener('click', () => {
				void this.plugin.setAccent(hex).then(() => this.display());
			});
		}
		const custom = wrap.createEl('label', { cls: 'memos-color-input' });
		const input = custom.createEl('input', {
			type: 'color',
			attr: { value: cur() },
		});
		custom.createSpan({ cls: 'memos-color-input-label', text: t('accentCustom') });
		// Live preview while dragging the picker; persist on commit.
		input.addEventListener('input', () => {
			this.plugin.settings.accentColor = input.value;
			applyAccent(input.value);
		});
		input.addEventListener('change', () => {
			void this.plugin.saveSettings().then(() => this.display());
		});

		// ── Storage ─────────────────────────────────────────────────
		this.section(containerEl, t('secStorage'));

		new Setting(containerEl)
			.setName(t('storageName'))
			.setDesc(t('storageDesc'))
			.addText((text) =>
				text
					.setPlaceholder('Memos/{year}.canvas')
					.setValue(this.plugin.settings.storagePath)
					.onChange(async (value) => {
						this.plugin.settings.storagePath =
							value || 'Memos/{year}.canvas';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('retentionName'))
			.setDesc(t('retentionDesc'))
			.addDropdown((d) =>
				d
					.addOption('0', t('retentionNever'))
					.addOption('7', t('retentionDays7'))
					.addOption('30', t('retentionDays30'))
					.addOption('90', t('retentionDays90'))
					.addOption('180', t('retentionDays180'))
					.setValue(String(this.plugin.settings.archiveRetentionDays))
					.onChange(async (value) => {
						this.plugin.settings.archiveRetentionDays =
							Number(value) || 0;
						await this.plugin.saveSettings();
						// Apply the new policy immediately instead of waiting
						// for the hourly check.
						void this.plugin.purgeExpiredArchived();
					}),
			);

		containerEl.createDiv({ cls: 'memos-settings-note', text: t('storageNote') });

		// ── Editor ──────────────────────────────────────────────────
		this.section(containerEl, t('secEditor'));

		new Setting(containerEl)
			.setName(t('defaultTagName'))
			.setDesc(t('defaultTagDesc'))
			.addText((text) =>
				text
					.setPlaceholder('')
					.setValue(this.plugin.settings.defaultTag)
					.onChange(async (value) => {
						this.plugin.settings.defaultTag = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('focusName'))
			.setDesc(t('focusDesc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.focusOnOpen)
					.onChange(async (value) => {
						this.plugin.settings.focusOnOpen = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('globalMentionName'))
			.setDesc(t('globalMentionDesc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.globalMention)
					.onChange(async (value) => {
						this.plugin.settings.globalMention = value;
						await this.plugin.saveSettings();
					}),
			);

		// 移动端快速编辑栏：iPad 等设备上出现有 ~2s 延迟且可能发热，默认关闭，
		// 需要的人自行开启（见 editor.ts 的 claim 门控）。
		new Setting(containerEl)
			.setName(t('mobileToolbarName'))
			.setDesc(t('mobileToolbarDesc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.mobileToolbar)
					.onChange(async (value) => {
						this.plugin.settings.mobileToolbar = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── Sidebar ─────────────────────────────────────────────────
		this.section(containerEl, t('secSidebar'));

		new Setting(containerEl)
			.setName(t('heatmapName'))
			.setDesc(t('heatmapDesc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeatmap)
					.onChange(async (value) => {
						this.plugin.settings.showHeatmap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('tagsName'))
			.setDesc(t('tagsDesc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showTags)
					.onChange(async (value) => {
						this.plugin.settings.showTags = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('sidePosName'))
			.setDesc(t('sidePosDesc'))
			.addDropdown((d) =>
				d
					.addOption('right', t('sideRight'))
					.addOption('left', t('sideLeft'))
					.setValue(this.plugin.settings.sidebarPosition)
					.onChange(async (value) => {
						this.plugin.settings.sidebarPosition = value as
							| 'left'
							| 'right';
						await this.plugin.saveSettings();
						this.refreshMemosViews();
					}),
			);

		// ── Import ─────────────────────────────────────────────────
		this.section(containerEl, t('secImport'));

		// Agent playbook for turning flomo data (API or export) into
		// native memos notes — copy & paste into an AI assistant chat.
		// Interim UX until this ships as a built-in importer.
		new Setting(containerEl)
			.setName(t('flomoGuideName'))
			.setDesc(t('flomoGuideDesc'))
			.addButton((btn) =>
				btn
					.setButtonText(t('flomoGuideCopy'))
					.setCta()
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(FLOMO_IMPORT_GUIDE);
							new Notice(t('flomoGuideCopied'));
						} catch {
							new Notice(t('flomoGuideCopyFail'));
						}
					}),
			);

		// ── Diagnostics ────────────────────────────────────────────
		// Opt-in in-memory debug log (src/logger.ts). Off = fully silent;
		// on = ring buffer the user can export and send to the developer.
		this.section(containerEl, t('secDebug'));

		new Setting(containerEl)
			.setName(t('debugLogName'))
			.setDesc(t('debugLogDesc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLog)
					.onChange(async (value) => {
						this.plugin.settings.debugLog = value;
						// saveSettings syncs the logger switch.
						await this.plugin.saveSettings();
						this.display(); // refresh the entry counter
					}),
			);

		const exportRow = new Setting(containerEl)
			.setName(t('debugExportName'))
			.setDesc(
				tf('debugCount', { n: logger.entryCount() }) +
					' ' +
					t('debugExportDesc'),
			);
		exportRow.addButton((btn) =>
			btn.setButtonText(t('debugExportCopy')).onClick(async () => {
				if (logger.entryCount() === 0) {
					new Notice(t('debugEmpty'));
					return;
				}
				try {
					await navigator.clipboard.writeText(logger.buildReport());
					new Notice(t('debugCopied'));
				} catch {
					new Notice(t('flomoGuideCopyFail'));
				}
			}),
		);
		exportRow.addButton((btn) =>
			btn.setButtonText(t('debugExportFile')).onClick(async () => {
				if (logger.entryCount() === 0) {
					new Notice(t('debugEmpty'));
					return;
				}
				try {
					const path = await this.saveReportToVault();
					new Notice(tf('debugSaved', { path }));
				} catch {
					new Notice(t('debugSaveFail'));
				}
			}),
		);
		exportRow.addButton((btn) =>
			btn.setButtonText(t('debugClear')).onClick(() => {
				logger.clear();
				this.display();
			}),
		);
	}

	/** Write the report to `memos-debug-log-<timestamp>.txt` at the vault
	 * root; retries with a numeric suffix on name collision. */
	private async saveReportToVault(): Promise<string> {
		const stamp = new Date()
			.toISOString()
			.replace(/[-:T]/g, '')
			.slice(0, 14);
		const report = logger.buildReport();
		let path = `memos-debug-log-${stamp}.txt`;
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
			path = `memos-debug-log-${stamp}-${i}.txt`;
		}
		await this.app.vault.create(path, report);
		return path;
	}

	/** Small section heading with a green tick bar — breaks the flat
	 * setting list into scannable groups. */
	private section(containerEl: HTMLElement, title: string): void {
		new Setting(containerEl).setName("").setHeading();
	}

	private refreshMemosViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof MemosView) leaf.view.applySidebarLayout();
		}
	}
}
