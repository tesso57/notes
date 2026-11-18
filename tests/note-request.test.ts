import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import noteExtension from "../index.ts";
import { createMockPi } from "./helpers/mock-pi.ts";

function setup(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-notes-request-"));
  const config = join(cwd, ".pi", "notes.json");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(config, JSON.stringify({ factory: {} }));

  const mock = createMockPi();
  let sessionId = "original-session";
  Object.assign(mock.context, {
    cwd,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(cwd, sessionId + ".jsonl") },
  });
  noteExtension(mock.pi);

  const reads: {
    name: string;
    signal?: AbortSignal;
    succeed: (text: string) => void;
    fail: (error: Error) => void;
  }[] = [];
  const readFile = t.mock.method(fs, "readFile", (path: string, options: { signal?: AbortSignal } | string) =>
    new Promise<string>((succeed, fail) => {
      const signal = typeof options === "string" ? undefined : options.signal;
      reads.push({ name: basename(path), signal, succeed, fail });
    }));
  syncBuiltinESMExports();
  t.after(() => {
    readFile.mock.restore();
    syncBuiltinESMExports();
  });

  return {
    ...mock,
    cwd,
    config,
    reads,
    manual: () => mock.runCommand("note"),
    automatic: () => mock.emit("agent_settled", { aborted: false }),
    setSession(id: string) { sessionId = id; },
  };
}

test("古い自動依頼の読み込みが失敗しても、最新の手動依頼だけを送信する", async (t) => {
  const pi = setup(t);
  const automatic = pi.automatic();
  const manual = pi.manual();
  assert.deepEqual(pi.reads.map(read => read.name), ["procedure.md", "procedure.md", "factory-procedure.md"]);
  const [old, procedure, factory] = pi.reads;
  assert.equal(old.signal?.aborted, true);

  old.fail(new Error("late procedure failure"));
  await automatic;
  assert.deepEqual(pi.notifications, []);
  assert.deepEqual(pi.emittedEvents, []);
  assert.equal(procedure.signal?.aborted, false);

  factory.succeed("Factory 手順");
  procedure.succeed("通常手順");
  await manual;
  assert.equal(pi.messages.length, 1);
  assert.match(String(pi.messages[0].message.content), /通常手順[\s\S]*Factory 手順/);
});

test("自動依頼が後から来たら、古い Factory の両方の手順をキャンセルする", async (t) => {
  const pi = setup(t);
  const manual = pi.manual();
  const automatic = pi.automatic();
  assert.deepEqual(pi.reads.map(read => read.name), ["procedure.md", "factory-procedure.md", "procedure.md"]);
  const [old, oldFactory, current] = pi.reads;
  assert.deepEqual([old.signal?.aborted, oldFactory.signal?.aborted, current.signal?.aborted], [true, true, false]);

  old.succeed("古い通常手順");
  oldFactory.succeed("古い Factory 手順");
  await manual;
  assert.equal(pi.messages.length, 0);
  assert.deepEqual(pi.emittedEvents, []);
  current.succeed("新しい通常手順");
  await automatic;
  assert.equal(pi.messages.length, 1);
  assert.match(String(pi.messages[0].message.content), /新しい通常手順/);
  assert.doesNotMatch(String(pi.messages[0].message.content), /古い|Factory 保存先/);
  assert.deepEqual(pi.notifications, []);
});

test("現在の Factory 手順が失敗したらもう一方をキャンセルして一度だけ通知する", async (t) => {
  const pi = setup(t);
  const failed = pi.manual();
  const [procedure, factory] = pi.reads;
  assert.equal(factory.name, "factory-procedure.md");
  factory.fail(new Error("synthetic EIO"));
  await failed;
  assert.equal(procedure.signal?.aborted, true);
  procedure.fail(new Error("late second failure"));
  assert.deepEqual(pi.notifications, [{ type: "error", message: "ノート作成を開始できませんでした: synthetic EIO" }]);
  assert.deepEqual(pi.messages, []);
  assert.deepEqual(pi.emittedEvents, []);
});

test("セッション切り替え後は古い読み込みのエラーを通知せず、新しいセッションだけを記録する", async (t) => {
  const pi = setup(t);
  const old = pi.automatic();
  await pi.emit("session_before_switch", {});
  assert.equal(pi.reads[0].signal?.aborted, true);
  pi.setSession("new-session");
  await pi.emit("session_start", {});
  const current = pi.automatic();

  pi.reads[0].fail(new Error("old session read failure"));
  await old;
  assert.deepEqual(pi.notifications, []);
  assert.equal(pi.reads[1].signal?.aborted, false);
  pi.reads[1].succeed("新セッション手順");
  await current;
  assert.equal(pi.messages.length, 1);
  const content = String(pi.messages[0].message.content);
  assert.match(content, /"sessionId":"new-session"/);
  assert.match(content, /new-session\.jsonl/);
  assert.doesNotMatch(content, /original-session/);
  assert.deepEqual(pi.emittedEvents.map(event => event.data), [
    { path: join(pi.cwd, ".pi/_notes/new-session"), by: "note" },
    { path: join(pi.cwd, ".pi/_notes/new-session"), by: "note" },
  ]);
});

test("未処理メッセージがある依頼は読み込み前と送信直前に見送る", async (t) => {
  const pi = setup(t);
  pi.setPending(true);
  writeFileSync(pi.config, "{");
  await pi.manual();
  await pi.automatic();
  assert.equal(pi.reads.length, 0);
  assert.deepEqual(pi.notifications.map(entry => entry.type), ["warning"]);

  pi.setPending(false);
  writeFileSync(pi.config, JSON.stringify({ factory: {} }));
  const manual = pi.manual();
  pi.setPending(true);
  for (const read of pi.reads) read.succeed(read.name);
  await manual;
  assert.deepEqual(pi.notifications.map(entry => entry.type), ["warning", "warning"]);
  assert.deepEqual(pi.messages, []);
  assert.deepEqual(pi.emittedEvents, []);
});

test("/note は同じセッションでも毎回設定を読み直す", async (t) => {
  const pi = setup(t);
  const extras = join(pi.cwd, ".pi", "notes-extra.json");
  const writeConfig = (folder: string) => {
    writeFileSync(pi.config, JSON.stringify({
      path: folder + "/{sessionId}/note.md",
      factory: { plan: folder + "/{sessionId}/plan.md" },
    }));
    writeFileSync(extras, JSON.stringify({
      documents: [{ path: folder + "/{sessionId}/extra.md", description: folder }],
    }));
  };

  for (const [i, folder] of ["previous", "updated"].entries()) {
    writeConfig(folder);
    const request = pi.manual();
    for (const read of pi.reads.slice(i * 2)) read.succeed(read.name);
    await request;
    const content = String(pi.messages[i].message.content);
    for (const name of ["note", "plan", "extra"]) {
      assert.ok(content.includes(join(pi.cwd, folder, "original-session", name + ".md")));
    }
  }
  assert.deepEqual(pi.notifications, []);
});
