// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@/lib/types";
import type { ModelCatalogEntry } from "@/lib/model-catalog-types";
import { setLocale } from "@/lib/i18n";
import { useChatInputControls } from "../useChatInputControls";
import { useCommandPalette, type CommandPaletteApi } from "../useCommandPalette";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noSessions: SessionInfo[] = [];
const noTags = {};
const selected = { provider: "p1", modelId: "model-1" };
let root: Root;
let host: HTMLDivElement;
let controls: ReturnType<typeof useChatInputControls>;
let palette: CommandPaletteApi;
function Harness({ modelList, sessions = noSessions }: { modelList?: ModelCatalogEntry[]; sessions?: SessionInfo[] }) {
  const nextControls = useChatInputControls({ model: selected, modelList });
  const nextPalette = useCommandPalette({ sessions, tags: noTags });
  useLayoutEffect(() => { controls = nextControls; palette = nextPalette; });
  return null;
}
beforeEach(() => { setLocale("en"); host = document.createElement("div"); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); setLocale("en"); });

it("reuses model catalog derivation while a composer draft changes", async () => {
  const readName = vi.fn((i: number) => `Model ${i}`);
  const modelList = Array.from({ length: 1_000 }, (_, i) => ({ id: `model-${i}`, provider: `p${i % 100}`, get name() { return readName(i); } }));
  await act(async () => root.render(<Harness modelList={modelList} />));
  expect(readName).toHaveBeenCalledTimes(1_000);
  const before = controls;
  for (let i = 0; i < 10; i++) await act(async () => root.render(<Harness modelList={modelList} />));
  expect(readName).toHaveBeenCalledTimes(1_000);
  expect(controls.modelOptions).toBe(before.modelOptions);
  expect(controls.modelsByProvider).toBe(before.modelsByProvider);
  expect(controls.modelsByProvider).toHaveLength(100);
  expect(controls.modelsByProvider[0].options.map(option => option.modelId)).toEqual(Array.from({ length: 10 }, (_, i) => `model-${i * 100}`));
  expect(controls.currentName).toBe("Model 1");
  const replacement = [...modelList, { id: "new", provider: "new-provider", name: "New model" }];
  await act(async () => root.render(<Harness modelList={replacement} />));
  expect(controls.modelOptions).toHaveLength(1_001);
});

function session(i: number, name = `qz-${i}`): SessionInfo {
  return { id: `s${i}`, path: "", cwd: "/workspace", created: "", modified: "", messageCount: 1, firstMessage: "", name };
}

describe("command palette indexed search", () => {
  it("builds session metadata once, compiles one matcher per query, and keeps stable top-50 ties", async () => {
    const readName = vi.fn((i: number) => `qz-${i}`);
    const sessions = Array.from({ length: 2_000 }, (_, i) => ({ ...session(i), get name() { return readName(i); } }));
    await act(async () => root.render(<Harness sessions={sessions} />));
    const metadataReads = readName.mock.calls.length;
    const NativeRegExp = RegExp;
    const compiled: string[] = [];
    vi.stubGlobal("RegExp", new Proxy(NativeRegExp, {
      construct(target, args, newTarget) {
        if (typeof args[0] === "string" && args[0].startsWith("(?:^|\\b|[/_-])")) compiled.push(args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    }));
    await act(async () => palette.setQuery("qz-"));
    expect(palette.results.map(result => result.id)).toEqual(Array.from({ length: 50 }, (_, i) => `session:s${i}`));
    expect(compiled).toHaveLength(1);
    await act(async () => palette.setQuery("qz-7"));
    expect(palette.results[0].id).toBe("session:s7");
    expect(compiled).toHaveLength(2);
    expect(readName).toHaveBeenCalledTimes(metadataReads);
  });

  it("escapes literal search characters and rebuilds metadata after source changes", async () => {
    const sessions = [session(0, "qz[1]"), session(1, "qz1"), session(2, "qz[1] more")];
    await act(async () => root.render(<Harness sessions={sessions} />));
    await act(async () => palette.setQuery("  qz[1]  "));
    expect(palette.results.map(result => result.id)).toEqual(["session:s0", "session:s2"]);
    await act(async () => root.render(<Harness sessions={[...sessions, session(3, "qz[1]")]} />));
    expect(palette.results.map(result => result.id)).toEqual(["session:s0", "session:s3", "session:s2"]);
  });
});
