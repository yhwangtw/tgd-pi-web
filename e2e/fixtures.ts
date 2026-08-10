import { mkdirSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";

/**
 * Generates the E2E world under `root`:
 *
 *   <root>/demo-project        git repo with one committed + one modified +
 *                              two untracked files (drives git badges / diff)
 *   <root>/agent/sessions/...  pi session fixtures whose cwd points at the
 *                              demo project (drives every chat/nav spec)
 *
 * The server under test runs with PI_CODING_AGENT_DIR=<root>/agent, so these
 * are the only sessions it sees. Regenerated from scratch on every run —
 * specs may freely mutate session files.
 */
export function createFixtures(root: string): { cwd: string } {
  rmSync(root, { recursive: true, force: true });
  const cwd = path.join(root, "demo-project");
  mkdirSync(path.join(cwd, "src"), { recursive: true });

  // ── Demo git project ──────────────────────────────────────────────────
  writeFileSync(path.join(cwd, "README.md"), "# Demo project\n\nE2E fixture.\n");
  writeFileSync(path.join(cwd, "src/index.ts"), "export const answer = 42;\n");
  writeFileSync(path.join(cwd, "data.json"), JSON.stringify({ project: "demo", features: { viewer: true, mobile: true }, count: 2 }, null, 2) + "\n");
  writeFileSync(path.join(cwd, "table.csv"), "name,status,count\nAlpha,active,2\nBeta,paused,10\n");
  writeFileSync(path.join(cwd, "sample.bin"), Buffer.from([0x50, 0x69, 0x00, 0x57, 0x65, 0x62]));
  mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".pi", "extensions", "web-ui.js"),
    [
      "export default function webUiExtension(pi) {",
      "  pi.on(\"session_start\", async (_event, ctx) => {",
      "    ctx.ui.setTitle(\"Extension UI E2E\");",
      "    ctx.ui.setStatus(\"e2e\", \"Extension loaded\");",
      "    ctx.ui.setWidget(\"e2e\", [\"Browser-backed extension UI is ready.\"]);",
      "  });",
      "  pi.registerCommand(\"e2e-ui\", {",
      "    description: \"Exercise browser-backed extension dialogs\",",
      "    handler: async (_args, ctx) => {",
      "      ctx.ui.setStatus(\"e2e\", \"Waiting for decisions\");",
      "      const target = await ctx.ui.select(\"Choose a release target\", [\"Staging\", \"Production\"]);",
      "      if (!target) return;",
      "      const confirmed = await ctx.ui.confirm(\"Confirm release\", \"Continue with \" + target + \"?\");",
      "      if (!confirmed) return;",
      "      const owner = await ctx.ui.input(\"Release owner\", \"Type a name…\");",
      "      if (!owner) return;",
      "      const notes = await ctx.ui.editor(\"Release notes\", \"Validated in the web UI.\");",
      "      if (!notes) return;",
      "      ctx.ui.setStatus(\"e2e\", \"Complete\");",
      "      ctx.ui.setWidget(\"e2e\", [target + \" · \" + owner], { placement: \"belowEditor\" });",
      "      ctx.ui.setEditorText(\"Release \" + target.toLowerCase() + \" when ready.\");",
      "      ctx.ui.notify(\"Saved \" + notes.split(\"\\n\").length + \" line(s) for \" + owner, \"info\");",
      "    },",
      "  });",
      "  pi.registerCommand(\"e2e-new\", {",
      "    description: \"Create a replacement session through AgentSessionRuntime\",",
      "    handler: async (_args, ctx) => {",
      "      const parentSession = ctx.sessionManager.getSessionFile();",
      "      await ctx.newSession({",
      "        parentSession,",
      "        setup: async (manager) => {",
      "          manager.appendSessionInfo(\"Runtime new session\");",
      "        },",
      "        withSession: async (next) => {",
      "          next.ui.setStatus(\"runtime-e2e\", \"New session ready\");",
      "        },",
      "      });",
      "    },",
      "  });",
      "  pi.registerCommand(\"e2e-fork\", {",
      "    description: \"Fork through AgentSessionRuntime\",",
      "    handler: async (args, ctx) => {",
      "      await ctx.fork(args.trim(), {",
      "        withSession: async (next) => {",
      "          next.ui.setStatus(\"runtime-e2e\", \"Fork ready\");",
      "        },",
      "      });",
      "    },",
      "  });",
      "  pi.registerCommand(\"e2e-switch\", {",
      "    description: \"Switch through AgentSessionRuntime\",",
      "    handler: async (args, ctx) => {",
      "      let target = args.trim();",
      "      if (target.startsWith('\\\"') && target.endsWith('\\\"')) target = JSON.parse(target);",
      "      await ctx.switchSession(target, {",
      "        withSession: async (next) => {",
      "          next.ui.setStatus(\"runtime-e2e\", \"Switch ready\");",
      "        },",
      "      });",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(cwd, "importable-session.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "99991111-2222-3333-4444-555566667777", timestamp: "2026-07-08T10:00:00.000Z", cwd }),
      JSON.stringify({ type: "message", id: "i1000001", parentId: null, timestamp: "2026-07-08T10:00:05.000Z", message: { role: "user", content: "Imported from a project JSONL file", timestamp: 1751968805000 } }),
      JSON.stringify({ type: "message", id: "i1000002", parentId: "i1000001", timestamp: "2026-07-08T10:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "Import preview and runtime replacement verified." }], timestamp: 1751968810000 } }),
      JSON.stringify({ type: "session_info", id: "i1000003", parentId: "i1000002", name: "Imported runtime session" }),
    ].join("\n") + "\n",
  );
  const git = (args: string) =>
    execSync(`git -c user.email=e2e@test -c user.name=e2e ${args}`, { cwd, stdio: "pipe" });
  git("init -q");
  git("add -A");
  git('commit -qm "initial"');
  // Linked worktree — drives the CwdPicker worktree rows
  git(`worktree add -q ${JSON.stringify(path.join(root, "demo-project-wt"))} -b feature-wt`);
  // Working-tree state: one modified, two untracked
  writeFileSync(path.join(cwd, "src/index.ts"), "export const answer = 43; // modified\n");
  writeFileSync(path.join(cwd, "from-bash.txt"), "bash-made\n");
  writeFileSync(path.join(cwd, "newfile.txt"), "hello\n");
  // Large file (>1500 lines) — drives the viewer's plain-mode fallback
  const bigLines = ["// big generated file"];
  for (let i = 0; i < 2000; i++) {
    bigLines.push(`export const item${i} = { id: ${i}, value: ${(i * 7) % 997} };`);
  }
  writeFileSync(path.join(cwd, "big-file.ts"), bigLines.join("\n") + "\n");

  // ── tGD artifacts sibling dir (`<project>-tGD/`) ──────────────────────
  const tgdDir = path.join(root, "demo-project-tGD");
  mkdirSync(path.join(tgdDir, "user-login", "prototype"), { recursive: true });
  mkdirSync(path.join(tgdDir, ".scans", "demo"), { recursive: true });
  mkdirSync(path.join(tgdDir, "wiki"), { recursive: true });
  writeFileSync(path.join(tgdDir, "CONTEXT.md"), "# Project Context\n\nA demo project.\n");
  writeFileSync(path.join(tgdDir, "TRACKING-PLAN.md"), "# Tracking Plan\n\n- event: login_success\n");
  writeFileSync(path.join(tgdDir, "wiki", "wiki.html"), "<!doctype html><h1>Wiki</h1>");
  writeFileSync(path.join(tgdDir, "user-login", "PRD.md"), "# PRD: user-login\n\n## 1. Objectives\n登入功能。\n");
  writeFileSync(path.join(tgdDir, "user-login", "SPEC.md"), "# SPEC: user-login\n\n## API\nPOST /api/auth/login\n");
  writeFileSync(path.join(tgdDir, "user-login", "DESIGN.md"), "# DESIGN\n\n## Component Tree\n- LoginForm\n");
  writeFileSync(path.join(tgdDir, "user-login", "TASKS.md"), "# TASKS\n\n### Task 1\n建立 endpoint。\n");
  writeFileSync(path.join(tgdDir, "user-login", "prototype", "variant-a.html"), "<!doctype html><title>proto</title><h1>Login mock</h1>");
  writeFileSync(path.join(tgdDir, ".scans", "demo", "index.txt"), "excluded infra\n");

  // ── Session fixtures ──────────────────────────────────────────────────
  const sessionsDir = path.join(root, "agent", "sessions", "-demo");
  mkdirSync(sessionsDir, { recursive: true });

  const filler = "內容填充讓訊息變長,測試捲動行為。".repeat(6);
  const longText = Array.from({ length: 8 }, (_, i) =>
    `### 重構步驟 ${i + 1}\n\n這是第 ${i + 1} 段詳細說明。${filler}`,
  ).join("\n\n");

  const mainLines = [
    { type: "session", version: 3, id: "aaaa1111-2222-3333-4444-555566667777", timestamp: "2026-07-01T10:00:00.000Z", cwd },
    { type: "model_change", id: "a1b2c3d4", parentId: null, provider: "anthropic", modelId: "claude-sonnet-5", timestamp: "2026-07-01T10:00:01.000Z" },
    { type: "message", id: "m1000001", parentId: "a1b2c3d4", timestamp: "2026-07-01T10:00:05.000Z", message: { role: "user", content: "幫我看一下這個專案的架構,並解釋主要模組之間的關係", timestamp: 1751364005000 } },
    { type: "message", id: "m1000002", parentId: "m1000001", timestamp: "2026-07-01T10:00:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "好的,這個專案是一個典型的三層架構:\n\n## 架構總覽\n\n```\nAPI Layer → Service Layer → Data Layer\n```\n\n主要模組:`api/`、`services/`、`repositories/`。" }], usage: { input: 1200, output: 350, cacheRead: 0, cacheWrite: 0, cost: { total: 0.012 } }, timestamp: 1751364030000 } },
    { type: "session_info", id: "si000001", parentId: "m1000002", name: "專案架構分析" },
    { type: "message", id: "m1000003", parentId: "si000001", timestamp: "2026-07-01T10:05:00.000Z", message: { role: "user", content: "services 層有沒有需要重構的地方?", timestamp: 1751364300000 } },
    { type: "message", id: "m1000004", parentId: "m1000003", timestamp: "2026-07-01T10:05:40.000Z", message: { role: "assistant", content: [{ type: "text", text: "有三個值得重構的點:God class、循環依賴、重複邏輯。" }], usage: { input: 1800, output: 220, cacheRead: 800, cacheWrite: 0, cost: { total: 0.009 } }, timestamp: 1751364340000 } },
    { type: "message", id: "m1000005", parentId: "m1000004", timestamp: "2026-07-01T10:10:00.000Z", message: { role: "user", content: "給我詳細的重構步驟", timestamp: 1751364600000 } },
    { type: "message", id: "m1000006", parentId: "m1000005", timestamp: "2026-07-01T10:11:00.000Z", message: { role: "assistant", content: [{ type: "text", text: longText }], usage: { input: 2500, output: 900, cacheRead: 1200, cacheWrite: 0, cost: { total: 0.02 } }, timestamp: 1751364660000 } },
    { type: "message", id: "m1000007", parentId: "m1000006", timestamp: "2026-07-01T10:15:00.000Z", message: { role: "user", content: "好,先從 God class 開始", timestamp: 1751364900000 } },
    { type: "message", id: "m1000008", parentId: "m1000007", timestamp: "2026-07-01T10:16:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "沒問題,我們從 `UserService` 開始拆分。第一步先把驗證邏輯抽到 `AuthService`。" }], usage: { input: 3000, output: 120, cacheRead: 2000, cacheWrite: 0, cost: { total: 0.01 } }, timestamp: 1751364960000 } },
  ];
  writeFileSync(
    path.join(sessionsDir, "2026-07-01T10-00-00_aaaa1111-2222-3333-4444-555566667777.jsonl"),
    mainLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );

  const errorLines = [
    { type: "session", version: 3, id: "eeee1111-2222-3333-4444-555566667777", timestamp: "2026-07-04T10:00:00.000Z", cwd },
    { type: "model_change", id: "aa000001", parentId: null, provider: "anthropic", modelId: "claude-opus-4-6", timestamp: "2026-07-04T10:00:00.000Z" },
    { type: "message", id: "aa000002", parentId: "aa000001", timestamp: "2026-07-04T10:00:05.000Z", message: { role: "user", content: "幫我解釋這個專案的 rate limiter", timestamp: 1751623200000 } },
    { type: "message", id: "aa000003", parentId: "aa000002", timestamp: "2026-07-04T10:00:10.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate_limit_error: This request would exceed your account's rate limit", usage: { input: 0, output: 0 }, timestamp: 1751623210000 } },
    { type: "session_info", id: "aa000004", parentId: "aa000003", name: "失敗的執行" },
  ];
  writeFileSync(
    path.join(sessionsDir, "2026-07-04T10-00-00_eeee1111-2222-3333-4444-555566667777.jsonl"),
    errorLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );

  // Tool-call session — drives the edit/write diff-view spec
  const toolLines = [
    { type: "session", version: 3, id: "ffff1111-2222-3333-4444-555566667777", timestamp: "2026-07-05T11:00:00.000Z", cwd },
    { type: "model_change", id: "e1000001", parentId: null, provider: "anthropic", modelId: "claude-sonnet-5", timestamp: "2026-07-05T11:00:00.000Z" },
    { type: "message", id: "e1000002", parentId: "e1000001", timestamp: "2026-07-05T11:00:05.000Z", message: { role: "user", content: "把 answer 改成 100 並新增一個 utils 檔", timestamp: 1751713205000 } },
    { type: "message", id: "e1000003", parentId: "e1000002", timestamp: "2026-07-05T11:00:20.000Z", message: { role: "assistant", content: [
      { type: "thinking", thinking: "Inspect the relevant files before editing." },
      { type: "text", text: "好,我先改 `src/index.ts`,再新增 `src/utils.ts`。" },
      { type: "toolCall", id: "tc_edit_1", name: "edit", arguments: { path: "src/index.ts", oldText: "export const answer = 42;", newText: "export const answer = 100;\n// clamped" } },
      { type: "toolCall", id: "tc_write_1", name: "write", arguments: { path: "src/utils.ts", content: "export function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n" } },
    ], usage: { input: 900, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.008 } }, timestamp: 1751713220000 } },
    { type: "message", id: "e1000004", parentId: "e1000003", timestamp: "2026-07-05T11:00:22.000Z", message: { role: "toolResult", toolCallId: "tc_edit_1", content: [{ type: "text", text: "Edited src/index.ts" }], timestamp: 1751713222000 } },
    { type: "message", id: "e1000005", parentId: "e1000004", timestamp: "2026-07-05T11:00:24.000Z", message: { role: "toolResult", toolCallId: "tc_write_1", content: [{ type: "text", text: "Wrote src/utils.ts (3 lines)" }], timestamp: 1751713224000 } },
    { type: "message", id: "e1000006", parentId: "e1000005", timestamp: "2026-07-05T11:00:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "完成:`answer` 改為 100,`src/utils.ts` 新增 `clamp`。" }], usage: { input: 1300, output: 80, cacheRead: 900, cacheWrite: 0, cost: { total: 0.005 } }, timestamp: 1751713230000 } },
    { type: "session_info", id: "e1000007", parentId: "e1000006", name: "工具呼叫測試" },
  ];
  writeFileSync(
    path.join(sessionsDir, "2026-07-05T11-00-00_ffff1111-2222-3333-4444-555566667777.jsonl"),
    toolLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );

  // tGD-workflow session — ran /tgd-map, /tgd-define, /tgd-plan, so the pipeline
  // shows map+define done and plan current.
  const tgdLines = [
    { type: "session", version: 3, id: "dddd1111-2222-3333-4444-555566667777", timestamp: "2026-07-06T09:00:00.000Z", cwd },
    { type: "message", id: "t1000001", parentId: null, timestamp: "2026-07-06T09:00:05.000Z", message: { role: "user", content: "/tgd-map 理解這個專案", timestamp: 1751792405000 } },
    { type: "message", id: "t1000002", parentId: "t1000001", timestamp: "2026-07-06T09:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "已盤點程式庫結構。" }], timestamp: 1751792460000 } },
    { type: "session_info", id: "t1000003", parentId: "t1000002", name: "tGD 流程測試" },
    { type: "message", id: "t1000004", parentId: "t1000003", timestamp: "2026-07-06T09:05:00.000Z", message: { role: "user", content: "/tgd-define 撰寫 PRD", timestamp: 1751792700000 } },
    { type: "message", id: "t1000005", parentId: "t1000004", timestamp: "2026-07-06T09:06:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "PRD 草稿完成。" }], timestamp: 1751792760000 } },
    { type: "message", id: "t1000006", parentId: "t1000005", timestamp: "2026-07-06T09:10:00.000Z", message: { role: "user", content: "/tgd-plan 拆解任務", timestamp: 1751793000000 } },
    { type: "message", id: "t1000007", parentId: "t1000006", timestamp: "2026-07-06T09:11:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "任務清單就緒。" }], timestamp: 1751793060000 } },
  ];
  writeFileSync(
    path.join(sessionsDir, "2026-07-06T09-00-00_dddd1111-2222-3333-4444-555566667777.jsonl"),
    tgdLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );

  return { cwd };
}
