import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnifiedSearchResults } from "@/components/layout/UnifiedSearchResults";

describe("search result visibility", () => {
  it("renders all bounded API results without a second silent client cap", () => {
    const files = Array.from({ length: 70 }, (_, index) => ({ name: `probe${index}.ts`, relative: `src/probe${index}.ts`, full: `/project/src/probe${index}.ts`, isDir: false }));
    const content = Array.from({ length: 90 }, (_, index) => ({ relative: "src/probe.ts", full: "/project/src/probe.ts", line: index + 1, col: 1, text: "probe" }));
    const html = renderToStaticMarkup(<UnifiedSearchResults
      query="probe" loading={false} visibleResultCount={160}
      showFiles showContent showSessions={false} showCommands={false} showSemantic={false}
      sessionHits={[]} fileHits={files} contentHits={content} semanticHits={[]}
      tagResults={[]} commandResults={[]} workspaceIdentities={{}}
      inputRef={{ current: null }} onPaletteResult={() => {}} onSelectSession={() => {}} onOpenFile={() => {}}
    />);
    expect(html.match(/data-search-result=/g)).toHaveLength(160);
    expect(html).toContain("probe69.ts");
    expect(html).toContain("src/probe.ts:90");
  });
});
