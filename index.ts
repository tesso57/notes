import { readFile } from "node:fs/promises";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const noteMessageType = "pi-session-notes-request";

type FactoryPaths = { plan: string; review: string; learnings: string };

function expandPath(cwd: string, template: string, sessionId: string): string {
  const path = template.replaceAll("{sessionId}", sessionId);
  return resolve(cwd, path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
}

function readOptionalJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// 存在しない保存先も、存在する先祖まで解決してリンク経由の重複を比較する。
function comparablePath(path: string): string {
  const suffix: string[] = [];
  const visited = new Set<string>();
  let current = path;
  for (;;) {
    try {
      return resolve(realpathSync(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) {
          if (visited.has(current) || visited.size >= 40) throw new Error("保存先のシンボリックリンクが循環しています。");
          visited.add(current);
          current = resolve(dirname(current), readlinkSync(current));
          continue;
        }
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function claimPath(seen: Set<string>, path: string): void {
  const canonical = comparablePath(path);
  const keys = [`path:${canonical}`];
  try {
    const stat = statSync(canonical, { bigint: true });
    keys.push(`inode:${stat.dev}:${stat.ino}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (keys.some(key => seen.has(key))) throw new Error("ノートの保存先が重複しています。");
  for (const key of keys) seen.add(key);
}

export function factoryPaths(cwd: string, sessionId: string, note: string): FactoryPaths | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("保存先に使えない session ID です。");
  const config = readOptionalJson(resolve(cwd, ".pi/notes-factory.json"));
  if (config === undefined) return undefined;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Factory 設定は JSON オブジェクトにしてください。");
  const settings = config as Record<string, unknown>;
  const names = ["plan", "review", "learnings"] as const;
  for (const key of Object.keys(settings)) {
    if (!names.includes(key as typeof names[number])) throw new Error(`不明な Factory 設定: ${key}`);
  }
  const paths = {} as FactoryPaths;
  for (const name of names) {
    const template = name in settings ? settings[name] : `_notes/{sessionId}/factory/${name}.md`;
    if (typeof template !== "string" || !template.trim()) throw new Error(`${name} に空でないパスを指定してください。`);
    paths[name] = expandPath(cwd, template, sessionId);
  }
  const seen = new Set<string>();
  for (const path of [note, ...Object.values(paths)]) claimPath(seen, path);
  return paths;
}

type ExtraDocument = { path: string; description: string };

function extraDocuments(cwd: string, sessionId: string, occupied: string[]): ExtraDocument[] {
  const config = readOptionalJson(resolve(cwd, ".pi/notes-extra.json"));
  if (config === undefined) return [];
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(key => key !== "documents") ||
      !Array.isArray((config as { documents?: unknown }).documents)) {
    throw new Error("追加ノート設定には documents 配列を指定してください。");
  }
  const seen = new Set<string>();
  for (const path of occupied) claimPath(seen, path);
  return (config as { documents: unknown[] }).documents.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => key !== "path" && key !== "description")) {
      throw new Error("追加ノートには path と description を指定してください。");
    }
    const { path, description } = value as Record<string, unknown>;
    if (typeof path !== "string" || !path.trim() || typeof description !== "string" || !description.trim()) {
      throw new Error("追加ノートの path と description は空でない文字列にしてください。");
    }
    const resolved = expandPath(cwd, path, sessionId);
    claimPath(seen, resolved);
    return { path: resolved, description };
  });
}

/** Resolve a destination template against the project working directory. */
export function notePath(cwd: string, sessionId: string, env = process.env.PI_NOTES_PATH): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("保存先に使えない session ID です。");
  }
  let template = env;
  if (!template) {
    try {
      const config = JSON.parse(readFileSync(resolve(cwd, ".pi", "notes.json"), "utf8"));
      if (typeof config.path !== "string" || !config.path.trim()) throw new Error("path に空でない文字列を指定してください。");
      template = config.path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  template ||= "_notes/{sessionId}/note.md";
  return expandPath(cwd, template, sessionId);
}

export default function noteExtension(pi: ExtensionAPI) {
  let noteRun = false;
  let epoch = 0;
  let stopped = false;

  // レンダラーだけを差し替え、ツールの実行や guard の判定には介入しない。
  // resolver はツール行の生成時に呼ばれるため、その時点でノート化中かを固定する。
  pi.registerToolRenderer((_name, next) => {
    if (!noteRun) return next();
    const empty = () => ({ render: () => [], invalidate: () => {} });
    return {
      renderShell: "self",
      renderCall: empty,
      renderResult(result, _options, _theme, context) {
        if (!context.isError) return empty();
        const message = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n") || "ノート作成中のツール実行に失敗しました。";
        return { render: (width: number) => message.split("\n").map((line) => line.slice(0, width)), invalidate: () => {} };
      },
    };
  });

  const requestNote = async (ctx: ExtensionContext, manual = false) => {
    const requestEpoch = ++epoch;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = notePath(ctx.cwd, sessionId);
      const factory = manual ? factoryPaths(ctx.cwd, sessionId, path) : undefined;
      const extras = manual ? extraDocuments(ctx.cwd, sessionId, [path, ...Object.values(factory ?? {})]) : [];
      const procedure = await readFile(resolve(packageRoot, "procedure.md"), "utf8");
      const factoryProcedure = factory ? await readFile(resolve(packageRoot, "factory-procedure.md"), "utf8") : "";
      // 読み込み中の入力・セッション切替・重複依頼で古い依頼を無効にする。
      if (stopped || epoch !== requestEpoch) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        if (manual) ctx.ui.notify("待機中の処理が終わってから /note を実行してください。", "warning");
        return;
      }
      const source = {
        sessionId,
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        cwd: ctx.cwd,
        recordedAt: new Date().toISOString(),
      };
      for (const dir of new Set([path, ...Object.values(factory ?? {}), ...extras.map(extra => extra.path)].map(dirname))) {
        pi.events.emit("guard:trust-dir", { path: dir, by: "note" });
      }
      // custom message として送り、ユーザーの相談とノート化の実行を区別する。
      pi.sendMessage({
        customType: noteMessageType,
        // 手順全文はモデルへ渡すが、チャット画面には表示しない。
        display: false,
        content: [
          "ここまでの会話を、次の手順に従ってノートとして実際に保存してください。",
          "保存後の報告は、成功なら『ノートを更新しました。』の一文だけにしてください。失敗時は理由を短く報告してください。",
          `保存先ファイル（絶対パス）: ${JSON.stringify(path)}`,
          `記録元メタデータ: ${JSON.stringify(source)}`,
          "",
          procedure,
          ...(factory ? ["", `Factory 保存先（絶対パス）: ${JSON.stringify(factory)}`, factoryProcedure] : []),
          ...(extras.length ? ["", `追加ノート（絶対パスと記録内容）: ${JSON.stringify(extras)}`,
            "通常ノートに加え、各追加ノートは指定された記録内容に該当する情報がある場合だけ更新してください。既存ファイルは全文を読み、既存の文脈と出典を保持してください。指定されたファイル以外は変更せず、記録元メタデータを残してください。複数ファイルの保存に失敗した場合は結果を正確に報告してください。"] : []),
        ].join("\n"),
      }, { triggerTurn: true });
    } catch (error) {
      ctx.ui.notify(`ノート作成を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    epoch++;
    noteRun = stopped = false;
    try {
      const path = notePath(ctx.cwd, ctx.sessionManager.getSessionId());
      pi.events.emit("guard:trust-dir", { path: dirname(path), by: "note" });
    } catch (error) {
      ctx.ui.notify(`ノートの保存先を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    epoch++;
  });
  pi.on("input", () => { epoch++; });
  pi.on("session_before_switch", () => { epoch++; });
  pi.on("session_before_fork", () => { epoch++; });
  pi.on("session_before_compact", () => { epoch++; });
  pi.on("session_before_tree", () => { epoch++; });
  pi.on("before_agent_start", (event) => {
    epoch++;
    noteRun = event.messageType === "custom" && event.message.customType === noteMessageType;
  });
  pi.on("agent_settled", async (event, ctx) => {
    const wasNoteRun = noteRun;
    noteRun = false;
    // 保存失敗や中断でも、自動リトライの無限ループにはしない。
    if (stopped || wasNoteRun || event.aborted) return;
    await requestNote(ctx);
  });

  pi.registerCommand("note", {
    description: "現在のセッションの会話を今すぐノートに記録する",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("使い方: /note（保存先は session ID で固定です）", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("処理が落ち着いてから /note を実行してください。", "warning");
        return;
      }
      await requestNote(ctx, true);
    },
  });
}
