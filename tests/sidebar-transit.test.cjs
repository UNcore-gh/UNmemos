"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
let dependencies = require;
try { require.resolve("@codemirror/state"); }
catch { dependencies = createRequire(path.resolve(__dirname, "../../note-transit/package.json")); }
class TFile {
  constructor(path) { this.path = path; this.extension = path.split(".").pop(); }
}
class MarkdownView {}
const obsidian = {
  TFile, MarkdownView, Notice: class {}, editorInfoField: {},
  parseLinktext(target) {
    const at = target.indexOf("#");
    return { path: at < 0 ? target : target.slice(0, at), subpath: at < 0 ? "" : target.slice(at) };
  },
};
const output = { exports: {} };
const entryCode = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const base = class {};
const host = new Proxy({ ...obsidian, Platform: {}, Plugin: base }, { get: (target, key) => target[key] || base });
const context = { module: output, console, crypto: globalThis.crypto, setTimeout, clearTimeout,
  require: name => name === "obsidian" ? host : name === "electron" ? {} : dependencies(name) };
// Expose internals only in the test VM; Obsidian uses the default plugin export.
runInNewContext(entryCode + "\nglobalThis.transitTestAPI = { SidebarTransit, installSidebarTransit };", context);
const { SidebarTransit, installSidebarTransit } = context.transitTestAPI;

function setup(text = "hello world") {
  const source = new TFile("Notes/source.md");
  const canvas = new TFile("UNmemos/2026.canvas");
  const files = new Map([[source, text], [canvas, '{"nodes":[],"edges":[]}']]);
  const cache = { sections: [{ type: "paragraph", position: {
    start: { offset: 0, line: 0, col: 0 }, end: { offset: text.length, line: 0, col: text.length },
  } }], blocks: {}, links: [], embeds: [], headings: [] };
  const editor = {
    getValue: () => text, getLine: line => text.split("\n")[line], listSelections: () => [{}],
    getCursor: side => ({ line: 0, ch: side === "to" ? 5 : 0 }), somethingSelected: () => true,
    posToOffset: pos => text.split("\n").slice(0, pos.line).reduce((n, line) => n + line.length + 1, 0) + pos.ch,
    offsetToPos: offset => { const lines = text.slice(0, offset).split("\n"); return { line: lines.length - 1, ch: lines.at(-1).length }; },
    replaceRange(value, from, to = from) { text = text.slice(0, this.posToOffset(from)) + value + text.slice(this.posToOffset(to)); },
    setCursor() {}, focus() {}, scrollIntoView() {},
    transaction({ changes }) {
      for (const change of [...changes].sort((a, b) => this.posToOffset(b.from) - this.posToOffset(a.from))) {
        this.replaceRange(change.text, change.from);
      }
    },
  };
  const view = Object.assign(new MarkdownView(), { editor, file: source, save: async () => files.set(source, text) });
  const leaf = { view };
  const events = [];
  const plugin = {
    registerDomEvent: (doc, name, callback, capture) => events.push({ doc, name, callback, capture }),
    reloadMemos: async () => {}, openViewInSidebar: async () => {},
    getStorageFiles: () => [canvas],
    app: {
      vault: {
        getAbstractFileByPath: path => [...files.keys()].find(file => file.path === path),
        read: async file => files.get(file),
      },
      workspace: {
        getLeavesOfType: type => type === "markdown" ? [leaf] : [],
        iterateRootLeaves: fn => fn(leaf), getMostRecentLeaf: () => leaf,
      },
      metadataCache: { getFileCache: () => cache,
        getFirstLinkpathDest: path => [...files.keys()].find(file => file.path === path || file.path.replace(/\.md$/, "") === path) },
      fileManager: { generateMarkdownLink: (file, target, subpath, alias) => `[[${file.path}${subpath || ""}${alias ? `|${alias}` : ""}]]` },
    },
  };
  let seq = 0;
  plugin.writer = {
    getPath: () => canvas.path,
    async insertMemoInner(content) {
      const data = JSON.parse(files.get(canvas));
      const id = String(++seq);
      data.nodes.push({ id, type: "text", text: content });
      files.set(canvas, JSON.stringify(data));
      return { id, content, sourceFile: canvas.path };
    },
    readCanvas: async file => ({ data: JSON.parse(files.get(file)), raw: files.get(file) }),
    writeCanvas: async (file, data, raw) => {
      if (files.get(file) !== raw) throw new Error("conflict");
      files.set(file, JSON.stringify(data));
    },
  };
  const parse = (raw, sourceFile) => JSON.parse(raw).nodes.map(node => ({ id: node.id, content: node.text,
    sourceFile, transit: node.unmemosTransit }));
  const transit = new SidebarTransit(plugin, { queue: action => Promise.resolve().then(action), parse, locate: async () => "canvas" });
  const cm = { state: { readOnly: false, field: () => ({ file: source, editor }) }, dispatch() {} };
  transit.editors.set(editor, cm);
  const snapshot = () => transit.snapshot(editor, { file: source });
  const cards = () => parse(files.get(canvas), canvas.path);
  return { transit, plugin, source, canvas, files, cache, editor, view, leaf, cm, events, snapshot, cards };
}

test("move persists provenance before removing the exact selection and saves source", async () => {
  const h = setup("hello world");
  const write = h.plugin.writer.writeCanvas;
  h.plugin.writer.writeCanvas = async (...args) => { assert.equal(h.editor.getValue(), "hello world"); await write(...args); };
  await h.transit.moveSelection(h.snapshot());
  assert.equal(h.editor.getValue(), " world");
  assert.equal(h.files.get(h.source), " world");
  assert.equal(h.cards()[0].content, "hello");
  assert.equal(h.cards()[0].transit.source, h.source.path);
});

test("Canvas/provenance save failures never delete source text", async () => {
  const h = setup();
  h.plugin.writer.writeCanvas = async () => { throw new Error("disk full"); };
  await assert.rejects(h.transit.moveSelection(h.snapshot()), /disk full/);
  assert.equal(h.editor.getValue(), "hello world");
});

test("source changes during card save retain both source edits and saved card", async () => {
  const h = setup();
  const write = h.plugin.writer.writeCanvas;
  h.plugin.writer.writeCanvas = async (...args) => { await write(...args); h.editor.replaceRange("new ", { line: 0, ch: 0 }); };
  await assert.rejects(h.transit.moveSelection(h.snapshot()), /文档已变化/);
  assert.equal(h.editor.getValue(), "new hello world");
  assert.equal(h.cards()[0].content, "hello");
});

test("block reference expands partial selection and persists a native embed", async () => {
  const h = setup();
  await h.transit.referenceBlocks(h.snapshot());
  const card = h.cards()[0];
  assert.equal(card.transit.referenceType, "block");
  assert.match(h.editor.getValue(), /hello world \^um-/);
  assert.equal(card.content, `![[Notes/source.md#^${card.transit.anchors[0].id}]]`);
});

test("existing block IDs are reused without source edits", async () => {
  const h = setup("hello world ^existing");
  h.cache.sections[0].id = "existing";
  await h.transit.referenceBlocks(h.snapshot());
  assert.equal(h.editor.getValue(), "hello world ^existing");
  assert.equal(h.cards()[0].transit.anchors[0].owned, false);
});

test("compound block references use standalone markers", async () => {
  const h = setup("- hello\n- world");
  h.cache.sections[0].type = "list";
  h.cache.sections[0].position.end = { line: 1, col: 7, offset: 15 };
  await h.transit.referenceBlocks(h.snapshot());
  assert.match(h.editor.getValue(), /world\n\n\^um-/);
});

test("heading references leave source unchanged and reject ambiguous headings", async () => {
  const h = setup("# Design\ntext");
  h.cache.headings = [{ heading: "Design", position: { start: { offset: 0 } } }];
  await h.transit.referenceHeading(h.snapshot());
  assert.equal(h.cards()[0].content, "![[Notes/source.md#Design]]");
  assert.equal(h.editor.getValue(), "# Design\ntext");
  h.cache.headings.push(h.cache.headings[0]);
  await assert.rejects(h.transit.referenceHeading(h.snapshot()), /标题重复/);
});

test("move out inserts at offset without replacing selection, saves, then removes only that node", async () => {
  const h = setup("before after");
  const card = await h.transit.createMemo("moved ", { version: 1, mode: "move", source: "old.md", anchors: [] });
  await h.transit.createMemo("keep", { version: 1, mode: "move", source: "old.md", anchors: [] });
  h.view.save = async () => { assert.equal(h.cards().length, 2); h.files.set(h.source, h.editor.getValue()); };
  await h.transit.insertMemo(card, { ...h.snapshot(), from: 7, to: 12 });
  assert.equal(h.editor.getValue(), "before moved after");
  assert.equal(h.cards().length, 1);
  assert.equal(h.cards()[0].content, "keep");
});

test("destination save failure retains the card and inserted text", async () => {
  const h = setup();
  const card = await h.transit.createMemo("moved", { mode: "move" });
  h.view.save = async () => { throw new Error("save failed"); };
  await assert.rejects(h.transit.insertMemo(card, h.snapshot()), /save failed/);
  assert.equal(h.cards().length, 1);
  assert.equal(h.editor.getValue(), "movedhello world");
});

test("card changes during save are preserved", async () => {
  const h = setup();
  const card = await h.transit.createMemo("moved", { mode: "move" });
  h.view.save = async () => {
    h.files.set(h.source, h.editor.getValue());
    const data = JSON.parse(h.files.get(h.canvas)); data.nodes[0].text = "changed";
    h.files.set(h.canvas, JSON.stringify(data));
  };
  await assert.rejects(h.transit.insertMemo(card, h.snapshot()), /卡片已变化/);
  assert.equal(h.cards()[0].content, "changed");
});

test("reference cards and explicit card embeds remain after insertion", async () => {
  const h = setup();
  const card = await h.transit.createMemo("![[Notes/source.md#Design]]", { mode: "reference" });
  await h.transit.insertMemo(card, h.snapshot());
  assert.equal(h.cards().length, 1);
  await h.transit.insertMemo(card, h.snapshot(), true);
  assert.match(h.editor.getValue(), /!\[\[UNmemos\/2026.canvas#1\]\]/);
  assert.equal(h.cards().length, 1);
});

test("read-only and stale editor snapshots cannot move content", async () => {
  const h = setup();
  h.cm.state.readOnly = true;
  await assert.rejects(h.transit.moveSelection(h.snapshot()), /只读/);
  assert.equal(h.cards().length, 0);
});

test("source rename updates persisted provenance and embeds", async () => {
  const h = setup();
  await h.transit.createMemo("![[Notes/source.md#Design]]", { mode: "reference", source: "Notes/source.md", anchors: [] });
  await h.transit.renameSource("Moved", "Notes");
  assert.equal(h.cards()[0].transit.source, "Moved/source.md");
  assert.equal(h.cards()[0].content, "![[Moved/source.md#Design]]");
});

test("native links relocate but code examples and external links remain intact", () => {
  const h = setup();
  const body = '`[[source]]` [[source#Design]] [web](https://example.com)';
  assert.equal(h.transit.rebaseContent(body, "Notes/card.md", "other.md"),
    '`[[source]]` [[source#Design]] [web](https://example.com)');
  assert.equal(h.transit.rebaseContent("![[Notes/source#Design]]", "card.md", "other.md"), "![[Notes/source.md#Design]]");
});

test("selection drag is captured and cancelled drags cannot move source", async () => {
  const h = setup();
  const target = { closest: () => null };
  h.cm.dom = { contains: node => node === target };
  h.transit.registerDocument({});
  const start = h.events.find(event => event.name === "dragstart");
  assert.equal(start.capture, true);
  const values = new Map();
  const dataTransfer = { types: [], setData(type, value) { values.set(type, value); this.types = [...values.keys()]; }, getData: type => values.get(type) };
  start.callback({ target, dataTransfer });
  assert.ok(h.transit.drag);
  h.events.find(event => event.name === "dragend").callback();
  assert.equal(h.transit.drag, null);
});

test("card drop uses coordinates and consumes unsupported drop payloads", async () => {
  const h = setup("before after");
  const card = await h.transit.createMemo("moved ", { mode: "move" });
  const target = { closest: () => null };
  h.cm.dom = { contains: node => node === target };
  h.cm.posAtCoords = coords => { assert.equal(coords.x, 80); return 7; };
  h.transit.registerDocument({});
  let operation;
  h.transit.run = action => operation = action();
  const event = { target, clientX: 80, clientY: 90,
    dataTransfer: { types: ["application/x-unmemos-card"], getData: () => "token" },
    preventDefault() {}, stopImmediatePropagation() {} };
  h.transit.cardDrag = { token: "token", memo: card };
  h.events.find(event => event.name === "drop").callback(event);
  await operation;
  assert.equal(h.editor.getValue(), "before moved after");
  assert.equal(h.cards().length, 0);
  h.transit.cardDrag = { token: "token", memo: card };
  let consumed = false;
  h.events.find(event => event.name === "drop").callback({ ...event, target: {}, preventDefault() { consumed = true; } });
  assert.equal(consumed, true);
});

test("feed and card renderer hooks preserve original rendering", async () => {
  let rendered = 0;
  class Plugin { async onload() {} }
  class Feed { async onOpen() {} }
  class Renderer { async renderCard() { rendered++; } }
  installSidebarTransit(Plugin, Feed, Renderer, {});
  const renderer = new Renderer(); renderer.app = {};
  await renderer.renderCard({ id: "x" }, { children: [] });
  assert.equal(rendered, 1);
});

test("plugin entry loads and Canvas parser retains transit across restart and edits", () => {
  const module = { exports: {} };
  const base = class {};
  const mock = new Proxy({ ...obsidian, Platform: {}, Plugin: base }, { get: (target, key) => target[key] || base });
  const ctx = { ...context, module, exports: module.exports,
    require: name => name === "obsidian" ? mock : name === "electron" ? {} : dependencies(name) };
  runInNewContext(entryCode + "\nglobalThis.parseCanvas = It;", ctx);
  assert.equal(typeof module.exports.default, "function");
  const raw = JSON.stringify({ nodes: [{ id: "2026110512000000", type: "text", text: "hello", unmemosTransit: { version: 1, mode: "move", source: "Notes/source.md" } }] });
  const memos = ctx.parseCanvas(raw, "UNmemos/2026.canvas");
  assert.equal(memos.length, 1);
  assert.equal(memos[0].transit.source, "Notes/source.md");
});

test("real Canvas writer keeps provenance on edit and preserves moved trailing whitespace", async () => {
  const h = setup("hello  \n\nworld");
  class Component { load() {} unload() {} }
  const base = class {};
  const mock = new Proxy({ ...obsidian, Platform: {}, Plugin: base, Component,
    MarkdownRenderer: { render: async () => {} }, normalizePath: value => value },
  { get: (target, key) => target[key] || base });
  const module = { exports: {} };
  const ctx = { ...context, module, exports: module.exports,
    window: { moment: () => ({ format: format => ({ YYYY: "2026", MM: "11", "YYYY-MM-DD": "2026-11-05",
      YYYYMMDDHHmm: "202611051200", "YYYY-MM-DD HH:mm:ss": "2026-11-05 12:00:00" })[format] }) },
    document: { body: { createDiv: () => ({ scrollHeight: 120, remove() {} }) } },
    require: name => name === "obsidian" ? mock : name === "electron" ? {} : dependencies(name) };
  runInNewContext(entryCode + "\nglobalThis.transitAPI = { Writer: si, parse: It, queue: Z };", ctx);
  h.plugin.app.vault.process = async (file, fn) => h.files.set(file, fn(h.files.get(file)));
  const writer = new ctx.transitAPI.Writer(h.plugin.app, {}, { recordWrite() {} }, { get: () => ({ memos: [] }) });
  writer.acquireInsertTarget = async () => ({ file: h.canvas, data: JSON.parse(h.files.get(h.canvas)),
    raw: h.files.get(h.canvas), existingIds: new Set() });
  h.plugin.writer = writer;
  h.transit.api = ctx.transitAPI;
  const card = await h.transit.createMemo("hello  \n\n", { version: 1, mode: "move", source: h.source.path, anchors: [] });
  assert.equal(card.content, "hello");
  assert.equal(card.transit.originalContent, "hello  \n\n");
  await h.transit.insertMemo(card, { ...h.snapshot(), from: 0, to: 0 });
  assert.equal(h.editor.getValue(), "hello  \n\nhello  \n\nworld");
  const next = await h.transit.createMemo("old", { version: 1, mode: "move", source: h.source.path, anchors: [] });
  await writer.updateMemo(next, "edited");
  const latest = ctx.transitAPI.parse(h.files.get(h.canvas), h.canvas.path)[0];
  assert.equal(latest.content, "edited");
  assert.equal(latest.transit.source, h.source.path);
  await assert.rejects(h.transit.insertMemo(next, h.snapshot()), /卡片已变化/);
  await h.transit.insertMemo(latest, { ...h.snapshot(), from: 0, to: 0 });
  assert.match(h.editor.getValue(), /^editedhello/);
});

test("locate opens original reference and highlights its indexed block", async () => {
  const h = setup();
  const card = await h.transit.createMemo("![[Notes/source.md#^block]]", { mode: "reference", source: h.source.path,
    referenceType: "block", anchors: [{ id: "block" }] });
  h.cache.blocks.block = { position: { start: { line: 0, col: 0 }, end: { line: 0, col: 5 } } };
  let opened, scrolled = false, effects = 0;
  h.plugin.app.workspace.getLeaf = () => ({ view: h.view, openFile: async file => { opened = file; } });
  h.editor.scrollIntoView = () => { scrolled = true; };
  h.cm.dispatch = () => { effects++; };
  await h.transit.locate(card);
  assert.equal(opened, h.source);
  assert.equal(scrolled, true);
  assert.ok(effects >= 1);
  h.transit.clearHighlight(h.cm);
  assert.equal(h.transit.timers.size, 0);
});

test("card footer buttons bind to target editor and native reference semantics", async () => {
  const h = setup();
  const buttons = [];
  const parent = { createEl(tag, options) {
    const button = { text: options.text, addEventListener(name, callback) { this.click = callback; } };
    buttons.push(button); return button;
  }, createSpan() {} };
  const card = { querySelector: () => null, createDiv: () => parent };
  const memo = await h.transit.createMemo("body", { mode: "move", source: h.source.path });
  h.transit.decorateCard(card, memo);
  assert.deepEqual(buttons.map(button => button.text), ["移出到正文", "引用卡片", "打开来源"]);
  let operation;
  h.transit.run = action => operation = action();
  buttons[1].click({ stopPropagation() {} });
  await operation;
  assert.equal(h.cards().length, 1);
  assert.match(h.editor.getValue(), /^!\[\[UNmemos/);
});
