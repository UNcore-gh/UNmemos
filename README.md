# UNmemos

A faithful [Memos](https://github.com/usememos/memos)-inspired flash-capture plugin for Obsidian. Type a thought, hit send, and it lands on a beautiful timeline — everything stored locally as native Obsidian Canvas files.

> Part of the **UN series** by UNcore.

![UNmemos Screenshot](images/screenshot.png)

## Features

- **Flash capture** — a composer at the top of the view; `Cmd/Ctrl+Shift+M` opens the view, `Cmd/Ctrl+Shift+N` focuses the composer. Drafts are auto-preserved.
- **Timeline** — memos grouped by day in chronological order, with an activity heatmap.
- **Tags** — `#tags` in memo text are extracted automatically; tag tree in the sidebar with pinning and drag-to-reorder.
- **Star & archive** — star important memos; archived memos can be auto-deleted after a configurable retention period (off by default).
- **Filters** — full-text / tag / date filtering with flomo-style saved filter shortcuts.
- **Mentions** — type `@` in *any* editor (notes, live preview, canvas text nodes) to link to a memo; `@@name` quick-creates one. References get hover preview and backlink counting.
- **Inline editing** — click a card to edit it in place; full Markdown support (`#tags`, `[[wikilinks]]`, `![[embeds]]`, code blocks…).
- **Canvas-native storage** — memos live in `.canvas` files (default `Memos/{year}.canvas`), so they are first-class Obsidian citizens: open the canvas, drag cards around, everything stays in sync.
- **flomo import** — a built-in guide (Settings → copy import guide) walks an AI assistant through migrating your flomo data.
- **Bilingual & themeable** — 中文 / English UI; custom accent color; full mobile support.

## Privacy

UNmemos is fully offline. It makes **no network requests**, collects **no telemetry**, and only reads/writes the canvas files configured in its settings. The optional debug log is strictly opt-in and stays in memory until you export it yourself.

## Installation

### Community plugins (recommended)

Search for **UNmemos** in Obsidian → **Settings → Community plugins → Browse**.

### Manual

Copy `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases) into `<vault>/.obsidian/plugins/unmemos/`, then enable the plugin.

## Documentation

- [`docs/flomo-import-guide.md`](docs/flomo-import-guide.md) — migrate your flomo notes into UNmemos storage.
- [`docs/plugin-integration.md`](docs/plugin-integration.md) — interop spec for other plugins that want to read/write UNmemos data.

## Development

```bash
npm install
npm run dev     # esbuild watch mode
npm run build   # tsc typecheck + production bundle
npm run lint    # ESLint (obsidianmd rules)
```

Build outputs (`main.js`, `styles.css`) land at the plugin root; copy them into your vault's plugin folder and reload Obsidian to test.

## License

[0BSD](LICENSE)

---

# 中文说明

**UNmemos** 是一款受 Memos / flomo 启发的闪念速记插件。随手记下一条想法，它就出现在按天分组的时间线上——所有数据都以 Obsidian 原生 Canvas 文件保存在本地。

## 功能一览

- **闪念速记**：顶部输入框随手记；`Cmd/Ctrl+Shift+M` 打开视图，`Cmd/Ctrl+Shift+N` 聚焦输入框；未发送的草稿自动保留。
- **时间线**：按天分组的卡片流 + 活跃度热力图。
- **标签**：正文中的 `#标签` 自动提取；侧边栏标签树，支持置顶、拖拽排序。
- **星标与归档**：重要内容加星标；归档内容可设置保留天数后自动清理（默认不清理）。
- **过滤器**：全文 / 标签 / 日期过滤，支持 flomo 风格的已保存过滤快捷方式。
- **@ 提及**：在**任意编辑器**（笔记源码 / 实时预览 / 白板文本节点）输入 `@` 引用已有 memo，`@@名字` 快速新建；引用支持悬浮预览与反链计数。
- **卡片内联编辑**：点击卡片即可修改，支持完整 Markdown。
- **Canvas 原生存储**：memo 默认存放在 `Memos/{年份}.canvas`，可以直接用白板打开、拖拽，双向同步。
- **flomo 导入**：设置页内置导入指南，配合 AI 助手一键迁移浮墨笔记数据。
- **双语与主题**：中文 / English 界面；自定义主题色；完整适配移动端。

## 隐私

UNmemos 完全离线运行：**不联网、不收集任何遥测数据**，只读写你自己配置的 canvas 文件。可选的调试日志默认关闭，且仅保存在内存中，由你主动导出。

## 开发

```bash
npm install
npm run dev     # esbuild 监听模式
npm run build   # tsc 类型检查 + 生产构建
npm run lint    # ESLint（obsidianmd 规则）
```
