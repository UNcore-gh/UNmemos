# UNmemos

**Catch a passing thought in Obsidian and find it again in a searchable timeline.** UNmemos is a Memos-inspired flash-note plugin for people who want their quick notes to stay in their vault as ordinary Obsidian Canvas files.

给 Obsidian 用户一个随手记下闪念的地方：写下内容后，它会出现在可搜索的时间线上，并以 Canvas 文件保存在自己的 Vault 里。

> Part of the UN series: **UNmemos** 记 · **UNreader** 读 · **UNagent** 用。

![UNmemos workflow illustration: capture a tagged thought, find it again by text, tag, or date, then manually link related notes in local Canvas files / UNmemos 工作流程示意：随手记录一条带标签的念头，之后用标签、全文或日期找回，再手动用 @ 引用关联到本地 Canvas 文件](assets/readme/capture-revisit-organize.svg)

*Capture a thought, find it later by text, tag, or date, and manually connect related notes with @ references. / 记下想法，按全文、标签或日期找回，再用 @ 引用手动关联。 Card text is synthetic; this is not an app screenshot. / 卡片内容为合成示例，并非插件界面截图。*

## What you can do

- Capture short notes and drafts, then browse them by day or activity.
- Find notes with full-text, tag, and date filters; pin, star, or archive useful ones.
- Write `#tags` and use `@` references to connect notes across Obsidian editors.
- Save notes to `UNmemos/{year}.canvas` by default; change the storage path in Settings and open the files directly in Obsidian Canvas.
- Use the Chinese or English interface, with layouts for desktop and narrow screens.

The Settings page includes a guide for asking an AI assistant to move flomo notes into UNmemos. It is a migration guide, not an automatic in-plugin importer.

### Interface examples / 界面示例

![UNmemos desktop timeline / UNmemos 桌面端时间线](assets/readme/feed-desktop.jpg)

*Earlier desktop interface / 较早的桌面界面。 Names and layout may differ from the current release. / 名称和布局可能与当前版本不同。*

<p><img src="assets/readme/mobile-capture.jpg" width="220" alt="UNmemos phone-sized capture screen / UNmemos 手机窄屏快速记录界面"></p>

*Earlier phone-sized interface / 较早的手机窄屏界面。 This existing screenshot is not a current-device compatibility test. / 此图是已有截图，不代表本次完成了真机兼容性测试。*

## Get started

1. In Obsidian, open **Settings → Community plugins → Browse**, search for **UNmemos**, then install and enable it.
2. Open the command palette with `Cmd/Ctrl+P`, search for **Open feed in new tab** (English) or **新标签页打开卡片流** (Chinese).
3. Type a note in the top input box. Press `Enter` for a new line; press `Cmd/Ctrl+Enter` or the send button to save it.

If you prefer Enter-to-send, enable it in **Settings → UNmemos**; then use `Shift+Enter` for a new line.

You can also find **Quick capture / 快速记录** in the command palette. To use a keyboard shortcut, open **Settings → Hotkeys**, search for the command, and choose a key combination. UNmemos does not set a default open-view or quick-capture shortcut.

## Privacy and compatibility

- Notes are stored in Canvas files inside your vault. UNmemos makes no network requests and collects no telemetry.
- Optional diagnostic logs are off by default and stay in memory unless you choose to export them.
- The published manifest requires Obsidian **1.7.2 or later** and declares support for desktop and mobile Obsidian (`isDesktopOnly: false`).

## Latest version and changes

[UNmemos 1.0.6](https://github.com/UNcore-gh/UNmemos/releases/tag/1.0.6) is the latest release. The desktop composer now sits directly below the native view header, removing extra top spacing from both the content container and feed. Phone and tablet layout rules are unchanged. Star and pin actions read the latest Canvas content before changing a flag, keeping repeated taps independent and preventing old cards from overwriting newer text. Card menus now use a clean text-only style, and resize handles are easier to see. Version 1.0.3 added safer Canvas writes and migration checks, an optional Enter-to-send setting, and collision-safe temporary editor files. Cursor spacing, theme contrast, and brief file-tree visibility reports still need reproduction in the affected Obsidian themes and devices; they are not claimed as fully resolved here.

See the [release history](https://github.com/UNcore-gh/UNmemos/releases) for the published changes and update files. Local work that has not been released is not listed here.

## License

[Source Available License](LICENSE) — commercial use requires a separate license.

---

# 中文说明

**在 Obsidian 里随手记下闪念，再从可搜索的时间线里找回来。** UNmemos 是一款受 Memos 启发的速记插件，适合希望把临时想法直接保存在自己 Vault 中的 Obsidian 用户。记录以普通 Canvas 文件保存。

## 可以用它做什么

- 快速记下想法和草稿，之后按日期或活跃度浏览。
- 按全文、标签和日期查找记录，也可以置顶、星标或归档。
- 在正文中写 `#标签`，并用 `@` 在 Obsidian 编辑器之间关联记录。
- 记录默认保存在 `UNmemos/{年份}.canvas`；可以在设置中更改路径，也能直接用 Obsidian 白板打开。
- 使用中文或英文界面；桌面和窄屏都有相应布局。

设置页提供一份迁移指南，可交给 AI 助手协助迁移 flomo 笔记。它不是插件内置的自动导入器。

## 开始使用

1. 在 Obsidian 打开 **设置 → 社区插件 → 浏览**，搜索 **UNmemos**，安装并启用。
2. 按 `Cmd/Ctrl+P` 打开命令面板，搜索 **新标签页打开卡片流**（中文界面）或 **Open feed in new tab**（英文界面）。
3. 在顶部输入框写下内容。按 `Enter` 换行；按 `Cmd/Ctrl+Enter` 或点击发送按钮保存。

如果更习惯按回车发送，可以在 **设置 → UNmemos** 中开启；开启后按 `Shift+Enter` 换行。

也可以在命令面板搜索 **快速记录 / Quick capture**。如果想用键盘快捷键，打开 **设置 → 快捷键**，搜索对应命令并自行绑定。UNmemos 不预设打开卡片流或快速记录的快捷键。

## 隐私与兼容性

- 记录保存在 Vault 内的 Canvas 文件中。UNmemos 不发起网络请求，也不收集遥测数据。
- 可选诊断日志默认关闭；只有你主动导出时才会离开内存。
- 当前公开版的清单要求 Obsidian **1.7.2 或更新版本**，并声明支持 Obsidian 桌面端和移动端（`isDesktopOnly: false`）。

## 最新版本与更新说明

[UNmemos 1.0.6](https://github.com/UNcore-gh/UNmemos/releases/tag/1.0.6) 是目前最新版本。桌面输入框现在紧接原生页首，去掉外层内容区和信息流顶部的额外间距。手机和平板的布局规则保持原样。星标和置顶会先读取 Canvas 最新内容再切换标记，连续操作时两个标记保持独立，旧卡片也不会覆盖新正文。卡片菜单改为纯文字样式，缩放手柄也更容易发现。1.0.3 加强了 Canvas 写入与迁移防覆盖保护，增加可选的 Enter 发送，并避免临时编辑文件与已有文件重名。光标位置、主题文字对比度和文件树短暂显示仍需在反馈对应的 Obsidian 主题和设备中复现，本说明不宣称这些问题已全部解决。

已发布的变更和更新文件见 [GitHub Releases 更新记录](https://github.com/UNcore-gh/UNmemos/releases)。尚未发布的本地改动不列在这里。

## 许可证

[Source Available License](LICENSE) —— 商业使用需另行授权。
