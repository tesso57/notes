import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNoteSearch } from "../search.ts";

const vector = (value: number) => Array.from({ length: 3072 }, (_, i) => i === value ? 1 : 0);

test("関連順に返し、変更のないノートだけ再利用する", async () => {
  const root = await mkdtemp(join(tmpdir(), "notes-search-"));
  const original = globalThis.fetch;
  const requests: string[][] = [];
  try {
    await mkdir(join(root, ".pi/_notes", "session"), { recursive: true });
    const file = join(root, ".pi/_notes", "session", "note.md");
    await writeFile(file, "りんごについて");
    await writeFile(join(root, ".pi/_notes", "other.md"), "猫について");
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "text-embedding-3-large");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
      requests.push(body.input);
      return Response.json({ data: body.input.map((text: string, index: number) => ({ index, embedding: vector(text.includes("猫") ? 1 : 0) })) });
    };
    const search = createNoteSearch();
    const results = await search(root, "猫を探す", "test-key");
    assert.equal(results[0].path, ".pi/_notes/other.md");
    assert.equal(results[0].score, 1);
    const path = join(root, ".pi/_notes", ".notes-search-cache.json");
    const before = await stat(path, { bigint: true });
    await search(root, "猫を探す", undefined);
    const after = await stat(path, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    await createNoteSearch()(root, "猫を探す", "test-key");
    assert.deepEqual(requests.map(r => r.length), [2, 1]);
    const cacheFile = join(root, ".pi/_notes", ".notes-search-cache.json");
    const saved = await readFile(cacheFile, "utf8");
    assert.ok(!saved.includes("猫を探す") && !saved.includes("猫について"));
    assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
    await writeFile(file, "犬について");
    await search(root, "猫を探す", "test-key");
    assert.deepEqual(requests.at(-1), ["犬について"]);
    await rm(join(root, ".pi/_notes", "other.md"));
    assert.equal((await search(root, "猫", "test-key")).length, 1);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});

test("検索文のキャッシュは直近 1000 件を保持する", async () => {
  const root = await mkdtemp(join(tmpdir(), "notes-cache-"));
  const original = globalThis.fetch;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  try {
    await mkdir(join(root, ".pi/_notes"), { recursive: true });
    await writeFile(join(root, ".pi/_notes", "note.md"), "content");
    const queries = Array.from({ length: 1000 }, (_, i) => [hash(`query-${i}`), vector(0)]);
    const path = join(root, ".pi/_notes", ".notes-search-cache.json");
    await writeFile(path, JSON.stringify({ version: 2, model: "text-embedding-3-large", notes: [[hash("content"), vector(0)]], queries }));
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ data: [{ index: 0, embedding: vector(0) }] }); };
    const search = createNoteSearch();
    await search(root, "query-0", "key");
    assert.equal(calls, 0);
    await search(root, "new-query", "key");
    assert.equal(calls, 1);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.queries.length, 1000);
    assert.ok(saved.queries.some(([key]: string[]) => key === hash("query-0")));
    assert.ok(!saved.queries.some(([key]: string[]) => key === hash("query-1")));
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});

test("空のディレクトリ、キー不足、API エラーを扱う", async () => {
  const root = await mkdtemp(join(tmpdir(), "notes-search-"));
  const original = globalThis.fetch;
  try {
    const search = createNoteSearch();
    assert.deepEqual(await search(root, "query", "key"), []);
    await mkdir(join(root, ".pi/_notes"), { recursive: true });
    await writeFile(join(root, ".pi/_notes", "note.md"), "content");
    await assert.rejects(search(root, "query", undefined), /GUARD_OPENAI_API_KEY/);
    globalThis.fetch = async () => new Response("secret server content", { status: 403 });
    await assert.rejects(search(root, "query", "key"), /HTTP 403/);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});

test("冒頭への追記は後続の見出しを再送せず、抜粋の行番号を更新する", async t => {
  const root = await mkdtemp(join(tmpdir(), "notes-sections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    requests.push(input);
    return Response.json({ data: input.map((_, index) => ({ index, embedding: vector(0) })) });
  });
  await mkdir(join(root, ".pi/_notes"), { recursive: true });
  const file = join(root, ".pi/_notes", "note.md");
  const section = "## 実行例\n~~~sh\n# コメント\n~~~\n";
  await writeFile(file, "# 判断\n採用\n" + section);
  const search = createNoteSearch();
  await search(root, "判断", "key");
  await writeFile(file, "# 判断\n理由を追記\n採用\n" + section);
  const hits = await search(root, "判断", "key");
  assert.deepEqual(requests.at(-1), [["# 判断", "理由を追記", "採用", ""].join("\n")]);
  assert.equal(hits.find(hit => hit.text === section)?.line, 4);
  await rm(file);
  assert.deepEqual(await search(root, "判断", undefined), []);
  const cache = JSON.parse(await readFile(join(root, ".pi/_notes", ".notes-search-cache.json"), "utf8"));
  assert.equal(cache.notes.length, 0);
});

test("サブディレクトリからも旧集約ノートを検索・送信せずプロジェクトのキャッシュを共有する", async t => {
  const project = await mkdtemp(join(tmpdir(), "nested-search-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, ".pi/_notes"), { recursive: true });
  await mkdir(join(project, "_notes"));
  await mkdir(join(project, "sub"));
  await writeFile(join(project, ".pi/_notes/new.md"), "new");
  await writeFile(join(project, "_notes/old.md"), "old");
  await mkdir(join(project, "_notes/.notes-search-cache.json"));
  const requests: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const input: string[] = JSON.parse(String(init.body)).input;
    requests.push(input);
    return Response.json({ data: input.map((_, index) => ({ index, embedding: vector(0) })) });
  });
  const hits = await createNoteSearch()(join(project, "sub"), "query", "key");
  assert.deepEqual(hits.map(hit => hit.path), ["../.pi/_notes/new.md"]);
  assert.deepEqual(requests, [["new"], ["query"]]);
  await createNoteSearch()(project, "query", undefined);
  await rm(join(project, ".pi/_notes"), { recursive: true });
  assert.deepEqual(await createNoteSearch()(project, "another query", "key"), []);
  assert.equal(requests.length, 2);
});
