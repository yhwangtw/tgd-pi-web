# tGD Pi Web

<p align="center">
  <a href="https://github.com/yhwangtw/tgd-pi-web/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yhwangtw/tgd-pi-web/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-TW.md">繁體中文</a> |
  <a href="README.ja.md"><strong>日本語</strong></a> |
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <a href="https://github.com/yhwangtw/tgd-pi-web/releases">リリース</a> ·
  <a href="https://github.com/yhwangtw/tgd-pi-web/issues">バグを報告</a> ·
  <a href="https://github.com/yhwangtw/tgd-pi-web/issues">機能を提案</a>
</p>

**Pi Coding Agent と tGD の全デリバリーフローをひとつにまとめるブラウザワークスペース。**

tGD Pi Web は、Pi のローカルセッションを視覚的なエンジニアリングコックピットに変えます。エージェントとのリアルタイム対話、ファイルと git 変更の確認、ブランチ移動、スナップショット復元、Map から Release までの進捗確認をブラウザだけで行えます。

![tGD Pi Web チャット画面](./docs/screenshots/02-hero-chat.png)

## tGD Pi Web を使う理由

Pi のターミナル体験は高速で集中しやすいものです。本プロジェクトは、長時間または並行する作業に必要な視覚的コンテキストを追加します。

- ストリーム出力、実行状態、経過時間、エラー、待機中メッセージ、コンテキスト使用量をまとめて確認。
- AgentSession を開始せずに、ローカルの Pi セッションを閲覧。
- 会話の横でファイル、diff、ツール呼び出し、git 変更をレビュー。
- 同じワークスペースで tGD artifacts と 7 つのデリバリーフェーズを追跡。
- 検索、ブックマーク、ミニマップ、ブランチで長い会話を移動。
- Safe Area 対応ナビゲーション、コンパクトなパイプライン、タッチしやすいメッセージ操作により、スマートフォンでもデスクトップでも快適に利用。
- ローカルファースト。設定したモデルエンドポイント以外へ、アプリは実行時に外部リクエストを送りません。

## 対象ユーザー

- [Pi Coding Agent](https://github.com/earendil-works/pi) を利用している開発者。
- tGD ワークフローを採用し、artifacts を隣接する `<project>-tGD/` に保存するチーム。
- エージェントをローカルで動かしながら、ブラウザで確認・操作したいエンジニア。
- 内部モデルゲートウェイと npm レジストリを利用するオフライン／企業環境。

## クイックスタート

### 必要環境

- Node.js 22 以降
- npm
- `~/.pi/agent/` を含む、動作する Pi 環境
- Git

本プロジェクトは GitHub のソースコードから配布され、**npm には公開されません**。

> [!IMPORTANT]
> tGD Pi Web は、許可されたワークスペース内のファイル読み書き、git リポジトリの確認、shell コマンドの実行が可能です。デフォルトでは localhost のみで使用してください。リモート公開する場合は `PIWEB_ACCESS_PASSWORD` を設定し、認証付きのプライベートネットワークまたは Access proxy の背後に配置してください。詳細は[デプロイガイド](./deploy/README.md)を参照してください。

サポート対象のワンステップインストールには、専用の checkout を使用します。

```bash
git clone https://github.com/yhwangtw/tgd-pi-web.git
cd tGD-pi-web
bash setup.sh
```

セットアップスクリプトは、Git checkout ではまずローカルソースを `origin/main` で置き換え、その後 Node.js と npm の確認、依存関係のインストール、TypeScript 検証、production build を行い、必要に応じて production server を起動します。ソースアーカイブでは、既知の古いファイルを build 前に `~/.tgd-pi-web-backups/` へ移動します（`TGD_SETUP_BACKUP_DIR` で変更可能）。

> [!WARNING]
> エンドユーザー向け Git インストールでは `origin/main` が唯一の正です。`bash setup.sh` は `git reset --hard origin/main` と `git clean -fd` を実行し、ローカル commit、tracked 変更、ignore されていない untracked ファイルを破棄します。`.env`、`node_modules`、`.next` など ignore 済みの runtime state は保持されます。

手動セットアップ：

```bash
npm install
npm run build
npm start
```

[http://localhost:30141](http://localhost:30141) を開きます。

### 既存 checkout の更新

```bash
bash setup.sh
```

意図的にオフラインで使う Git checkout では、`TGD_SETUP_OFFLINE=1 bash setup.sh` を実行して remote 同期をスキップします。

## ブラウザ内の tGD ワークフロー

現在のセッション上部には、フェーズバーが常に表示されます。

```text
Map → Define → Plan → Develop → Verify → Review → Release
```

- **Artifact に基づく状態** — Map、Define、Plan の完了は、UI の推測ではなくディスク上の実ファイルで判定します。
- **Feature-aware な進捗** — 最後の `/tgd-*` コマンドで指定された feature、または最後に更新された feature を追跡します。
- **Artifact explorer** — フェーズ別に整理された文書、または scans、wiki、prototypes を含む tGD ディレクトリ全体を閲覧できます。
- **送信前に確認できるフェーズ操作** — フェーズをクリックすると対応コマンドが入力欄に入り、確認してから送信できます。
- **Git 復元ポイント** — 各実行前に git-backed snapshot を作成し、ユーザーの index や `HEAD` には触れません。

想定されるディレクトリ構成：

```text
parent/
├── your-project/
└── your-project-tGD/
    ├── CONTEXT.md
    ├── TRACKING-PLAN.md
    ├── wiki/
    └── feature-name/
        ├── PRD.md
        ├── SPEC.md
        ├── DESIGN.md
        ├── TASKS.md
        ├── METRICS.md
        └── prototype/
```

artifacts が別の場所にある場合は `TGD_DIR` を設定してください。

## インターフェース

<p align="center">
  <img src="./docs/screenshots/11-mobile-chat.png" alt="レスポンシブなモバイル会話画面" width="390">
</p>

モバイルレイアウトでは、端末の Safe Area を尊重しながら、現在のフェーズ、会話、入力欄、モデル操作、主要ナビゲーションを親指の届く範囲に保ちます。

| セッションとファイルのワークスペース | コマンドパレット |
|---|---|
| ![コードセッション](./docs/screenshots/03-code-session.png) | ![コマンドパレット](./docs/screenshots/04-command-palette.png) |

| ダークモード | 空の状態 |
|---|---|
| ![ダークモード](./docs/screenshots/10-dark-mode.png) | ![空の状態](./docs/screenshots/01-empty-state.png) |

<details>
<summary><strong>5 種類の appearance skin を表示</strong></summary>

| Editorial | Terminal | Aurora |
|---|---|---|
| ![Editorial skin](./docs/screenshots/05-skin-editorial.png) | ![Terminal skin](./docs/screenshots/06-skin-terminal.png) | ![Aurora skin](./docs/screenshots/07-skin-aurora.png) |

| Industrial | Glass |
|---|---|
| ![Industrial skin](./docs/screenshots/08-skin-industrial.png) | ![Glass skin](./docs/screenshots/09-skin-glass.png) |

</details>

## 主な機能

### Agent チャット

- connect-before-prompt を採用した SSE リアルタイムストリーミング。
- prompt、steer、follow-up queue、retry、bash、context compaction。
- `!command` でシェルを直接実行。`!!command` では結果をモデルコンテキストに含めません。
- セッション途中でモデルと thinking level を切り替え。
- 組み込みの `ask_user` ツールに加え、Pi extension の `select`、`confirm`、`input`、`editor` ダイアログ、通知、ステータス、テキスト Widget に対応。保留中の回答は再接続後も維持されます。
- Pi extension のセッションコマンド（`newSession`、`fork`、`switchSession`）はネイティブの `AgentSessionRuntime` で実行され、Web UI は置換後のセッションへ追従して SSE を再接続します。
- 置換に失敗した場合は以前の runtime を復元し、別の runtime が使用中のセッションは切り替え前に拒否します。開いているすべてのタブが同じ置換に追従し、Extensions 設定で runtime 診断を確認できます。
- プレビュー優先のダイアログから Pi `.jsonl` を import でき、切り替え前に header、実効 cwd、許可 root、symlink、サイズ、保存先の衝突を検証します。
- 実行エラーカード、stall 警告、通知、完了音、タブ状態。
- 過去 turn の編集、以前の分岐点からの retry、独立 fork、セッション内ブランチ移動。

### スケジュール Agent

- 左レールの Schedule Center は、1 回、毎日、毎週、標準 5 フィールド cron と明示的な IANA タイムゾーンに対応します。
- プロジェクト、Prompt、モデル、thinking level、ツール権限、未実行時の方針、有効状態を設定し、停止、再開、即時実行、再試行、履歴確認を 1 か所で行えます。
- 各実行は通常のローカル Pi セッションを作成します。`ask_user` が判断を求めると **入力待ち** になり、そのセッションを直接開いて回答できます。
- スケジューラはローカル Node server 内で動作するため、server の起動が必要です。再起動後は設定に従って 1 回補完実行するかスキップし、同一スケジュールは重複実行しません。

### セッションとナビゲーション

- ローカル Pi `.jsonl` ファイルを増分・読み取り専用でインデックス。
- 検索、タグ、ピン、アーカイブ、自動命名、HTML/Markdown export、使用量分析。
- 会話内検索、user turn 移動、ブックマーク、ミニマップ、長文折りたたみ、always-follow ストリーム。
- 最近のプロジェクト、ピン、探索、ファイルシステム補完、linked git worktrees を備えた Project switcher。
- 組み込み `/tgd-*` コマンドと統合された再利用可能な prompt templates。

### ファイルと git

- プロジェクトツリー、再帰的ファイル名検索、テキスト編集、Markdown/HTML/画像プレビュー、チャット内のクリック可能なファイルパス。
- Git 状態 badge、working tree 概要、ファイル別統計、`HEAD` と worktree の diff。
- `edit` と `write` のツール呼び出しを、生 JSON ではなく diff またはファイル内容として表示。
- ファイル／git API に allowed-root、パスガード、`execFile`、レスポンスサイズ制限を適用。
- Snapshot restore は正確な差分だけを適用し、ユーザーの index や `HEAD` を書き換えません。

### レンダリングと外観

- GitHub Flavored Markdown、テーブル、task list、KaTeX、Mermaid、遅延ロードされるシンタックスハイライト。
- Editorial、Terminal、Industrial、Aurora、Glass の 5 skin。それぞれライト／ダークモード対応。
- Inter、JetBrains Mono、Noto Sans TC を同梱し、CDN に依存しません。
- アプリ UI の対応言語は English と繁體中文です。プロジェクト文書は日本語と Deutsch でも提供します。

## キーボードショートカット

| キー | 操作 |
|---|---|
| `⌘/Ctrl + K` | コマンドパレットを開く |
| `⌘/Ctrl + P` | Project switcher を開く |
| `⌘/Ctrl + F` | 会話内を検索 |
| `⌥ + ↑` / `⌥ + ↓` | 前／次の user turn |
| `⇧⌘M` | Models を開く |
| `⌘/Ctrl + /` | Skills を開く |
| `⌘/Ctrl + B` | contextual panel を切り替え |
| `⌘/Ctrl + \` | 右側ファイル panel を切り替え |
| 空の入力欄で `↑` | 前のメッセージを呼び出す |
| `Esc` | アクティブな dialog を閉じる |

## コマンド

| コマンド | 用途 |
|---|---|
| `bash setup.sh` | ローカル source を `origin/main` で置き換え、検証、install、build を行い、必要に応じて production を起動 |
| `npm run dev` | 必要に応じてポート `30141` で開発サーバーを起動 |
| `node_modules/.bin/tsc --noEmit` | Typecheck |
| `npx eslint .` | Lint |
| `npm test` | Vitest unit tests を実行 |
| `npm run test:e2e` | Build 後、ポート `30177` で Playwright E2E を実行 |
| `npm run build` | Production build を作成 |
| `npm run start` | Production server を起動 |

> [!WARNING]
> `npm run build` または `npm run test:e2e` の前に `npm run dev` を停止してください。同時に Next.js build を実行すると、開発サーバーが使用中の `.next/` が破損します。

Playwright は意図的に `package.json` へ保存していません。必要時に一時インストールします。

```bash
npm i -D --no-save @playwright/test
npm run test:e2e
```

Chromium がプリインストールされたローカルコンテナ：

```bash
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
```

## 設定

| 設定 | 動作 |
|---|---|
| `PI_CODING_AGENT_DIR` | デフォルトの `~/.pi/agent` ディレクトリを上書き |
| `PIWEB_ACCESS_PASSWORD` | すべての route に組み込みの共有パスワードゲートを有効化 |
| `TGD_DIR` | 隣接する `<project>-tGD/` artifact ディレクトリを上書き |
| `models.json` | カスタム `baseUrl` を含むモデル／provider カタログ |
| `auth.json` | Pi が管理する provider ごとの API credential |
| Project picker | 現在の working directory を選択・検証 |

セッションファイルは Pi のネイティブ形式を維持します。

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

## アーキテクチャ

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

読み取り専用の閲覧では、`AgentSession` を作らずにセッションファイルを解析します。メッセージ送信時のみ、アクティブなセッションごとに in-process runtime wrapper を作成し、イベントを SSE で配信します。セッション置換は Pi が管理し、wrapper は cwd 固有サービス、extensions、registry key、イベント購読を新しい `AgentSession` に再バインドします。

## プロジェクト構成

```text
app/api/        sessions、agent commands/events、schedules、files、git、tGD、config
components/     layout、chat、sidebar、modals、共有 UI
hooks/          agent orchestration、streaming、scrolling、sessions、theme
lib/            RPC lifecycle、scheduling、session parsing、security、i18n、snapshots
e2e/            Playwright production-server scenarios
docs/           screenshots とプロジェクト文書
public/fonts/   同梱ローカルフォント
```

詳細なアーキテクチャ、不変条件、開発上の注意点は [`AGENTS.md`](./AGENTS.md) を参照してください。

## オフライン／隔離環境

ブラウザアプリは実行時に外部リクエストを送りません。フォントと UI assets は同梱されています。到達可能である必要があるのは、設定した LLM endpoint だけです。

- **内部 npm registry：** リポジトリを clone するか GitHub Release のソースアーカイブを取得し、内部 registry を設定して `npm ci && npm run build` を実行。
- **ポータブルディレクトリ：** 同じ OS／アーキテクチャの接続可能なマシンで `npm ci && npm run build` を実行し、ディレクトリ全体をコピーして `npm run start`。
- **内部／ローカルモデル：** `models.json` で provider のカスタム `baseUrl` を設定。

`npm ci` は再現可能な CI とオフライン build のために維持し、対話的な開発では `npm install` を使います。

## FAQ

### npm package として公開されていますか？

いいえ。GitHub repository または GitHub Release のソースアーカイブからインストール・更新してください。

### Pi の代わりになりますか？

いいえ。Pi のセッションファイルと agent runtime を扱うローカルブラウザインターフェースです。基盤となる coding agent は Pi のままです。

### セッションはアップロードされますか？

本プロジェクトに hosted session backend はありません。ローカルの Pi ファイルを読み、設定したモデル／provider endpoint だけへ接続します。

### tGD Pi Web を停止している間もスケジュールは動きますか？

いいえ。スケジューラはローカル Node server 内で動作します。定刻実行には `npm start` を起動したままにしてください。再起動後は各スケジュールの設定に従い、1 回補完実行するかスキップします。

### なぜ Playwright が `package.json` にないのですか？

transitive postinstall がブラウザ binary をダウンロードし、オフラインまたは Nexus 環境の `npm ci` を壊す可能性があるためです。CI は E2E の前に `--no-save` で一時インストールします。

### compact 後もセッションファイルが長いのはなぜですか？

Compaction は要約を追加し、最近の末尾を保持しますが、元の履歴を `.jsonl` から削除しません。UI は Pi の active branch と compaction entry に従ってコンテキストを表示します。

## コントリビューション

Issue と pull request を歓迎します。

1. リポジトリを fork し、範囲を絞った branch を作成。
2. 開発には `npm install` を使用。
3. Typecheck、lint、tests を実行。
4. 動作変更には tests を追加または更新。
5. ユーザー向けセットアップや機能を変更した場合、4 つの README を同期。

アプリの翻訳は `lib/i18n.tsx` にあります。新しい skin では、component に色をハードコードせず semantic design tokens を使ってください。

## リリース

PR の CI が通過してマージされたら、次の高速リリースフローを使用します。

```bash
gh workflow run release.yml -f tag=vYYYY.MM.DD
```

1 つの workflow が `package.json` と `package-lock.json` を更新し、release commit と annotated tag を作成してから GitHub Release を公開します。認証済みの push で新たな CI は起動しません。バージョン更新済みの `v*` tag を push する従来の方法も利用できます。この workflow は **npm へ公開しません**。

## ライセンス

MIT — [`LICENSE`](./LICENSE) を参照してください。
