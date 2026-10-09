# Pi Durable 全面接入前盤點

> 歷史盤點：下文保留接入前的調查、測試數字與待辦，不代表目前仍未接入。後續實作的使用方式、支援範圍及限制請看 [Durable 使用與限制](DURABLE.md) 和[目前架構](DEVELOPMENT.md#durable-conversations-and-schedules-preview)。這份盤點與後續文件都不是部署完成證明。

日期：2026-10-04。範圍為目前 Pi Web、官方 Pi Durable 1.0.0，以及本機已安裝的 OpenViking 0.4.5 擴充。這份文件是本次調查的證據與接入設計，不新增專案發版規則。

## 結論與目前狀態

Durable 的原生能力可以支援聊天、父子任務與持久狀態；缺口主要在 Pi Web 的會話儲存、事件與擴充轉接。現有背景任務整合只是第一個入口，不能以其測試結果宣稱全站已接入。

目前產品的聊天、Subagent、Goal／Plan、MCP、互動提問及記憶仍由 Pi Coding Agent 0.86 執行。此輪新增的是四份原生 SDK 能力試驗、這份盤點，以及一處瀏覽器測試選取器修正，沒有切換正式站或改寫既有 Session。

建議讓 Durable 成為新執行路徑的唯一狀態來源，沿用 Web 的互動方式與 API 契約。不要同時啟動舊 AgentSession 和 Durable 的兩個模型迴圈，再互相轉發訊息；那會產生兩套佇列、取消與預算狀態。

## 驗證結果與限制

| 範圍 | 結果 | 能證明的事情 |
| --- | --- | --- |
| 現有 Pi Web 回歸 | 去重後 44 檔、377 項通過 | 現有聊天、工作流程、Session、MCP、排程與背景任務契約正常；部分管理邏輯使用 mock |
| 新增 Durable 原生試驗 | 4 檔、16 項通過 | 真 Harness、SQLite、官方離線 provider，以及真 MCP stdio 程序下的行為 |
| Pi Web 合計 | 48 檔、393 個唯一案例 | 上述兩組合計，沒有把多位檢查者的重複測試相加 |
| 全套瀏覽器案例 | 277 個案例；首輪 276 通過、1 個選取器衝突；修正後相關 9 個案例全部通過 | 桌面／手機介面及既有操作基線；不代表每個 UI 案例都呼叫真模型 |
| OpenViking 既有離線契約 | 4 檔、185 項通過，0 skipped | 舊 Pi 0.86 的 branch、capture、takeover 等契約；不代表 Durable 已支援 OpenViking |
| TypeScript／新增測試 ESLint | 通過 | 新增試驗可與目前專案一起檢查 |

瀏覽器驗證使用已建置的獨立候選目錄、全新拋棄式資料及離線 provider。唯一失敗是預算設定測試用 `role=status` 同時選到了「Saved」及先前取消任務的狀態；改為精確選取 Saved，並重現「先取消 Durable 任務、再儲存預算」的順序通過。

沒有呼叫付費模型、正式 OpenViking 或正式 MCP endpoint。模型 bridge 的通過代表既有 ModelRuntime 與 Durable 的協定可運作，不代表所有供應商、OAuth、延遲推論與圖片功能已逐一實測。

新增試驗：

- [`durable-chat-audit.test.ts`](../lib/__tests__/durable-chat-audit.test.ts)：6 項。串流 delta 與中途 snapshot、steer／follow-up／withdraw、分支模型與歷史、reset、compact、佇列恢復。
- [`durable-subagents-audit.test.ts`](../lib/__tests__/durable-subagents-audit.test.ts)：3 項。真並行、父子取消、重開後同 child／task／requestId 接續。
- [`durable-state-audit.test.ts`](../lib/__tests__/durable-state-audit.test.ts)：3 項。等待回答與一次性 receipt、Goal／Plan 狀態及延續 hook、模型中斷後重用記憶注入 memo。
- [`durable-mcp-audit.test.ts`](../lib/__tests__/durable-mcp-audit.test.ts)：4 項。真 stdio 呼叫、取消通知、未知副作用不自動重送、output schema 錯誤交回模型。

上述恢復試驗以真實 close／reopen 為主。既有 [`durable-agent-run.test.ts`](../lib/__tests__/durable-agent-run.test.ts) 另有獨立程序 SIGKILL 的非安全工具試驗；不能將它稱為父子任務、提問或 OpenViking 的 SIGKILL 證據。

## 逐功能盤點

| 功能 | 現有 Web 契約 | 原生 Durable 已實測／可用能力 | 接入仍需完成 |
| --- | --- | --- | --- |
| 聊天串流與重連 | 先接 SSE、收到權威 snapshot 才送第一句；保留 thinking、tool progress、錯誤與重連 | `watchEvents` 提供 delta 及 in-flight snapshot | 將 `changes` 累積成現有 Web 事件；保存 entryId；接回 SSE cursor／epoch、多分頁及斷線去重 |
| prompt／steer／follow-up | 串流中插話、排隊、編輯／清空／重排、圖片 | 佇列、withdraw 與固定 requestId 可跨重開保存 | 前端與 API 保存同一操作 ID；遺失 HTTP ACK 後不重複提交；保留圖片與佇列順序 |
| 停止與關閉 | 停止當輪也停止 Goal 自動續跑；閒置釋放不等於使用者取消 | `abort` 與 `close` 有不同語意 | 分清取消、斷線、閒置釋放、程序重啟；不能把關閉畫面當成取消，也不能恢復已取消工作 |
| 壓縮 | 手動／自動、取消、失敗重試、壓縮中排隊、只顯示一次完成提示 | 手動 compact 縮短 context 而保留歷史，重開後仍有效 | task 完成與 summary 真正放入 context 是兩份 receipt，不能只看到 `compaction_end` 就顯示成功 |
| Session／分支／匯入匯出 | JSONL tree、leaf、穩定 entryId；fork／new／switch 失敗可恢復；CLI 可讀歷史 | fork 保留當時模型與祖先歷史；reset 不刪除原始資料 | SessionRepository、SQLite 查詢投影、JSONL 匯入匯出、rename／delete／search／tags／unread；避免兩份可寫真實來源 |
| 暫時聊天 | 現有 `SessionManager.inMemory` 不落地 | 可選 memory storage | 保留暫時聊天的隱私與不恢復語意，不能默默改存 SQLite |
| Subagent | single／parallel／chain、工具交集、並行上限、共享預算、停止及報告 | owned conversation 真並行；父 abort 連動；重開重用同 child | 以 ownerTaskId 原子建立子任務，穩定 requestId；Dashboard 作投影；補 chain、工具縮限及預算跨重啟 |
| Goal／Plan | branch 中保存狀態；使用者重開／換分支後 Goal 暫停；Plan review 限制寫入 | `defineDoc` 與 `onYield` 能保存／繼續／完成 | 採 rewindable、fork-as-of 狀態；原子保存 continuation；分清 crash recovery 與使用者重開；保持 Plan 工具防線 |
| ask_user／Extension UI | 非模態卡片、多分頁一次回答、可延後、衝突與取消 | 真 SQLite 試验保留 pending、首個 answer receipt、衝突回覆拒絕，重開不重出題 | 接回正式 UI bridge、回答 API、逾時／取消／晚答；持久識別與 receipt 必須取代 RAM-only Promise |
| MCP | 最新設定／schema 檢查、共享 transport、timeout、abort、output validation | 真 stdio 路徑及中斷處理已試驗 | 抽 transport-neutral definition 並註冊 Durable 工具；保留停用與配置漂移檢查；不能預設所有遠端工具可重播 |
| OpenViking／記憶 | 自動 recall、context 注入、tool guard、capture watermark、compaction takeover、archive boundary | 原生 request hook 的 memo 能在模型恢復時重用 | 專門 memory adapter、穩定 Session／entry 對應、持久水位、commit 後 capture outbox；實際 OpenViking 整合尚未驗證 |
| Structured output | details 卡片、工具結束回合 | Durable 有 details、diagnostics、`control.terminate` | 轉換結果與控制語意；不能僅保留 content；多工具同輪的 terminate 行為需對齊 |
| 排程 | once／daily／weekly／cron，建立一般 Session，可等使用者 | 可提交固定 requestId 的持久輸入 | 排程觸發 receipt、下次時間、工作 ownership；crash 後不能把同次排程重新派一份 |
| Shell、模型、工具、擴充設定 | `!`／`!!`、模型與 thinking 切換、reload、指令、診斷 | model／tool 配置可存會話；既有 ModelRuntime bridge 可重用 | 獨立 shell task 與取消、保留 omit-context、即時設定更新、extension commands／資源／診斷 adapter |

## 接入設計

```text
既有 Web UI / API / SSE
          │
     WebSessionHost
  identity、連線、lease、receipt
          │
     WebRuntimeAdapter
       ├─ 既有 Pi Runtime（保留舊會話／尚未適配的擴充）
       └─ Durable Runtime（原生任務、文件、佇列、事件）
          │
     SessionRepository
       ├─ 原有 JSONL
       └─ Durable SQLite + 可重建的唯讀投影
```

WebRuntimeAdapter 應暴露 Web 真正需要的窄介面：state／snapshot／context／subscribe、dispatch＋requestId、completion／cancel、fork／replacement、模型／工具與擴充操作、close。不要讓 Durable 假裝成包含舊 SessionManager、ExtensionRunner、SettingsManager 所有內部欄位的 `AgentSessionLike`。

工程順序：

1. **會話與命令邊界**：抽 runtime／repository 介面、穩定 requestId、明確 storage identity，先保留既有行為。
2. **聊天閉環**：Durable snapshot／串流／佇列／取消接回現有 API 與 UI，完成重新啟動及遺失 ACK 的端到端驗證。
3. **互動與工作流程**：持久 question receipts、Goal／Plan documents、Structured output，再接 owned subagent 與 Dashboard／預算投影。
4. **外部能力與舊資料**：MCP、OpenViking、排程與 JSONL 分支／匯入匯出；使用既有契約驗證保真。
5. **完整會話驗證後再擴大使用**：舊會話保留來源；需轉入時建立可逆副本。尚未適配的第三方 API 明確顯示能力限制，保留可用舊路徑，不能把 fallback 算成「全接入」。

這是相依順序，不是新增固定階段、額外審批或每次發版都重跑全部測試的要求。後續只依實際修改與未解問題選擇驗證。

## 接線完成後才能宣稱的驗證

原生 SDK 試驗證明「可以做」，仍須在真正 Web 接線完成後確認：

- 生成中 SIGKILL、重啟後 partial／用量／完整回答不重複，以及多分頁 SSE 恢復。
- safe tool 與 unsafe tool 的不同恢復方式；外部副作用不承諾 exactly-once。
- 父子 chain、共享預算、工具限制、等待人類時的 Goal 暫停，以及提交／回答 ACK 遺失。
- 排程同一次觸發去重；Goal 主動暫停不因程序重啟復活。
- 舊 JSONL、fork、compaction、import／export，以及 OpenViking 水位與 archive 邊界。
- 實際供應商、OAuth、正式記憶／MCP 的授權範圍內驗證。離線測試不能代替這些結果。

## 程式證據與上游來源

- [`lib/rpc-manager.ts`](../lib/rpc-manager.ts)：聊天命令、session replacement、SSE snapshot、舊 runtime ownership。
- [`lib/pi-runtime.ts`](../lib/pi-runtime.ts)：內建五組 extensionFactories、provider discovery、擴充生命週期。
- [`lib/session-reader.ts`](../lib/session-reader.ts)：JSONL、分支與列表讀取。
- [`lib/agent-client.ts`](../lib/agent-client.ts)：目前 fork 才附加 Idempotency-Key。
- [`lib/web-extension-ui.ts`](../lib/web-extension-ui.ts)：目前 pending、answer receipts 與顯示狀態為記憶體 Map。
- [`lib/workflow-extension.ts`](../lib/workflow-extension.ts)、[`lib/subagent-extension.ts`](../lib/subagent-extension.ts)、[`lib/mcp.ts`](../lib/mcp.ts)：各功能現有契約。
- [`lib/durable-agent-run.ts`](../lib/durable-agent-run.ts)、[`lib/durable-models.ts`](../lib/durable-models.ts)：第一階段背景任務與模型橋接。
- [官方 Pi Durable 說明](https://earendil.com/posts/pi-durable/)：experimental 定位、task checkpoint、storage ownership、extensions 與子任務設計。
- [官方 Pi 原始碼](https://github.com/earendil-works/pi)：本次以已鎖定安裝的 `@earendil-works/pi-durable@1.0.0` README、型別及實際執行為 API 證據，沒有將移動中的 main 當作已安裝版本。

本機驗證紀錄：`/private/tmp/pi-durable-audit-regression.log`、`pi-durable-audit-deduplicated-cases.json`、`pi-durable-audit-e2e.log`、`pi-durable-audit-e2e-recheck.log`、`pi-durable-viking-audit-tests.log`，以及四份 `pi-durable-*-audit.log` 原生試驗紀錄。這些是暫存診斷檔，不是部署憑證。
