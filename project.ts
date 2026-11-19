import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const notesDirectory = ".pi/_notes";

export function noteProject(cwd: string): string {
  const start = resolve(cwd);
  let piRoot: string | undefined;
  for (let dir = start; dir !== homedir() && dirname(dir) !== dir; dir = dirname(dir)) {
    if (["notes.json", "notes-extra.json", "notes-factory.json"].some(file => existsSync(join(dir, ".pi", file)))) return dir;
    if (existsSync(join(dir, ".git"))) return dir;
    if (!piRoot && statSync(join(dir, ".pi"), { throwIfNoEntry: false })?.isDirectory()) piRoot = dir;
  }
  return piRoot ?? start;
}
