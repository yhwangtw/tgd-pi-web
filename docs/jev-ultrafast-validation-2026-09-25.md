# Browser Use Jev Ultrafast / Pi Web validation — 2026-09-25

## Scope and environment

- Browser agent: [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast) at `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`, with Browser Harness `0.1.13` and TypeSafe Jev. It ran in a dedicated headless Chrome profile. This is separate from the `pi-web-jev` Codex skill and from Jev Browser Control.
- Application: isolated Pi Web fixture on `127.0.0.1:30179`, `PIWEB_ENVIRONMENT=fixture`, version `2026.09.21`, source `a8539ec8ecf75267dd04dd6665d57026b079f4ca`. Generated E2E sessions and a generated project were the only browser data sent to Jev. The production service on `127.0.0.1:30141` returned HTTP 200 with the same version and source SHA; no real production session was given to Jev.
- Method: one natural-language goal per run, a maximum of 8–10 actions for each scenario, then independent DOM/value/URL readback. Mobile ran at 390 × 844. A `DONE` prediction alone did not count as a pass.

## Results

| Surface | Result | Independent evidence |
| --- | --- | --- |
| Primary navigation | Passed | Jev opened Attention, Agents, Schedules, Explorer, Search, Changes, and tGD artifacts; each selected rail button reported `aria-pressed=true`. Analytics, Models, Skills, Extensions, and Appearance opened their respective panels/dialogs after settling. |
| Conversations | Passed | Jev selected the generated `專案架構分析` session; URL changed to its fixture session ID and its messages appeared. It used the minimap to move the transcript from `scrollTop=716` to `6`. |
| File diff | Passed | Jev opened Changes → `src/index.ts`; the viewer showed the `42` → `43` line change. |
| tGD and Extensions | Passed | Jev switched tGD to Files; it opened Extensions → Packages, Runtime, MCP, and Security. The matching panel content was present. |
| Settings and forms | Passed within tested scope | Appearance → Dark set `html.className=dark`. New schedule → Daily showed the active class, removed the date input, and displayed one time input. Models closed through Cancel; Skills closed through Close. No schedule or provider was saved. |
| Agent concurrency | Passed | Jev selected four concurrent agent slots. The selector showed `4`, and a fresh `GET /api/agent-runs` returned `maxConcurrency: 4` in fixture data. Subagent budgets opened without changes. |
| Search filter | Passed | Jev expanded Conversation filters and selected Date → Last 7 days; a fresh DOM read returned `value=7d`. A less explicit Date-filter goal had stopped early, so the panel-expansion step matters. |
| Goal / Plan command picker | Passed with local setup | A local Chrome input action opened the slash menu, then Jev selected `/goal` and `/plan`. The resulting unsent drafts were `/goal ` and `/plan `. Jev did not generate the slash prefix because the separate text-model provider failed. |
| Mobile navigation | Passed when unobstructed | Jev clicked Search at 390 × 844, and the Search panel rendered in the DOM. A separately open file panel can obscure it; see the issue below. |

## Findings

1. **Mobile file viewer obscures a newly selected section (Pi Web bug).** On a clean fixture origin, open Files and `README.md`, then tap Search at 390 × 844. Search becomes selected and `Unified search` exists in the DOM, but the full-screen file panel remains in front (`document.elementFromPoint(200, 200)` belongs to the file panel). Jev can repeatedly tap Search without revealing it. [Screenshot](jev-ultrafast-mobile-file-search.jpg). `handleRailView` changes the contextual view but does not close the right panel; the phone CSS fixes that panel above the view. Hiding the file panel exposes the underlying interface. Suggested fix: on phone navigation to a different primary section, close the file panel or make the selected section the visible top layer, then add a mobile regression test.
2. **Explorer file rows are outside Jev Ultrafast's current action space (tool coverage gap).** `README.md` is a visible `role=treeitem` with `tabindex=-1`, but Jev's indexed actions omit it. The agent clicked Explorer repeatedly instead of opening the file. A direct Chrome pointer click on the same row opened the file viewer, so the application file action works. Browser Use documents custom keyboard widgets as outside this MVP. A Jev integration would need treeitem support or a browser-control fallback.
3. **`TYPE_TEXT` was not available in this run (provider blocker).** Jev's TypeSafe action picker worked, but its separate text helper received HTTP 429 from the available Z.AI general endpoint and HTTP 401 from the available ModelArk endpoint; in both cases the project raised before typing. Therefore search text, prompt sending, schedule creation, naming, and other text-dependent flows were not end-to-end verified by Jev. No further provider retries were made.
4. **The schedule frequency's selected state is visual-only (accessibility/agent issue).** The Once/Daily/Weekly/Cron buttons use an active CSS class without `aria-pressed` or radio semantics in `SchedulePanel.tsx`. The Daily change was verified through form structure, but assistive technology and DOM agents do not get a direct selected-state signal.

## Boundaries

- The public `https://pi.yhwangtw.com/` returned a Cloudflare Access HTTP 302 to login; authenticated public UI was not tested in Chrome. The local production identity was checked separately.
- Uploads, frames, shadow roots, canvas, pop-up tabs, arbitrary keyboard shortcuts, and nested scrolling are documented limitations of Jev Ultrafast. They were not claimed as passing. No real session, purchase, deletion, external message, or production configuration was changed.
- These runs demonstrate individual operations and the specific UI scenarios above. They do not establish the repository's broad speed/reliability claims for Pi Web.

## Repair follow-up (2026-09-25)

- Phone primary navigation now closes the file viewer when it covers the selected section. The existing Files section reopens on the first tap, and switching to Search exposes the search panel. The 320 px browser regression passed both paths.
- Explorer rows retain their tree semantics and now expose a named button for the primary open/expand action. The official `jev-ultrafast` snapshot listed `README.md` as one click action; clicking its returned coordinates opened the fixture file and displayed its contents.
- Schedule frequency buttons now report `aria-pressed` according to the active selection. A browser regression verified Daily → Once updates both states.
- TypeScript and targeted lint passed. The isolated production build and two targeted browser tests passed. Across the complete isolated unit run, 1,389 tests passed and one backup test failed only because the system disk temporarily fell below its 512 MiB safety threshold; that test then passed on rerun after free space recovered.
- The `TYPE_TEXT` provider limitation remains: TypeSafe Jev does not generate arbitrary text, and the configured text-model attempts returned HTTP 429/401. Text-dependent end-to-end browser flows still need a working, authorized text-model endpoint and fresh verification. No live deployment is implied by this follow-up.
