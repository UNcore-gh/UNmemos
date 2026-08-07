# unmemos 插件联动文档（Integration Guide）

> 面向**其他插件 / AI 生成的插件**的互操作规范。
> 读完本文档，你的插件应该能：读取全部 memo、安全写入新 memo、修改/删除节点、生成可被 unmemos 识别的引用链接。
>
> 最后同步：2026-08-01 · 对应插件版本 0.2.0（plugin id: `unmemos`）

---

## 0. 基本事实

| 项目 | 值 |
|---|---|
| 插件 id | `unmemos` |
| 插件目录 | `<vault>/.obsidian/plugins/unmemos/` |
| 配置文件 | `<vault>/.obsidian/plugins/unmemos/data.json` |
| 存储载体 | **Obsidian Canvas 文件**（`.canvas`，标准 JSON），不是 markdown |
| 对外 JS API | **无**。unmemos 不导出任何全局对象 / 事件总线 |
| 联动方式 | **只通过 Vault 文件**：读写 `.canvas` 文件即可，unmemos 会自动感知 |

unmemos 没有插件间 API。联动的全部契约就是**磁盘上的 canvas 文件格式**——你写得对，unmemos 就能读；你改了文件，unmemos 就会自动刷新（见 §6）。

---

## 1. 存储定位：memo 存在哪个文件

存储路径由 `data.json` 的 `storagePath` 决定：

```jsonc
// .obsidian/plugins/unmemos/data.json（节选）
{
  "storagePath": "Memos/{year}.canvas",
  ...
}
```

两种形态：

1. **`{year}` 模板**（默认，推荐理解为此）：每年一个 canvas 文件。
   把 `{year}` 替换为四位年份 → `Memos/2026.canvas`、`Memos/2025.canvas`……
   匹配规则：`^{目录}/\d{4}\.canvas$`。例如 `storagePath: "4-配置文件/Memos/{year}.canvas"`
   对应 `4-配置文件/Memos/2026.canvas`。
2. **固定路径**（不含 `{year}`）：所有 memo 都在该单一文件里。

**发现算法**（你的插件应照此实现，不要硬编码路径）：

```ts
function findMemosFiles(app: App): TFile[] {
  const data = JSON.parse(
    // 注意：adapter.read 是异步的，此处为示意
    app.vault.adapter.readSync?.('.obsidian/plugins/unmemos/data.json') ?? '{}',
  );
  const tpl: string = data.storagePath ?? 'Memos/{year}.canvas';
  if (tpl.includes('{year}')) {
    const dir = tpl.substring(0, tpl.lastIndexOf('/'));
    const re = new RegExp('^' + escapeRegExp(dir) + '/\\d{4}\\.canvas$');
    return app.vault.getFiles().filter((f) => re.test(f.path));
  }
  const f = app.vault.getAbstractFileByPath(tpl);
  return f instanceof TFile ? [f] : [];
}
```

> 新 memo 写入「当前年份」对应的文件：`storagePath.replace('{year}', 当前YYYY)`。
> 文件不存在时先创建，内容为 `{"nodes":[],"edges":[]}`（目录不存在先建目录）。

---

## 2. 节点格式：一条 memo = 一个 canvas text 节点

canvas 文件是标准 Obsidian Canvas JSON。unmemos 使用其中的 `nodes` 数组：

```jsonc
{
  "nodes": [
    {
      "id": "2026072601370000",          // ★ 16 位时间戳 id（见 §2.1）
      "type": "text",                    // ★ 必须为 "text"
      "x": 0, "y": 0,                    // 布局坐标（见 §3）
      "width": 360,                      // ★ 固定 360
      "height": 232,                     // 测量高度，最小 200
      "text": "今天学了 canvas 存储\n<!-- memos-meta | updated: 2026-07-26 01:37:00 -->"
    }
    // ... 用户自己的卡片、group、file 节点也可能混在同一个 canvas 里
  ],
  "edges": [ /* unmemos 不创建边；删除节点时会顺带清理关联边 */ ]
  // 其他顶层键（如 Obsidian 写的 "metadata"）会被原样保留，你也必须保留
}
```

**识别规则（重要）**：unmemos 只把同时满足以下条件的节点当作 memo：

- `type === "text"`
- `id` 匹配 `/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{4})$/`（16 位纯数字时间戳）

其余节点（用户手画的卡片、图片 file 节点、group）一律**不解析、不移动、不删除**。你的插件同样应当只操作 16 位 id 的 text 节点。

### 2.1 id 规则

```
id = YYYYMMDDHHmm + 4 位分钟内序号
例：2026072601370000 = 2026-07-26 01:37 + 序号 0000
```

- 同一分钟内第 n 条 → 序号 `0000`、`0001`…… 递增到首个未占用值。
- 生成时必须**避开当前 canvas 已占用的 id**（扫描现有 nodes 的 id 集合）。
- id 的字典序 = 时间序，unmemos 依此排序/分组/画热力图，**不要生成乱序 id**。
- 非 16 位 id 的节点永远不会被当作 memo——如果你想放自己的辅助节点，用别的 id 格式即可天然隔离。

### 2.2 text 字段：内容 + 元信息行

```
<正文（任意 markdown）>
<!-- memos-meta | updated: YYYY-MM-DD HH:mm:ss [| pinned] [| starred] [| archived] [| archivedAt: ISO8601] -->
```

规则：

1. **元信息行是 text 的最后一行**，格式 `<!-- memos-meta | ... -->`，以 ` | ` 分隔 token。
   解析器从 text 末尾向前扫描找这行（`/^<!--\s*memos-meta\b.*-->\s*$/`），正文在它之前。
2. token 列表（顺序如列出）：
   - `updated: YYYY-MM-DD HH:mm:ss` —— 必有，最后修改时间。
   - `pinned` —— 可选，置顶。
   - `starred` —— 可选，星标（侧栏「星标」视图收集用，与置顶独立）。
   - `archived` —— 可选，归档。
   - `archivedAt: <ISO 时间戳>` —— 仅在 archived 时出现；驱动「归档 N 天后自动删除」。**没有此字段的归档 memo 永远不会被自动删除**（安全设计）。
3. **空 memo**（例如 `@@` 快捷新建）：正文为空，但**必须有元信息行**，否则节点会被当作空节点忽略：

   ```jsonc
   { "id": "2026080112000000", "type": "text", "width": 360, "height": 200,
     "text": "\n<!-- memos-meta | updated: 2026-08-01 12:00:00 -->" }
   ```

4. 正文里支持完整 markdown：`#标签`、`[[双链]]`、`![[图片嵌入]]`、代码块……
   - 标签提取会跳过代码块 / 行内代码 / wikilink 内部，纯数字不算标签。
   - 图片附件用 `![[attachments/xxx.png]]`；unmemos 删除 memo 时会清理「只被该 memo 引用」的附件（走回收站）。被其他文件共用的附件受保护。

---

## 3. 布局（可选遵循）

unmemos 按「近方形网格」排布 memo 卡片：

- 卡片宽 `width: 360`；高度按渲染测量（最小 200）。
- 列数 = `ceil(sqrt(N))`；列距 60（列宽 420），行距 40。
- 时间序（id 升序 = 旧→新）依次放入当前最短列，起点 (0,0)。
- **插入**新节点不动已有节点（填空洞或接最短列尾）；**删除 / 内容变更**后会全量重排所有 memo 节点——但**永远不动非 memo 节点**。

你只是追加数据的话，随便放个不重叠的坐标即可，用户下次在 Memos 界面删改任何 memo 时会被自动理顺。想做得漂亮就按上面算法计算 x/y。

---

## 4. 引用格式与 @ 约定

### 4.1 引用一条 memo（跨笔记 / 跨插件通用）

```
[[<canvas 文件路径>#<16位id>|显示名]]
```

例：`[[Memos/2026.canvas#2026072601370000|那天记的东西]]`（路径可省略 `.canvas` 扩展名，Obsidian 惯例）。

判定标准：wikilink 片段（`#` 之后）匹配 16 位数字 → 被 unmemos 识别为 **memo 引用**，用于：

- 引用计数 / 反链展示；
- 卡片内 hover 预览（走核心「页面预览」）；
- 光标在引用上按 Shift+Enter 跳进被引用 memo 的编辑器。

### 4.2 `@` / `@@` 输入约定（全局，`globalMention` 开启时）

unmemos 在**所有编辑器**（普通笔记源码/实时预览、白板文本节点）拦截：

- 输入 `@关键词` → 弹出候选 memo 列表，回车插入 §4.1 的引用；
- 输入 `@@名字` + 回车 → 新建一条**空白 memo** 并插入引用（显示名即「名字」，卡片正文为空）。

其他插件**无需实现**这套语法；但如果你的插件生成包含 `@`/`@@` 的文本交给用户编辑，要知悉它会被 unmemos 接管（用户可在 unmemos 设置里关闭「在所有编辑器中启用 @ 引用」，键 `globalMention`）。

---

## 5. 代码样例

### 5.1 读取全部 memo

```ts
import { App, TFile } from 'obsidian';

interface LiteMemo {
  id: string;
  content: string;
  updatedAt: string;
  sourceFile: string; // canvas 的 vault 路径
  pinned: boolean;
  starred: boolean;
  archived: boolean;
}

const MEMO_ID_RE = /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{4}$/;
const META_RE = /^<!--\s*memos-meta\b.*-->\s*$/;

/** 拆分 text = 正文 + 末尾元信息行（元信息行必须最后一行，从尾部扫）。 */
function splitNodeText(text: string): { content: string; metaLine: string } {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (META_RE.test(lines[i])) {
      return { content: lines.slice(0, i).join('\n').replace(/\s+$/, ''), metaLine: lines[i] };
    }
  }
  return { content: text.replace(/\s+$/, ''), metaLine: '' };
}

export async function readAllMemos(app: App, files: TFile[]): Promise<LiteMemo[]> {
  const out: LiteMemo[] = [];
  for (const file of files) {
    let data: { nodes?: unknown[] };
    try {
      data = JSON.parse(await app.vault.read(file));
    } catch {
      continue;
    }
    for (const node of data.nodes ?? []) {
      const n = node as Record<string, unknown>;
      if (n.type !== 'text' || typeof n.id !== 'string' || !MEMO_ID_RE.test(n.id)) continue;
      const { content, metaLine } = splitNodeText(typeof n.text === 'string' ? n.text : '');
      // 空正文 + 无元信息行 → 非 memo 的空节点，跳过
      if (!content.trim() && !metaLine) continue;
      out.push({
        id: n.id,
        content,
        updatedAt: metaLine.match(/updated:\s*([^|]+)/)?.[1]?.trim() ?? '',
        sourceFile: file.path,
        pinned: metaLine.includes('pinned'),
        starred: metaLine.includes('starred'),
        archived: /(^|\|)\s*archived\b/.test(metaLine),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
```

### 5.2 写入一条新 memo

```ts
import { App, TFile, normalizePath } from 'obsidian';

/** YYYYMMDDHHmm + 4 位序号，避开已占用 id。 */
function allocateId(existing: Set<string>): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const base =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}`;
  for (let i = 0; i < 10000; i++) {
    const id = base + String(i).padStart(4, '0');
    if (!existing.has(id)) return id;
  }
  throw new Error('id space exhausted for this minute');
}

function buildNodeText(content: string, updatedAt: string, flags?: {
  pinned?: boolean; starred?: boolean; archived?: boolean;
}): string {
  const tokens = [`updated: ${updatedAt}`];
  if (flags?.pinned) tokens.push('pinned');
  if (flags?.starred) tokens.push('starred');
  if (flags?.archived) tokens.push('archived');
  return `${content.replace(/\s+$/, '')}\n<!-- memos-meta | ${tokens.join(' | ')} -->`;
}

/** 往「当前年份」的存储文件追加一条 memo。storagePath 见 §1。 */
export async function appendMemo(app: App, storagePath: string, content: string): Promise<string> {
  const year = String(new Date().getFullYear());
  const path = normalizePath(storagePath.replace(/\{year\}/g, year));

  // 确保文件存在（连同父目录）
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) await app.vault.createFolder(path.substring(0, slash)).catch(() => null);
    file = await app.vault.create(path, '{"nodes":[],"edges":[]}');
  }

  // 读-改-写：保留所有现有键（含 edges、Obsidian 的 metadata 等顶层字段）
  const data = JSON.parse(await app.vault.read(file)) as {
    nodes?: Record<string, unknown>[];
    [k: string]: unknown;
  };
  if (!Array.isArray(data.nodes)) data.nodes = [];

  const existing = new Set(
    data.nodes.map((n) => (typeof n.id === 'string' ? n.id : '')).filter(Boolean),
  );
  const id = allocateId(existing);
  const p = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const updatedAt =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;

  data.nodes.push({
    id,
    type: 'text',
    x: 0, // 粗略放原点附近亦可；unmemos 下次重排会理顺（见 §3）
    y: 0,
    width: 360,
    height: 200,
    text: buildNodeText(content, updatedAt),
  });

  await app.vault.modify(file, JSON.stringify(data));
  return id; // 可用于构造引用 [[path#id|显示名]]
}
```

### 5.3 修改 / 删除

- **改正文**：找到 `id` 对应节点，重写 `text`（元信息行保持在最后一行、刷新 `updated:`，保留原有 pinned/starred/archived 标记），`JSON.stringify` 整对象写回。
- **删节点**：从 `nodes` 移除该节点，并同步移除 `edges` 里 `fromNode`/`toNode` 指向它的边。
- 两种操作都必须**保留 canvas 顶层其他键**（round-trip 整个 JSON 对象）。

---

## 6. 变更感知：你写了文件之后会发生什么

unmemos 监听 vault 事件并自动重载，**无需任何通知机制**：

| 事件 | 行为 |
|---|---|
| `.canvas` modify（命中存储路径） | 300ms 防抖后重新解析全部存储文件，刷新界面 |
| `.canvas` create / delete / rename | 立即重载 |

注意事项：

1. **防抖窗口 300ms**：批量写入时合并成一次 `vault.modify`，或至少间隔 >300ms，避免中途态被读走。
2. **没有写锁**：unmemos 与你的插件理论上可能同时读-改-写同一文件。保持「读→改→写」紧凑、单次操作原子化即可，实际上冲突概率极低（用户手动操作驱动）。
3. 你自己的写入**不会**被 unmemos 的 writeGuard 过滤（那是它识别自身写入用的），会被正常拾取——这正是期望行为。
4. 解析失败（JSON 坏掉）时 unmemos 只 `console.error` 并视该文件为空——**务必保证写出的 JSON 合法**。

---

## 7. 可触发的命令

不开放 JS API，但可以通过 Obsidian 命令系统间接驱动（供你的插件或用户快捷键使用）：

```ts
app.commands.executeCommandById('unmemos:open-memos-view');      // 新标签页打开
app.commands.executeCommandById('unmemos:open-memos-in-sidebar'); // 停靠右侧栏
app.commands.executeCommandById('unmemos:open-memos-in-window');  // 独立窗口
app.commands.executeCommandById('unmemos:focus-memos-editor');    // 聚焦输入框
app.commands.executeCommandById('unmemos:open-memos-settings');   // 打开设置页
```

---

## 8. data.json 关键配置（供读取）

```jsonc
{
  "storagePath": "Memos/{year}.canvas",  // §1 存储定位
  "language": "zh",                      // "zh" | "en"
  "accentColor": "#07c160",
  "defaultTag": "",                      // 界面新建 memo 时不自动加标签（仅 UI 用）
  "globalMention": true,                 // 全编辑器 @/@@ 总开关
  "archiveRetentionDays": 0,             // 0=归档永不自动删除；>0 → 归档且带
                                         // archivedAt 的 memo 到期自动删（每小时检查）
  "showHeatmap": true,
  "showTags": true
  // 其余键为 UI 状态，联动无关
}
```

---

## 9. Do / Don't 清单

**Do**

- ✅ 节点 id 用 16 位时间戳格式，生成前避让已占用 id。
- ✅ 元信息行永远放在 `text` 最后一行；改内容时刷新 `updated:`、保留旗标。
- ✅ 读-改-写时 round-trip 整个 canvas JSON（保住 edges、metadata 等）。
- ✅ 空 memo 也写元信息行（否则会被当空节点丢弃）。
- ✅ 写完就走——unmemos 会自动重载。

**Don't**

- ❌ 不要移动 / 删除 / 改尺寸**非** 16 位 id 的节点（那是用户自己的白板内容）。
- ❌ 不要把元信息行写在正文中间，或在正文里伪造 `<!-- memos-meta ... -->`。
- ❌ 不要生成非法 JSON 或省略 `nodes` 数组。
- ❌ 不要依赖任何运行时全局对象——没有 API，只有文件契约。
- ❌ 不要在 300ms 内连续多次 modify 同一文件（合并写入）。

---

## 10. 版本与兼容

- 当前存储为 **canvas 格式**（由早期 markdown 格式一次性迁移而来，迁移标记 `migratedToCanvas`）。新插件只需支持 canvas 格式。
- 旧版遗留解析（markdown 标题块 / callout）仅供 unmemos 自身迁移用，第三方无需实现。
- 若未来格式变更，本文档与 `src/parser.ts` / `src/writer.ts` 会同步更新；以这两个文件为准。
