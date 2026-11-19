import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { noteProject, notesDirectory } from "./project.ts";

const model = "text-embedding-3-large";
const chunkSize = 1200;
type Chunk = { path: string; line: number; text: string; hash: string };
type Result = { path: string; line: number; text: string; score: number };

function splitNote(path: string, text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let part = "";
  let length = 0;
  let startLine = 1;
  let line = 1;
  let fence = "";
  function flush() {
    if (part.trim()) chunks.push({ path, line: startLine, text: part, hash: createHash("sha256").update(part).digest("hex") });
    part = "";
    length = 0;
  }
  for (const [row] of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(row);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = "";
    } else if (marker) {
      fence = marker[1];
    } else if (/^ {0,3}#{1,6}(?:\s|$)/.test(row)) {
      flush();
    }
    const chars = Array.from(row);
    if (length + chars.length > chunkSize) flush();
    for (let offset = 0; offset < chars.length; offset += chunkSize) {
      if (!length) startLine = line;
      const slice = chars.slice(offset, offset + chunkSize);
      part += slice.join("");
      length += slice.length;
      if (length === chunkSize) flush();
    }
    line++;
  }
  flush();
  return chunks;
}

async function documents(root: string): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && dir === root) return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const text = await readFile(path, "utf8");
        for (const chunk of splitNote(path, text)) chunks.push(chunk);
      }
    }
  }
  await visit(root);
  return chunks;
}

async function embed(input: string[], key: string | undefined, signal?: AbortSignal): Promise<number[][]> {
  if (!key) throw new Error("GUARD_OPENAI_API_KEY が設定されていません。");
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input, encoding_format: "float" }),
  });
  if (!response.ok) throw new Error(`OpenAI Embeddings API が HTTP ${response.status} を返しました。キーの権限、利用枠、通信設定を確認してください。`);
  const body = await response.json() as { data?: { index: number; embedding: unknown }[] };
  if (!Array.isArray(body.data) || body.data.length !== input.length) throw new Error("Embedding API の応答が不正です。");
  const vectors: number[][] = Array(input.length);
  for (const item of body.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || vectors[item.index] ||
        !Array.isArray(item.embedding) || item.embedding.length !== 3072 ||
        !item.embedding.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) throw new Error("Embedding API のベクトルが不正です。");
    vectors[item.index] = item.embedding as number[];
  }
  return vectors;
}

function similarity(a: number[], b: number[]): number {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 3072 && value.every(n => typeof n === "number" && Number.isFinite(n));
}

type Cache = { notes: Map<string, number[]>; queries: Map<string, number[]> };
const emptyCache = (): Cache => ({ notes: new Map(), queries: new Map() });

async function readCache(path: string): Promise<Cache> {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || data.version !== 2 || data.model !== model) return emptyCache();
    const parse = (entries: unknown): Map<string, number[]> => new Map(Array.isArray(entries) ? entries.filter((entry: unknown) => Array.isArray(entry) && entry.length === 2 &&
      typeof entry[0] === "string" && /^[0-9a-f]{64}$/.test(entry[0]) && validVector(entry[1])) : []);
    const queries = parse(data.queries);
    while (queries.size > 1000) queries.delete(queries.keys().next().value!);
    return { notes: parse(data.notes), queries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return emptyCache();
    throw error;
  }
}

async function writeCache(path: string, cache: Cache): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 2, model, notes: [...cache.notes], queries: [...cache.queries] }), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export function createNoteSearch() {
  let previous: { path: string; revision: string; cache: Cache } | undefined;
  return async (cwd: string, query: string, key: string | undefined, signal?: AbortSignal): Promise<Result[]> => {
    const q = query.trim();
    if (!q || Array.from(q).length > chunkSize) throw new Error("検索文は 1〜1200 文字で指定してください。");
    signal?.throwIfAborted();
    const project = noteProject(cwd);
    const root = resolve(project, notesDirectory);
    for (const dir of [join(project, ".pi"), root]) {
      const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (info?.isSymbolicLink()) throw new Error(`検索ディレクトリのリンクは利用できません: ${dir}`);
    }
    const chunks = await documents(root);
    const unique = new Map(chunks.map(chunk => [chunk.hash, chunk.text]));
    const cachePath = join(root, ".notes-search-cache.json");
    const info = await stat(cachePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!info && !chunks.length) return [];
    const revision = info && [info.dev, info.ino, info.size, info.ctimeNs].join("/");
    const stored = previous && previous.path === cachePath && previous.revision === revision
      ? previous.cache : info ? await readCache(cachePath) : emptyCache();
    if (revision) previous = { path: cachePath, revision, cache: stored };
    const cache = { notes: new Map(stored.notes), queries: new Map(stored.queries) };
    for (const hash of cache.notes.keys()) if (!unique.has(hash)) cache.notes.delete(hash);
    const pruned = cache.notes.size !== stored.notes.size;
    if (!chunks.length) {
      if (pruned) await writeCache(cachePath, cache);
      return [];
    }
    const missing = [...unique].filter(([hash]) => !cache.notes.has(hash));
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const vectors = await embed(batch.map(([, text]) => text), key, signal);
      batch.forEach(([hash], j) => cache.notes.set(hash, vectors[j]));
    }
    const queryHash = createHash("sha256").update(q).digest("hex");
    let queryVector = cache.queries.get(queryHash);
    const lastQuery = Array.from(cache.queries.keys()).at(-1);
    if (!queryVector) [queryVector] = await embed([q], key, signal);
    cache.queries.delete(queryHash);
    cache.queries.set(queryHash, queryVector);
    while (cache.queries.size > 1000) cache.queries.delete(cache.queries.keys().next().value!);
    if (!info || pruned || missing.length || lastQuery !== queryHash) {
      await writeCache(cachePath, cache);
    }
    const results = chunks.map(chunk => ({ path: relative(cwd, chunk.path), line: chunk.line, text: chunk.text, score: similarity(queryVector, cache.notes.get(chunk.hash)!) }));
    return results.sort((a, b) => b.score - a.score).slice(0, 5);
  };
}
