import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createFakeModel } from "./helpers/fake-model.ts";

async function makeSession(dir: string, fake: ReturnType<typeof createFakeModel>, sessions: SessionManager) {
  const agentDir = join(dir, "agent");
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir, additionalExtensionPaths: [resolve("index.ts")],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions.some(extension => extension.commands.has("note")));
  const { session } = await createAgentSession({ cwd: dir, agentDir, model: fake.model, sessionManager: sessions, resourceLoader: loader, tools: ["read", "write"] });
  session.modelRuntime.hasConfiguredAuth = () => true;
  session.agent.streamFunction = fake.stream;
  return session;
}

test("Pi の応答完了後、追加の記録ターンでノートを保存する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notes-integration-"));
  const sessions = SessionManager.inMemory(dir);
  const path = join(dir, "_notes", sessions.getSessionId(), "note.md");
  const fake = createFakeModel([
    { content: [{ type: "text", text: "回答" }] },
    { content: [{ type: "toolCall", id: "write-note", name: "write", arguments: { path, content: "自動記録" } }] },
    { content: [{ type: "text", text: "ノートを更新しました。" }] },
  ]);
  try {
    const session = await makeSession(dir, fake, sessions);
    try {
      await session.prompt("相談");
      await session.waitForIdle();
      assert.equal(await readFile(path, "utf8"), "自動記録");
      assert.equal(fake.requests.length, 3);
      assert.ok(session.messages.some(message => message.role === "custom" && message.customType === "pi-session-notes-request"));
    } finally { session.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("/note で追加ファイルを依頼し、既存ノートを読んでから保存できる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notes-integration-"));
  const sessions = SessionManager.inMemory(dir);
  const note = join(dir, "_notes", sessions.getSessionId(), "note.md");
  const extra = join(dir, "_notes", sessions.getSessionId(), "handoff.md");
  const fake = createFakeModel([
    { content: [{ type: "toolCall", id: "read-note", name: "read", arguments: { path: note } }] },
    { content: [{ type: "toolCall", id: "write-extra", name: "write", arguments: { path: extra, content: "引き継ぎ" } }] },
    { content: [{ type: "text", text: "ノートを更新しました。" }] },
  ]);
  try {
    await mkdir(join(dir, ".pi"));
    await mkdir(join(dir, "_notes", sessions.getSessionId()), { recursive: true });
    await writeFile(note, "既存ノート");
    await writeFile(join(dir, ".pi", "notes-extra.json"), JSON.stringify({ documents: [{ path: "_notes/{sessionId}/handoff.md", description: "引き継ぎ" }] }));
    const session = await makeSession(dir, fake, sessions);
    try {
      await session.prompt("/note");
      await session.waitForIdle();
      assert.equal(await readFile(note, "utf8"), "既存ノート");
      assert.equal(await readFile(extra, "utf8"), "引き継ぎ");
      assert.ok(session.messages.some(message => message.role === "custom" && JSON.stringify(message.content).includes(extra)));
      const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === "read-note");
      assert.ok(result && result.role === "toolResult" && !result.isError);
      assert.match(JSON.stringify(result.content), /既存ノート/);
      assert.equal(fake.requests.length, 3);
    } finally { session.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
