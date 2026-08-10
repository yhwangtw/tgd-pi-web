import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectSessionImport } from "../session-import";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-import-test-"));
  roots.push(root);
  const project = path.join(root, "project");
  const destination = path.join(root, "sessions");
  mkdirSync(project);
  mkdirSync(destination);
  const source = path.join(project, "import.jsonl");
  writeFileSync(source, [
    JSON.stringify({ type: "session", version: 3, id: "import-session-1", timestamp: "2026-08-10T00:00:00.000Z", cwd: project }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "session_info", id: "n1", parentId: "m1", name: "Imported session" }),
  ].join("\n") + "\n");
  return { root, project, destination, source };
}

describe("session import validation", () => {
  it("previews a valid Pi JSONL file inside an allowed project", async () => {
    const { project, destination, source } = fixture();

    await expect(inspectSessionImport(source, new Set([project]), destination)).resolves.toMatchObject({
      sourcePath: realpathSync(source),
      sessionId: "import-session-1",
      cwd: realpathSync(project),
      name: "Imported session",
      messageCount: 1,
      destinationPath: path.join(destination, "import.jsonl"),
    });
  });

  it("rejects sources outside allowed roots and symlinks that escape them", async () => {
    const { root, project, destination } = fixture();
    const outside = path.join(root, "outside.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session", version: 3, id: "outside", cwd: project }) + "\n");
    const link = path.join(project, "linked.jsonl");
    symlinkSync(outside, link);

    await expect(inspectSessionImport(outside, new Set([project]), destination))
      .rejects.toThrow("outside the allowed project roots");
    await expect(inspectSessionImport(link, new Set([project]), destination))
      .rejects.toThrow("outside the allowed project roots");
  });

  it("requires an allowed cwd override when the recorded cwd is unavailable", async () => {
    const { project, destination, source } = fixture();
    writeFileSync(source, JSON.stringify({
      type: "session",
      version: 3,
      id: "missing-cwd",
      cwd: path.join(project, "missing"),
    }) + "\n");

    await expect(inspectSessionImport(source, new Set([project]), destination))
      .rejects.toThrow("provide an allowed CWD override");
    await expect(inspectSessionImport(source, new Set([project]), destination, project))
      .resolves.toMatchObject({ cwd: realpathSync(project), headerCwd: path.join(project, "missing") });
  });

  it("refuses to overwrite an existing destination session", async () => {
    const { project, destination, source } = fixture();
    writeFileSync(path.join(destination, "import.jsonl"), "existing\n");

    await expect(inspectSessionImport(source, new Set([project]), destination))
      .rejects.toThrow("already exists in the destination");
  });
});
