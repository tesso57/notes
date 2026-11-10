import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMockPi } from "./tests/helpers/mock-pi.ts";
import noteExtension, { notePath, factoryPaths } from "./index.ts";

const root = "/tmp/another-repository";

function setup(cwd = root) {
  const mock = createMockPi();
  Object.assign(mock.context, {
    cwd,
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
  });
  noteExtension(mock.pi);
  return {
    run: (args = "") => mock.runCommand("note", args),
    get messages() {
      return mock.messages.map(({ message, options }) => {
        assert.equal(options?.triggerTurn, true);
        assert.equal(message.display, false);
        assert.equal(typeof message.content, "string");
        return { customType: message.customType, content: message.content as string };
      });
    },
    get notifications() { return mock.notifications.map(({ message }) => message); },
    events: mock.emittedEvents,
    renderer: (name: string, next: () => unknown) => mock.renderer(name, next) as any,
    emit: async (name: string, event = {}) => { await mock.emit(name, event); },
    setIdle: mock.setIdle,
    setPending: mock.setPending,
  };
}

test("セッション開始時に guard へノートのディレクトリを通知する", async () => {
  const mock = setup();
  await mock.emit("session_start");
  assert.deepEqual(mock.events, [{ name: "guard:trust-dir", data: { path: resolve(root, "_notes/test-session"), by: "note" } }]);
});

test("Factory は明示的な設定がなければ無効", () => {
  assert.equal(factoryPaths(root, "abc", notePath(root, "abc", "")), undefined);
});

test("Factory の保存先はセッション別で、個別に設定できる", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-notes-factory-"));
  try {
    mkdirSync(resolve(cwd, ".pi"));
    writeFileSync(resolve(cwd, ".pi/notes-factory.json"), JSON.stringify({ review: "../shared/{sessionId}/review.md" }));
    assert.deepEqual(factoryPaths(cwd, "abc", notePath(cwd, "abc", "")), {
      plan: resolve(cwd, "_notes/abc/factory/plan.md"),
      review: resolve(cwd, "../shared/abc/review.md"),
      learnings: resolve(cwd, "_notes/abc/factory/learnings.md"),
    });
    writeFileSync(resolve(cwd, ".pi/notes-factory.json"), JSON.stringify({ plan: "_notes/{sessionId}/note.md" }));
    assert.throws(() => factoryPaths(cwd, "abc", notePath(cwd, "abc", "")), /重複/);
    writeFileSync(resolve(cwd, ".pi/notes-factory.json"), JSON.stringify({ plan: "same.md", review: "same.md" }));
    assert.throws(() => factoryPaths(cwd, "abc", notePath(cwd, "abc", "")), /重複/);
    for (const invalid of [null, [], { plan: null }, { plan: "" }, { typo: "x" }]) {
      writeFileSync(resolve(cwd, ".pi/notes-factory.json"), JSON.stringify(invalid));
      assert.throws(() => factoryPaths(cwd, "abc", notePath(cwd, "abc", "")));
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Factory 設定時は通常ノートと分類別の記録を同じ実行で依頼する", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-notes-factory-"));
  try {
    mkdirSync(resolve(cwd, ".pi"));
    writeFileSync(resolve(cwd, ".pi/notes-factory.json"), "{}");
    const mock = setup(cwd);
    await mock.emit("session_start");
    await mock.emit("agent_settled", { aborted: false });
    assert.ok(!mock.messages[0].content.includes("factory/plan.md"));
    await mock.run();
    assert.equal(mock.messages.length, 2);
    for (const name of ["plan", "review", "learnings"]) {
      assert.ok(mock.messages[1].content.includes(resolve(cwd, `_notes/test-session/factory/${name}.md`)));
    }
    assert.ok(mock.messages[1].content.includes("既存ファイル"));
    assert.ok(mock.messages[1].content.includes("子エージェント"));
    assert.ok(mock.messages[1].content.includes("末尾に追記"));
    assert.deepEqual(mock.events.map(event => (event.data as { path: string }).path), [
      resolve(cwd, "_notes/test-session"),
      resolve(cwd, "_notes/test-session"),
      resolve(cwd, "_notes/test-session"), resolve(cwd, "_notes/test-session/factory"),
    ]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("不正な手動用設定があっても通常ノートの開始時通知と自動記録を妨げない", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-notes-invalid-"));
  try {
    mkdirSync(resolve(cwd, ".pi"));
    writeFileSync(resolve(cwd, ".pi/notes-factory.json"), "invalid");
    const mock = setup(cwd);
    await mock.emit("session_start");
    assert.deepEqual(mock.events, [{ name: "guard:trust-dir", data: { path: resolve(cwd, "_notes/test-session"), by: "note" } }]);
    assert.equal(mock.notifications.length, 0);
    await mock.emit("agent_settled", { aborted: false });
    assert.equal(mock.messages.length, 1);
    await mock.run();
    assert.equal(mock.messages.length, 1);
    assert.equal(mock.notifications.length, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("任意の追加ファイルは /note 実行時だけ記録を依頼する", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-notes-extra-"));
  try {
    mkdirSync(resolve(cwd, ".pi"));
    writeFileSync(resolve(cwd, ".pi/notes-extra.json"), JSON.stringify({ documents: [
      { path: "_notes/{sessionId}/decisions.md", description: "判断と理由" },
      { path: "../shared/{sessionId}/handoff.md", description: "引き継ぎ" },
    ] }));
    const mock = setup(cwd);
    await mock.emit("agent_settled", { aborted: false });
    assert.equal(mock.messages.length, 1);
    assert.ok(!mock.messages[0].content.includes("decisions.md"));
    await mock.run();
    assert.equal(mock.messages.length, 2);
    assert.ok(mock.messages[1].content.includes(resolve(cwd, "_notes/test-session/decisions.md")));
    assert.ok(mock.messages[1].content.includes(resolve(cwd, "../shared/test-session/handoff.md")));
    assert.ok(mock.messages[1].content.includes("判断と理由"));
    assert.ok(mock.messages[1].content.includes("末尾に追記"));
    assert.ok(mock.events.some(event => (event.data as { path: string }).path === resolve(cwd, "../shared/test-session")));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("追加ファイルが通常ノートや Factory と衝突したら保存を開始しない", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-notes-extra-"));
  try {
    mkdirSync(resolve(cwd, ".pi"));
    writeFileSync(resolve(cwd, ".pi/notes-factory.json"), "{}");
    for (const path of ["_notes/{sessionId}/note.md", "_notes/{sessionId}/factory/plan.md"]) {
      writeFileSync(resolve(cwd, ".pi/notes-extra.json"), JSON.stringify({ documents: [{ path, description: "記録" }] }));
      const mock = setup(cwd);
      await mock.run();
      assert.equal(mock.messages.length, 0);
      assert.match(mock.notifications[0], /重複/);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("シンボリックリンク経由で同じ保存先を指定したら記録を開始しない", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-notes-alias-"));
  try {
    mkdirSync(resolve(cwd, ".pi"));
    mkdirSync(resolve(cwd, "_notes"));
    symlinkSync(resolve(cwd, "_notes"), resolve(cwd, "alias"));
    writeFileSync(resolve(cwd, ".pi/notes-extra.json"), JSON.stringify({ documents: [
      { path: "alias/{sessionId}/note.md", description: "記録" },
    ] }));
    const mock = setup(cwd);
    await mock.run();
    assert.equal(mock.messages.length, 0);
    assert.match(mock.notifications[0], /重複/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
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
  assert.ok(mock.messages[0].content.includes("末尾に追記"));
  assert.ok(mock.messages[0].content.includes("新しい情報がない場合"));
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

for (const event of ["session_before_switch", "session_before_fork"]) {
  test(`${event} の開始時に未送信の保存依頼を破棄する`, async () => {
    const mock = setup();
    const saving = mock.run();
    await mock.emit(event);
    await saving;
    assert.equal(mock.messages.length, 0);
  });
}

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

test("手動保存を待機メッセージのため見送った場合は通知する", async () => {
  const mock = setup();
  mock.setPending(true);
  await mock.run();
  assert.equal(mock.messages.length, 0);
  assert.equal(mock.notifications.length, 1);
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
