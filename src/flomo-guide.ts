/**
 * Agent playbook for importing flomo data into this plugin's native
 * canvas storage. Copied to the clipboard from the settings tab (a
 * quick-copy entry point until this grows into a built-in importer).
 * Distilled from a real full migration (thino files + flomo API).
 * NOTE: keep docs/flomo-import-guide.md in sync when editing.
 */
export const FLOMO_IMPORT_GUIDE = `# flomo → Memos 原生笔记导入指南

给 AI 助手：本文档完整描述如何把用户的 flomo（浮墨笔记）数据导入本 Obsidian 插件（unmemos）的原生存储。先读目标格式，再选数据源，最后按流程执行。

## 1. 目标格式（Memos 原生存储）

- 存储路径：读 \`.obsidian/plugins/unmemos/data.json\` 的 \`storagePath\`（默认 \`Memos/{year}.canvas\`，用户可能自定义过，如 \`4-配置文件/Memos/{year}.canvas\`）。不要假设默认路径。
- 每年一个 Obsidian Canvas JSON 文件 \`<目录>/<year>.canvas\`，顶层 \`{"nodes":[...],"edges":[]}\`；写入务必与已有文件合并，不得覆盖。
- 每条笔记 = 一个 text 节点，字段：
  - \`id\`：16 位数字时间戳 = \`YYYYMMDDHHmm\` + 4 位同分钟序号（从 0000 起，避开该 canvas 已有 id）
  - \`type\`：\`"text"\`，\`width\`：360
  - \`text\`：\`<正文>\\n<!-- memos-meta | updated: YYYY-MM-DD HH:mm:ss -->\`；meta 行必须是最后一行；正文里的 \`#标签\` 插件会自动提取
  - \`height\`：估算 \`max(200, 行数*26+72)\`，每内嵌一张图 +300（用户编辑时插件会重测真实高度并重排，估算可粗糙）
- 布局：全部 memo 节点按 id 升序（时间顺序），排进 \`ceil(sqrt(n))\` 列，列宽 420（360+60），行间距 40，逐个放入当前最矮的列；非 memo 节点（用户自己的卡片）不得移动。
- 图片：复制到 vault 附件目录（读 \`.obsidian/app.json\` 的 \`attachmentFolderPath\`），正文内用 \`![[附件目录/文件名]]\` 内嵌。
- 笔记间引用：\`[[<存储目录>/<year>.canvas#<16位id>|memo]]\`，与插件 @提及 格式一致，可点击跳转、悬浮预览。

## 2. 数据来源（API 优先）

### A. flomo API（推荐，数据最全）
官方导出文件严重不全（实测不足真实数据的 1%）且不含已删笔记；API 可取回全部（含未强删的软删除内容）。

- 基址：\`https://flomoapp.com/api/v1\`
- 公共参数（所有请求必带）：\`timestamp\`（unix 秒，传毫秒会报“设备时间校验失败”）、\`api_key:"flomo_web"\`、\`app_version:"4.0"\`、\`platform:"web"\`、\`webp:"1"\`
- 签名：全部参数（不含 sign）按 key 字典序排序 → 拼成 \`k1=v1&k2=v2\`（跳过空值、去掉结尾 &）→ 追加 salt \`dbbc3dd73364b4084c3a69346e0ce2b2\` → 取 MD5 hex，作为 \`sign\` 参数一并发送
- 登录：\`POST /user/login_by_email\`，body = 公共参数 + sign + \`email\`（可直接传手机号）+ \`password\`。\`code:0\` 时取 \`data.access_token\`（形如 \`id|token\`）和 \`data.id\`（user_id）
- 后续请求鉴权：请求头 \`Authorization: Bearer <access_token>\`，参数带 \`uid:<user_id>\`
- 取单条：\`GET /memo/<slug>\`。分享链接 \`https://v.flomoapp.com/mine/?memo_id=XXX\` 里的 \`XXX\` 就是 slug（数字 id 的 base64），可直接用它请求
- 全量同步：\`GET /memo/updated/\` + \`{limit, latest_updated_at, latest_slug}\` 游标分页（游标取上一批最后一条的 updated_at 和 slug），循环至返回空数组。**不要传 tz 参数（会 500）**
- memo 对象字段：\`content\`（HTML）、\`created_at\`、\`updated_at\`、\`deleted_at\`（null = 未删除）、\`slug\`、\`files\`（图片）、\`tags\`、\`pin\`

### B. 官方导出 HTML（仅作兜底/核对）
结构：\`<div class="memo">\` 块，含 \`.time\`（\`YYYY-MM-DD HH:mm:ss\`）、\`.content\`（\`<p>\`/\`<ol>\`/\`<li>\`）、\`.files\`（\`<img src="file/...">\`，图片在 file/ 子目录）。注意：没有 memo_id、不含已删笔记、数量严重偏少——不要用它得出“笔记已被删除”之类结论。

## 3. 内容转换

- HTML → 文本：\`</p><p>\` → 换行，\`<ol>/<ul>\` 起始标签 → 换行，\`</li><li>\` → 换行，\`<br>\` → 换行，剥离其余标签，解码实体（\`&amp; &lt; &gt; &nbsp; &quot; &#39;\`），修剪两端空行，3 个以上连续换行压成 2 个
- \`#标签\` 原样保留（插件自动识别）
- 规范化比较函数（去重/匹配用）：去掉 \`**\`/\`__\`、去掉 \`#标签\`、去掉 URL、去掉行首列表序号 \`^\\d+[.)、]\\s*\`、压缩空白

## 4. 标准流程

1. 读 storagePath 确认目标 canvas；永远与已有文件合并（保留既有节点，新 id 避让）
2. 每条笔记按 \`created_at\` 生成 id（分钟 + 序号），按年份写入对应 canvas
3. \`files\` 里的图片：下载到附件目录（flomo CDN 一般可直接下载），正文末尾追加 \`![[...]]\` 内嵌
4. 正文中的 flomo 引用链接（\`mine/?memo_id=XXX\`）：按 slug 取回被引笔记——
   - 其内容与某条已导入笔记匹配（同分钟 + 规范化相似；或全局规范化相似兜底）→ 替换为 \`[[<canvas>#<id>|memo]]\`
   - 无对应笔记 → 先把被引笔记作为新 memo 导入，再链接
   - 自引用（被引内容与笔记自身相同，flomo 时期的“关联自”拷贝习惯）→ 删除该链接，悬空的“关联自：”一并删掉
   - 服务器返回“没有找到 memo” → 保留原链接
5. 写完后整体重排布局（memo 节点 id 升序、最矮列优先）；插件有 vault 文件监听会自动刷新，用户也可 Cmd+R
6. API 请求间隔 ≥150ms，避免限流

## 5. 安全与坑

- 不要把账号密码写入任何文件或代码仓库；临时凭据用后即毁
- timestamp 毫秒报“设备时间校验失败”；\`/memo/updated/\` 传 tz 会 500
- API 路径与 URL 参数一律用 slug（base64），不是数字 id
- 官方导出 ≠ 全量（实测：导出 670 条，账号 72000+ 条）
- 写入前先备份现有 canvas 文件
`;
