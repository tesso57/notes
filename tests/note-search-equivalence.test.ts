import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createNoteSearch } from "../search.ts";

test("編集・削除後のキャッシュ再利用は再計算と同じ上位候補を返す", async t => {
  const root = await mkdtemp(join(tmpdir(), "notes-search-equivalence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = join(root, ".pi/_notes");
  const edited = "# First\nchanged\nadditional line\n";
  const repeated = "# Keep\nstay\n";
  const query = "find";
  const key = "synthetic-key";
  const requests: string[][] = [];

  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    requests.push(input);
    const data = input.map((text, index) => ({
      index,
      embedding: Array.from({ length: 3072 }, (_, i) => Number(i === (text === edited ? 1 : 0))),
    }));
    return Response.json({ data: data.reverse() });
  });

  await mkdir(notes, { recursive: true });
  await writeFile(join(notes, "a.md"), "# First\noriginal\n" + repeated);
  await writeFile(join(notes, "b.md"), repeated);
  for (const name of ["c", "d", "e", "f", "g"]) {
    await writeFile(join(notes, name + ".md"), "same rank " + name);
  }

  const search = createNoteSearch();
  await search(root, query, key);
  await writeFile(join(notes, "a.md"), edited + repeated);
  await rm(join(notes, "e.md"));
  requests.length = 0;

  const partial = await search(root, query, key);
  assert.deepEqual(requests, [[edited]]);
  assert.deepEqual(partial.map(hit => [basename(hit.path), hit.line, hit.score]), [
    ["a.md", 4, 1], ["b.md", 1, 1], ["c.md", 1, 1], ["d.md", 1, 1], ["f.md", 1, 1],
  ]);
  assert.deepEqual(partial.slice(0, 2).map(hit => hit.text), [repeated, repeated]);

  requests.length = 0;
  const reopened = createNoteSearch();
  assert.deepEqual(await reopened(root, query, undefined), partial);
  assert.deepEqual(await reopened(root, query, undefined), partial);
  assert.equal(requests.length, 0);
  assert.deepEqual(await reopened(root, "new-query", key), partial);
  assert.deepEqual(requests, [["new-query"]]);

  requests.length = 0;
  await rm(join(notes, ".notes-search-cache.json"));
  assert.deepEqual(await createNoteSearch()(root, query, key), partial);
  assert.deepEqual(requests.map(input => input.length), [6, 1]);
});
