# tGD Pi Web

<p align="center">
  <a href="https://github.com/yhwangtw/tgd-pi-web/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yhwangtw/tgd-pi-web/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-TW.md"><strong>繁體中文</strong></a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <a href="https://github.com/yhwangtw/tgd-pi-web/releases">版本發布</a> ·
  <a href="https://github.com/yhwangtw/tgd-pi-web/issues">回報錯誤</a> ·
  <a href="https://github.com/yhwangtw/tgd-pi-web/issues">建議功能</a>
</p>

**為 Pi Coding Agent 與完整 tGD 交付流程打造的瀏覽器工作空間。**

tGD Pi Web 將 Pi 的本機 session 轉成視覺化工程駕駛艙：即時與 agent 對話、檢查檔案與 git 變更、切換分支、還原快照，並在同一個瀏覽器介面追蹤從 Map 到 Release 的完整工作。

![tGD Pi Web 對話介面](./docs/screenshots/02-hero-chat.png)

## 為什麼需要 tGD Pi Web？

Pi 的終端體驗快速而專注；這個專案補上長時間或多工作流任務所需要的視覺脈絡：

- 同時看到串流內容、執行狀態、經過時間、錯誤、排隊訊息與 context 壓力。
- 直接瀏覽所有本機 Pi session，不需要先建立 AgentSession。
- 在對話旁檢查檔案、diff、tool call 與 git 變更。
- 在同一工作空間追蹤 tGD artifacts 與七個交付階段。
- 透過搜尋、書籤、minimap 與分支導覽長篇對話。
- 在手機與桌機上使用 safe-area 導覽、精簡階段列及適合觸控的訊息操作。
- 保持本機優先：除了你設定的模型端點，應用程式執行時不會發出外部請求。

## 適合誰？

- 已經使用 [Pi Coding Agent](https://github.com/earendil-works/pi) 的開發者。
- 採用 tGD 流程，並把 artifacts 放在相鄰 `<project>-tGD/` 目錄的團隊。
- 希望 agent 在本機工作時，也能有瀏覽器檢視與控制介面的工程師。
- 使用內部模型 gateway 與 npm registry 的離線或企業環境。

## 快速開始

### 系統需求

- Node.js 22 以上
- npm
- 可正常運作的 Pi 環境與 `~/.pi/agent/`
- Git

本專案只透過 GitHub 原始碼發布，**不發布至 npm**。

> [!IMPORTANT]
> tGD Pi Web 能在允許的工作區讀寫檔案、檢查 git repository，並執行 shell 指令。預設只在 localhost 使用；若要遠端存取，請設定 `PIWEB_ACCESS_PASSWORD`，並放在具身分驗證的私人網路或 Access proxy 後方。詳見[部署指南](./deploy/README.md)。

正式支援的一步式安裝請使用獨立 checkout：

```bash
git clone https://github.com/yhwangtw/tgd-pi-web.git
cd tGD-pi-web
bash setup.sh
```

安裝腳本是正式支援的一步式 production 流程。Git checkout 會先用 `origin/main` 取代本地原始碼，再檢查 Node.js 與 npm、安裝相依套件、執行 TypeScript 驗證、建立 production build，並可選擇啟動 production server。若使用原始碼壓縮檔，已知的舊版殘留會先移至 `~/.tgd-pi-web-backups/`（可用 `TGD_SETUP_BACKUP_DIR` 覆寫）。

> [!WARNING]
> 一般使用者的 Git 安裝以 `origin/main` 為唯一真相。執行 `bash setup.sh` 會透過 `git reset --hard origin/main` 與 `git clean -fd` 放棄本地 commit、tracked 修改及未被 ignore 的 untracked 檔案；`.env`、`node_modules`、`.next` 等 ignored runtime 狀態會保留。

手動安裝：

```bash
npm install
npm run build
npm start
```

開啟 [http://localhost:30141](http://localhost:30141)。

### 更新現有 checkout

```bash
bash setup.sh
```

TypeScript 驗證失敗時，`setup.sh` 會顯示完整錯誤並立即停止，不會繼續產生容易誤判的部分 build。

若 Git checkout 必須刻意離線使用，可明確跳過遠端同步：

```bash
TGD_SETUP_OFFLINE=1 bash setup.sh
```

## 瀏覽器內的 tGD 流程

階段列會固定顯示在目前 session 上方：

```text
Map → Define → Plan → Develop → Verify → Review → Release
```

- **以 artifacts 為準的狀態** — Map、Define、Plan 依照磁碟上的真實檔案判斷完成狀態，不使用樂觀 UI 狀態。
- **feature-aware 進度** — 階段列會追蹤最近 `/tgd-*` 指令指定的 feature；若沒有指定，則使用最近更新的 feature。
- **Artifact explorer** — 可檢視依階段整理的文件，或完整瀏覽相鄰 tGD 目錄，包括 scans、wiki 與 prototypes。
- **先預覽再送出的階段操作** — 點擊階段只會把對應指令填入輸入框，讓你確認後再送出。
- **Git 還原點** — 每次執行前建立 git-backed snapshot，不會碰觸你的 index 或 `HEAD`。

預期目錄結構：

```text
parent/
├── your-project/
└── your-project-tGD/
    ├── CONTEXT.md
    ├── TRACKING-PLAN.md
    ├── CHANGELOG.md
    ├── REGRESSION-CATALOG.md
    ├── wiki/
    └── feature-name/
        ├── PRD.md
        ├── SPEC.md
        ├── DESIGN.md
        ├── TASKS.md
        ├── TEST-REPORT.md
        ├── REVIEW.md
        ├── METRICS.md
        └── prototype/
```

若 artifacts 位於其他位置，可設定 `TGD_DIR`。

## 介面導覽

<p align="center">
  <img src="./docs/screenshots/11-mobile-chat.png" alt="手機版響應式對話介面" width="390">
</p>

手機版會在 safe area 內保留目前階段、對話、輸入框、模型控制與主要導覽，常用操作維持在拇指可及範圍。

| Session 與檔案工作區 | 指令面板 |
|---|---|
| ![程式碼 session](./docs/screenshots/03-code-session.png) | ![指令面板](./docs/screenshots/04-command-palette.png) |

| 深色模式 | 空白狀態 |
|---|---|
| ![深色模式](./docs/screenshots/10-dark-mode.png) | ![空白狀態](./docs/screenshots/01-empty-state.png) |

<details>
<summary><strong>查看全部五種外觀 skin</strong></summary>

| Editorial | Terminal | Aurora |
|---|---|---|
| ![Editorial skin](./docs/screenshots/05-skin-editorial.png) | ![Terminal skin](./docs/screenshots/06-skin-terminal.png) | ![Aurora skin](./docs/screenshots/07-skin-aurora.png) |

| Industrial | Glass |
|---|---|
| ![Industrial skin](./docs/screenshots/08-skin-industrial.png) | ![Glass skin](./docs/screenshots/09-skin-glass.png) |

</details>

## 主要功能

### Agent 對話

- 透過 SSE 即時串流，並在送出 prompt 前先建立事件連線。
- 支援 prompt、steer、follow-up queue、retry、bash 與 context compaction。
- 使用 `!command` 直接執行 shell；使用 `!!command` 讓結果不進入模型 context。
- 在 session 中途切換模型與 thinking level。
- 內建 `ask_user` 工具，並支援 Pi extension 的 `select`、`confirm`、`input`、`editor` 對話框、通知、狀態與文字 Widget；等待中的決定可跨斷線重連保留。
- Pi extension 的 session 指令（`newSession`、`fork`、`switchSession`）改由原生 `AgentSessionRuntime` 執行；Web UI 會跟隨替換後的 session，並將 SSE 重連至新 session。
- 替換失敗時會恢復原本的 runtime；目標 session 已被其他 runtime 使用時會在切換前拒絕，所有開啟中的分頁也會同步跟隨。Extensions 設定可查看即時 runtime 診斷。
- 可透過預覽優先的對話框匯入 Pi `.jsonl`；切換前會驗證 header、實際 cwd、允許的根目錄、symlink、檔案大小與目的地衝突。
- 每次執行都有錯誤卡、停滯警告、通知、完成音效與分頁狀態。
- 可編輯過去的 turn、從先前分支點 retry、建立獨立 fork，或在 session 內切換分支。

### Agent 排程

- 左側排程中心支援單次、每天、每週與標準五欄 cron，並明確指定 IANA 時區。
- 可設定專案、Prompt、模型、thinking level、工具權限、漏跑策略與啟用狀態；同一處即可暫停、恢復、立即執行、重試與查看歷史。
- 每次執行都會建立一般的本機 Pi session；若 `ask_user` 需要決定，狀態會變成**等待你的回答**，可直接開啟該 session 繼續。
- 排程由本機 Node server 執行，server 必須保持運作。重啟後會依設定補跑一次或略過，且同一排程不會重疊執行。

### Session 與導覽

- 以增量、唯讀方式索引本機 Pi `.jsonl` session 檔。
- 支援搜尋、標籤、釘選、封存、自動命名、HTML/Markdown 匯出與用量分析。
- 提供對話搜尋、user turn 導覽、書籤、minimap、長訊息收合與 always-follow 串流模式。
- Project switcher 支援最近專案、釘選、探索、檔案系統自動完成與 linked git worktrees。
- 可重複使用的 prompt templates，並與內建 `/tgd-*` 指令整合。

### 檔案與 git

- 專案樹、遞迴檔名搜尋、文字編輯、Markdown/HTML/圖片預覽，以及對話內可點擊的檔案路徑。
- Git 狀態 badge、working tree 摘要、逐檔統計，以及 `HEAD` 對 worktree diff。
- 將 `edit`、`write` tool call 顯示為實際 diff 或檔案內容，不顯示難讀的原始 JSON。
- 檔案與 git API 有 allowed-root、路徑防護、`execFile` 與回應大小限制。
- Snapshot restore 只套用精確差異，不會改寫使用者的 index 或 `HEAD`。

### 顯示與外觀

- GitHub Flavored Markdown、表格、task list、KaTeX、Mermaid 與延遲載入的語法高亮。
- Editorial、Terminal、Industrial、Aurora、Glass 五種 skin，各自支援亮色與暗色。
- 內建 Inter、JetBrains Mono 與 Noto Sans TC，不依賴 CDN。
- 應用程式介面語言目前為 English 與繁體中文；專案文件另外提供日本語與 Deutsch。

## 鍵盤快捷鍵

| 按鍵 | 動作 |
|---|---|
| `⌘/Ctrl + K` | 開啟指令面板 |
| `⌘/Ctrl + P` | 開啟 project switcher |
| `⌘/Ctrl + F` | 搜尋目前對話 |
| `⌥ + ↑` / `⌥ + ↓` | 上一個／下一個 user turn |
| `⇧⌘M` | 開啟 Models |
| `⌘/Ctrl + /` | 開啟 Skills |
| `⌘/Ctrl + B` | 切換 contextual panel |
| `⌘/Ctrl + \` | 切換右側檔案 panel |
| 空白輸入框按 `↑` | 叫回上一則訊息 |
| `Esc` | 關閉目前 dialog |

## 指令

| 指令 | 用途 |
|---|---|
| `bash setup.sh` | 以 `origin/main` 取代本地原始碼、驗證、安裝、build，並可選擇啟動 production |
| `npm run dev` | 視需要在 `30141` port 啟動開發環境 |
| `node_modules/.bin/tsc --noEmit` | Typecheck |
| `npx eslint .` | Lint |
| `npm test` | 執行 Vitest unit tests |
| `npm run test:e2e` | Build 並在 `30177` port 執行 Playwright E2E |
| `npm run build` | 建立 production build |
| `npm run start` | 啟動 production server |

> [!WARNING]
> 執行 `npm run build` 或 `npm run test:e2e` 前，必須先停止 `npm run dev`。同時執行 Next.js build 會污染開發伺服器使用中的 `.next/`。

Playwright 刻意不儲存在 `package.json`，需要臨時安裝：

```bash
npm i -D --no-save @playwright/test
npm run test:e2e
```

本機 container 若已預裝 Chromium：

```bash
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
```

## 設定

| 設定 | 行為 |
|---|---|
| `PI_CODING_AGENT_DIR` | 覆寫預設的 `~/.pi/agent` 目錄 |
| `PIWEB_ACCESS_PASSWORD` | 啟用套用於所有 route 的內建共用密碼閘門 |
| `TGD_DIR` | 覆寫相鄰的 `<project>-tGD/` artifact 目錄 |
| `models.json` | 模型與 provider 清單，包含自訂 `baseUrl` |
| `auth.json` | 由 Pi 管理的各 provider API credential |
| Project picker | 選擇並驗證目前 working directory |

Session 仍使用 Pi 原生格式：

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

## 架構

```text
Browser                    Next.js server             AgentSessionRuntime
  │                              │                            │
  ├─ GET /api/sessions ─────────▶│ incremental .jsonl cache   │
  ├─ POST /api/agent/[id] ──────▶│ startRpcSession() ────────▶│
  ├─ GET /events (SSE) ─────────▶│◀──── session events ───────│
  ├─ GET /api/files/* ──────────▶│ allowed-root file access   │
  ├─ GET /api/git/* ────────────▶│ guarded git inspection     │
  └─ GET /api/tgd/artifacts ────▶│ sibling tGD directory      │
```

唯讀瀏覽只解析 session 檔，不會建立 `AgentSession`。送出訊息時，伺服器才會為每個 active session 建立一個 in-process runtime wrapper，並透過 SSE 串流事件。Session 替換由 Pi 負責；wrapper 會把 cwd scoped services、extensions、registry key 與事件訂閱重綁至新的 `AgentSession`。

## 專案結構

```text
app/api/        sessions、agent commands/events、schedules、files、git、tGD、config
components/     layout、chat、sidebar、modals 與共用 UI
hooks/          agent orchestration、streaming、scrolling、sessions、theme
lib/            RPC lifecycle、scheduling、session parsing、security、i18n、snapshots
e2e/            Playwright production-server scenarios
docs/           screenshots 與專案文件
public/fonts/   內建本機字型
```

詳細架構、不變量與開發陷阱請參考 [`AGENTS.md`](./AGENTS.md)。

## 離線與隔離網路環境

瀏覽器應用程式本身不會在 runtime 發出外部請求，字型與 UI assets 都已內建；只有設定的 LLM endpoint 必須可連線。

- **內部 npm registry：** clone repository，或把 GitHub Release 原始碼壓縮檔解壓到乾淨目錄，設定內部 registry，再執行 `bash setup.sh`。只有需要 immutable CI-style 安裝時才使用 `npm ci && npm run build`。
- **可攜式目錄：** 在相同 OS 與架構的連網機器執行 `npm ci && npm run build`，複製完整目錄後執行 `npm run start`。
- **內部或本機模型：** 在 `models.json` 為 provider 設定自訂 `baseUrl`。

`npm ci` 保留給可重現的 CI 與離線 build；互動式開發使用 `npm install`。

## 常見問題

### 這個專案有發布成 npm package 嗎？

沒有。請從 GitHub repository 或 GitHub Release 原始碼壓縮檔安裝與更新。

### 它會取代 Pi 嗎？

不會。它是 Pi session 檔與 agent runtime 的本機瀏覽器介面；底層 coding agent 仍然是 Pi。

### 應用程式會上傳我的 session 嗎？

本專案沒有 hosted session backend。它讀取本機 Pi 檔案，並且只連線到你設定的模型或 provider endpoint。

### tGD Pi Web 關閉時，排程仍會執行嗎？

不會。排程器位於本機 Node server 內；要準時執行需保持 `npm start` 運作。重新啟動後，每個排程會依設定選擇**補跑一次**或**略過**。

### 為什麼 `package.json` 沒有 Playwright？

Playwright 的 transitive postinstall 可能下載瀏覽器 binary，導致離線或 Nexus 環境的 `npm ci` 失敗。因此 CI 會在 E2E 前用 `--no-save` 臨時安裝。

### 為什麼 compact 後的 session 檔仍然很長？

Compaction 會加入摘要並保留最近的訊息尾端，不會從 `.jsonl` 刪除原始歷史。介面會依照 Pi 的 active branch 與 compaction entry 顯示 context。

## 參與貢獻

歡迎 issue 與 pull request。

1. Fork repository 並建立範圍明確的 branch。
2. 開發時使用 `npm install`。
3. 執行 typecheck、lint 與 tests。
4. 行為改動需要新增或更新 tests。
5. 修改使用者可見的安裝方式或功能時，請同步四份 README。

應用程式翻譯位於 `lib/i18n.tsx`。新增 skin 時必須使用 semantic design tokens，不能在 component 硬編碼顏色。

## 發布

PR 通過 CI 並合併後，使用快速發版流程：

```bash
gh workflow run release.yml -f tag=vYYYY.MM.DD
```

請使用目前的 UTC 日期；同一天再次發布時，加入 `vYYYY.MM.DD-1` 這類流水號，未來日期會被拒絕。單一 workflow 會更新 `package.json` 與 `package-lock.json`、建立 release commit 與 annotated tag，接著發布 GitHub Release；它的驗證推送不會再啟動一輪 CI。既有的 `v*` tag 推送方式仍可使用。這個流程**不會發布至 npm**。

## 授權

MIT — 詳見 [`LICENSE`](./LICENSE)。
