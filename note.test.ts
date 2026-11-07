import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import noteExtension, { notePath } from "./index.ts";

const root = "/tmp/another-repository";

function setup() {
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const hooks = new Map<string, (event: any, ctx: ExtensionCommandContext) => unknown>();
  const messages: { customType: string; content: string }[] = [];
  const notifications: string[] = [];
  const events: { name: string; data: unknown }[] = [];
  let idle = true;
  let pending = false;
  let renderer: (name: string, next: () => any) => any;
  noteExtension({
    events: { emit: (name: string, data: unknown) => { events.push({ name, data }); } },
    registerToolRenderer(resolver) { renderer = resolver; },
    on(name, callback) { hooks.set(name, callback as any); },
    registerCommand(name, options) {
      assert.equal(name, "note");
      handler = options.handler;
    },
    sendMessage(message, options) {
      assert.equal(options?.triggerTurn, true);
      assert.equal(message.display, false);
      messages.push(message as { customType: string; content: string });
    },
  } as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/another-repository",
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
  return {
    run: (args = "") => handler(args, ctx), messages, notifications, events,
    renderer: (name: string, next: () => any) => renderer(name, next),
    emit: async (name: string, event = {}) => { await hooks.get(name)?.(event, ctx); },
    setIdle: (value: boolean) => { idle = value; },
    setPending: (value: boolean) => { pending = value; },
  };
}

test("セッション開始時に guard へノートのディレクトリを通知する", async () => {
  const mock = setup();
  await mock.emit("session_start");
  assert.deepEqual(mock.events, [{ name: "guard:trust-dir", data: { path: resolve(root, "_notes/test-session"), by: "note" } }]);
});

test("session ID を固定ノートのパスに解決する", () => {
  assert.equal(notePath(root, "session-123"), resolve(root, "_notes/session-123/note.md"));
  for (const id of ["", ".", "..", "../outside", "/tmp/outside", "a/b", "a\\b", "a b"]) {
    assert.throws(() => notePath(root, id));
  }
});

test("手動保存は作業ディレクトリの保存先と session ID を使う", async () => {
  const mock = setup();
  await mock.run();
  assert.equal(mock.messages.length, 1);
  assert.ok(mock.messages[0].content.includes(JSON.stringify(resolve(root, "_notes/test-session/note.md"))));
  assert.ok(mock.messages[0].content.includes('"sessionFile":null'));
  assert.ok(mock.messages[0].content.includes("別ファイルには分割しない"));
  assert.ok(mock.messages[0].content.includes("ノートを更新しました。"));
  assert.ok(mock.messages[0].content.includes("アシスタントの提案を区別"));
});

test("通常の実行が settled になった直後に記録を依頼する", async () => {
  const mock = setup();
  await mock.emit("before_agent_start", { messageType: "user" });
  await mock.emit("agent_settled", { aborted: false });
  assert.equal(mock.messages.length, 1);
});

test("ノート化自身の settled では再実行しないが、次の会話は記録する", async () => {
  const mock = setup();
  await mock.run();
  await mock.emit("before_agent_start", { messageType: "custom", message: mock.messages[0] });
  await mock.emit("agent_settled", { aborted: false });
  assert.equal(mock.messages.length, 1);
  await mock.emit("before_agent_start", { messageType: "user" });
  await mock.emit("agent_settled", { aborted: false });
  assert.equal(mock.messages.length, 2);
});

test("ノート化中だけツール表示を抑え、エラーは表示する", async () => {
  const mock = setup();
  const original = {};
  assert.equal(mock.renderer("write", () => original), original);
  await mock.run();
  await mock.emit("before_agent_start", { messageType: "custom", message: mock.messages[0] });
  const renderer = mock.renderer("write", () => original);
  assert.equal(renderer.renderShell, "self");
  assert.deepEqual(renderer.renderCall().render(80), []);
  assert.deepEqual(renderer.renderResult({ content: [] }, {}, {}, { isError: false }).render(80), []);
  assert.deepEqual(renderer.renderResult({ content: [{ type: "text", text: "guard: blocked" }] }, {}, {}, { isError: true }).render(80), ["guard: blocked"]);
  await mock.emit("agent_settled", { aborted: false });
  assert.equal(mock.renderer("write", () => original), original);
  assert.deepEqual(renderer.renderCall().render(80), []);
});

test("中断した実行は自動記録しない", async () => {
  const mock = setup();
  await mock.emit("agent_settled", { aborted: true });
  assert.equal(mock.messages.length, 0);
});

test("保存依頼の読み込み中に入力されたら古い依頼を破棄する", async () => {
  const mock = setup();
  const saving = mock.run();
  await mock.emit("input");
  await saving;
  assert.equal(mock.messages.length, 0);
});

test("終了時は未送信の保存依頼を破棄する", async () => {
  const mock = setup();
  const saving = mock.run();
  await mock.emit("session_shutdown");
  await saving;
  assert.equal(mock.messages.length, 0);
});

test("同時に保存を依頼しても最後の一件だけ送信する", async () => {
  const mock = setup();
  await Promise.all([mock.run(), mock.run()]);
  assert.equal(mock.messages.length, 1);
});

test("処理中・待機メッセージありの場合は割り込まない", async () => {
  const mock = setup();
  mock.setIdle(false);
  await mock.run();
  assert.equal(mock.notifications.length, 1);
  mock.setIdle(true);
  mock.setPending(true);
  await mock.emit("agent_settled", { aborted: false });
  assert.equal(mock.messages.length, 0);
});

test("project 名の引数は受け付けない", async () => {
  const mock = setup();
  await mock.run("new-project");
  assert.equal(mock.messages.length, 0);
  assert.equal(mock.notifications.length, 1);
});

test("設定ファイルと環境変数でファイル名を含めて保存先を変更できる", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-notes-"));
  try {
    mkdirSync(resolve(cwd, ".pi"));
    writeFileSync(resolve(cwd, ".pi/notes.json"), JSON.stringify({ path: "../shared/{sessionId}.md" }));
    assert.equal(notePath(cwd, "abc", ""), resolve(cwd, "../shared/abc.md"));
    assert.equal(notePath(cwd, "abc", "/tmp/notes/{sessionId}/memo.md"), "/tmp/notes/abc/memo.md");
    writeFileSync(resolve(cwd, ".pi/notes.json"), "invalid");
    assert.throws(() => notePath(cwd, "abc", ""));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
