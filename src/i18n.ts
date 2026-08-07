/**
 * Tiny runtime i18n for the plugin chrome (settings tab + command names).
 * The memo feed UI itself is authored in Chinese; only the surfaces named
 * in the localization request go through this dictionary.
 *
 * The language lives in plugin settings; main.ts calls setLang() at load
 * and whenever the settings tab's 中文 / EN switch is flipped.
 */
export type Lang = 'zh' | 'en';

const STRINGS = {
	zh: {
		// Settings tab
		settingsTitle: 'Memos 设置',
		langLabel: '界面语言',
		langDesc: '切换设置界面与命令面板中命令的语言。',
		secStorage: '存储',
		secEditor: '编辑器',
		secSidebar: '侧边栏',
		secAppearance: '外观',
		accentName: '主题色',
		accentDesc:
			'插件强调色，影响按钮、标签高亮、热力图等。可从预设中选择，或用取色器自定义。',
		accentCustom: '自定义',
		storageName: '存储路径',
		storageDesc:
			'Memo 文件的路径。用 {year} 表示按年分文件，例如 Memos/{year}.canvas',
		defaultTagName: '默认标签',
		defaultTagDesc: '新建 memo 时自动追加该标签（可选，不带 #）。',
		focusName: '打开时聚焦编辑器',
		focusDesc: '打开视图时自动聚焦输入框，随手就能记。',
		globalMentionName: '在所有编辑器中启用 @ 引用',
		globalMentionDesc:
			'在普通笔记（源码 / 实时预览）和白板文本节点中输入 @ 引用 memo、@@ 新建空白笔记。关闭后仅在 Memos 界面内可用。开启时可能与 Obsidian 自带的 @ 文件提及弹窗同时出现，回车优先选中本插件的候选。',
		mobileToolbarName: '移动端快速编辑栏',
		mobileToolbarDesc:
			'Obsidian 自带的移动端快速编辑栏（加粗 / 斜体等格式按钮）在 iPad 等平板设备上出现有约 2 秒延迟且可能引起发热。默认关闭以规避；开启后恢复使用它。此开关仅影响 iPad 等平板设备，手机端不受影响。',
		heatmapName: '显示热力图',
		heatmapDesc: '在侧边栏显示记录活动热力图。',
		tagsName: '显示标签',
		tagsDesc: '在侧边栏显示标签筛选树。',
		sidePosName: '侧边栏位置',
		sidePosDesc: '侧边栏停靠在哪一侧。拖动侧边栏边缘可调整宽度，宽度会自动保存。',
		sideRight: '右侧',
		sideLeft: '左侧',
		retentionName: '归档保留时长',
		retentionDesc:
			'归档的 memo 在自动删除前保留多久。「永久保留」（默认）表示永不自动删除。在此功能出现之前归档的 memo 永远不会被自动删除。',
		retentionNever: '永久保留',
		retentionDays7: '7 天后',
		retentionDays30: '30 天后',
		retentionDays90: '90 天后',
		retentionDays180: '180 天后',
		secImport: '数据导入',
		flomoGuideName: 'flomo 导入指南',
		flomoGuideDesc:
			'给 AI 助手的完整操作手册：把 flomo 笔记（API 全量或导出文件）导入为原生 memos 笔记。复制后直接发给助手即可，后续版本会升级为内置导入。',
		flomoGuideCopy: '复制指南',
		flomoGuideCopied: '指南已复制到剪贴板',
		flomoGuideCopyFail: '复制失败',
		storageNote:
			'存储格式：每年一个 canvas 文件（Memos/{year}.canvas），每条 memo 是一个 id 为时间戳（YYYYMMDDHHmmSSSS）的文本节点。可用 [[Memos/2026.canvas#2026072601370000]] 引用某条 memo。',
		// Diagnostics
		secDebug: '诊断',
		debugLogName: '调试日志',
		debugLogDesc:
			'关闭时完全静默，不记录任何内容。开启后插件在内存中记录运行日志（重启后清空），遇到问题时导出并发给开发者以协助排查。日志不会自动写入任何文件，也不包含笔记正文。',
		debugExportName: '导出日志',
		debugExportDesc:
			'复制后可直接粘贴发送；保存到库则在仓库根目录生成 txt 文件。',
		debugCount: '当前已记录 {n} 条。',
		debugExportCopy: '复制日志',
		debugExportFile: '保存到库',
		debugClear: '清空',
		debugEmpty: '暂无日志',
		debugCopied: '日志已复制到剪贴板',
		debugSaved: '日志已保存到 {path}',
		debugSaveFail: '保存失败',
		// Commands + ribbon
		cmdOpenView: '打开 Memos',
		cmdOpenSidebar: '在侧边栏打开 Memos',
		cmdOpenWindow: '在新窗口打开 Memos',
		cmdFocusEditor: '聚焦 Memos 编辑器',
		cmdOpenSettings: '打开 Memos 设置',
		ribbonOpen: '打开 Memos',
		// Notices
		purgeNotice: '已自动删除 {n} 条过期归档 memo',
	},
	en: {
		settingsTitle: 'Memos Settings',
		langLabel: 'Interface language',
		langDesc: 'Switch the language of the settings screen and command palette entries.',
		secStorage: 'Storage',
		secEditor: 'Editor',
		secSidebar: 'Sidebar',
		secAppearance: 'Appearance',
		accentName: 'Accent color',
		accentDesc:
			'The plugin accent used for buttons, tag highlights, the heatmap and more. Pick a preset or use the color picker.',
		accentCustom: 'Custom',
		storageName: 'Storage path',
		storageDesc:
			'Path to the memo file. Use {year} for yearly files, e.g. Memos/{year}.canvas',
		defaultTagName: 'Default tag',
		defaultTagDesc:
			'Automatically append this tag to every new memo (optional, without #).',
		focusName: 'Focus editor on open',
		focusDesc: 'Automatically focus the input when opening the view.',
		globalMentionName: '@ mentions in all editors',
		globalMentionDesc:
			'Type @ to reference a memo, or @@ to create a blank one, from any note (source & live preview) and canvas text node. When off, mentions work only inside the Memos view. Obsidian\'s built-in @ file suggestions may appear alongside; Enter picks this plugin\'s candidate first.',
		mobileToolbarName: 'Mobile quick-edit toolbar',
		mobileToolbarDesc:
			"Obsidian's mobile quick-edit toolbar (bold / italic formatting buttons) appears with a ~2s delay on iPad and other tablets and can cause overheating. Off by default to avoid this; turn on to restore it. Only affects tablets — phones are unaffected.",
		heatmapName: 'Show heatmap',
		heatmapDesc: 'Display the activity heatmap in the sidebar.',
		tagsName: 'Show tags',
		tagsDesc: 'Display the tag filter tree in the sidebar.',
		sidePosName: 'Sidebar position',
		sidePosDesc:
			'Which side the sidebar docks on. Drag the sidebar edge to resize — the width is saved automatically.',
		sideRight: 'Right',
		sideLeft: 'Left',
		retentionName: 'Archive retention',
		retentionDesc:
			'How long an archived memo is kept before it is deleted automatically. Never (the default) keeps archived memos forever. Memos archived before this feature existed are never auto-deleted.',
		retentionNever: 'Never (keep forever)',
		retentionDays7: 'After 7 days',
		retentionDays30: 'After 30 days',
		retentionDays90: 'After 90 days',
		retentionDays180: 'After 180 days',
		secImport: 'Import',
		flomoGuideName: 'flomo import guide',
		flomoGuideDesc:
			'A complete playbook for an AI assistant: import flomo notes (full API or export file) as native memos notes. Copy it into your assistant chat — a built-in importer will ship in a future version.',
		flomoGuideCopy: 'Copy guide',
		flomoGuideCopied: 'Guide copied to clipboard',
		flomoGuideCopyFail: 'Copy failed',
		storageNote:
			'Storage format: one canvas file per year (Memos/{year}.canvas); each memo is a text node whose id is the timestamp (YYYYMMDDHHmmSSSS). Reference a memo with [[Memos/2026.canvas#2026072601370000]]',
		secDebug: 'Diagnostics',
		debugLogName: 'Debug log',
		debugLogDesc:
			'Fully silent when off — nothing is recorded. When on, the plugin keeps an in-memory log (cleared on restart) you can export and send to the developer to help track down issues. The log is never written to a file automatically and contains no note content.',
		debugExportName: 'Export log',
		debugExportDesc:
			'Copy to paste into a message, or save a txt file at the vault root.',
		debugCount: '{n} entries recorded.',
		debugExportCopy: 'Copy log',
		debugExportFile: 'Save to vault',
		debugClear: 'Clear',
		debugEmpty: 'No log entries yet',
		debugCopied: 'Log copied to clipboard',
		debugSaved: 'Log saved to {path}',
		debugSaveFail: 'Save failed',
		cmdOpenView: 'Open Memos',
		cmdOpenSidebar: 'Open Memos in sidebar',
		cmdOpenWindow: 'Open Memos in new window',
		cmdFocusEditor: 'Focus Memos editor',
		cmdOpenSettings: 'Open Memos settings',
		ribbonOpen: 'Open Memos',
		purgeNotice: 'Auto-deleted {n} expired archived memo(s)',
	},
} as const;

export type StrKey = keyof (typeof STRINGS)['zh'];

let current: Lang = 'zh';

export function setLang(lang: Lang): void {
	current = lang === 'en' ? 'en' : 'zh';
}

export function getLang(): Lang {
	return current;
}

/** Localized string in the active language (falls back to English). */
export function t(key: StrKey): string {
	return STRINGS[current][key] ?? STRINGS.en[key] ?? key;
}

/** Localized string with {placeholder} substitution. */
export function tf(
	key: StrKey,
	vars: Record<string, string | number>,
): string {
	let s = t(key);
	for (const [k, v] of Object.entries(vars)) {
		s = s.split(`{${k}}`).join(String(v));
	}
	return s;
}
