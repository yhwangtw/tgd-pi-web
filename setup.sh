#!/usr/bin/env bash
#
# tGD-pi-web — 一鍵安裝 + Production 啟動
# 需要：Node.js 22+
#
set -e

# ── 顏色 ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Git checkout 以 origin/main 為唯一真相 ───────────
# End-user installations are disposable checkouts. Always replace tracked
# changes, local commits, and non-ignored untracked files with origin/main,
# then restart the newly fetched script. Ignored runtime state such as .env,
# node_modules, and .next remains untouched. Source archives have no .git and
# skip this step; an offline Git checkout can explicitly opt out.
if [ -e "$SCRIPT_DIR/.git" ] \
  && [ "${TGD_SETUP_SOURCE_SYNCED:-0}" != "1" ] \
  && [ "${TGD_SETUP_OFFLINE:-0}" != "1" ]; then
  echo -e "${CYAN}${BOLD}♻️  同步遠端正式版 origin/main...${NC}"
  echo -e "  ${YELLOW}本地 commit、tracked 修改與未追蹤程式碼將被放棄。${NC}"
  git fetch --prune origin main
  git reset --hard origin/main
  git clean -fd
  echo -e "  ${GREEN}✅ 本地程式碼已同步為 origin/main${NC}"
  export TGD_SETUP_SOURCE_SYNCED=1
  exec bash "$SCRIPT_DIR/setup.sh" "$@"
fi

echo -e "${CYAN}${BOLD}🚀 tGD-pi-web 一鍵安裝${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -e "$SCRIPT_DIR/.git" ] && [ "${TGD_SETUP_OFFLINE:-0}" = "1" ]; then
  echo -e "${YELLOW}⚠️  離線模式：跳過 origin/main 同步，使用目前本地原始碼。${NC}"
fi

# ── 修復舊版覆蓋安裝殘留 ────────────────────────────
# PR #65 replaced the old command-palette/search components. Extracting a
# release archive over an existing directory does not remove files that no
# longer ship, and TypeScript's **/*.tsx include then compiles both versions.
# Move only these known-obsolete files out of the source tree. Keep a private
# backup so locally modified copies are never destroyed.
LEGACY_FILES=(
  "components/ui/CommandPalette.tsx"
  "components/ui/CommandPalette.module.css"
  "components/sidebar/SearchResults.tsx"
  "components/sidebar/SearchResults.module.css"
)
FOUND_LEGACY_FILES=()

for relative_path in "${LEGACY_FILES[@]}"; do
  candidate="$SCRIPT_DIR/$relative_path"
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    if [ -d "$candidate" ] && [ ! -L "$candidate" ]; then
      echo -e "${RED}❌ 預期為檔案但找到資料夾: $candidate${NC}"
      echo "  為避免搬動未知資料，setup 已停止。"
      exit 1
    fi
    FOUND_LEGACY_FILES+=("$relative_path")
  fi
done

if [ "${#FOUND_LEGACY_FILES[@]}" -gt 0 ]; then
  backup_root="${TGD_SETUP_BACKUP_DIR:-$HOME/.tgd-pi-web-backups}"
  project_name="$(basename "$SCRIPT_DIR")"
  backup_dir="$backup_root/${project_name}-$(date -u +%Y%m%dT%H%M%SZ)-$$"

  for relative_path in "${FOUND_LEGACY_FILES[@]}"; do
    source_path="$SCRIPT_DIR/$relative_path"
    backup_path="$backup_dir/$relative_path"
    (
      umask 077
      mkdir -p "$(dirname "$backup_path")"
      mv "$source_path" "$backup_path"
    )
  done

  echo ""
  echo -e "${GREEN}${BOLD}✅ 已備份並移除舊版殘留檔案${NC}"
  echo "  備份位置: $backup_dir"
  for relative_path in "${FOUND_LEGACY_FILES[@]}"; do
    echo "  - $relative_path"
  done
fi

# ── 檢查 Next.js workspace root 衝突 ────────────────
# Next.js searches ancestor directories for lockfiles. A stray lockfile in
# $HOME can make builds trace the whole home directory and appear to hang.
ANCESTOR_LOCKFILES="$(
  parent_dir="$(dirname "$SCRIPT_DIR")"
  while [ "$parent_dir" != "/" ]; do
    for lock_name in package-lock.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb; do
      if [ -f "$parent_dir/$lock_name" ]; then
        printf '%s\n' "$parent_dir/$lock_name"
      fi
    done
    parent_dir="$(dirname "$parent_dir")"
  done
)"

if [ -n "$ANCESTOR_LOCKFILES" ]; then
  echo ""
  echo -e "${YELLOW}${BOLD}⚠️  偵測到上層 lockfile：${NC}"
  while IFS= read -r lockfile; do
    echo "  $lockfile"
  done <<< "$ANCESTOR_LOCKFILES"
  echo -e "  ${GREEN}✅ Next.js workspace root 已固定為 $SCRIPT_DIR${NC}"
  echo "  setup.sh 不會刪除或修改上層 lockfile。"
fi

# ── 檢查 Node.js ──────────────────────────────────────
echo ""
echo -e "${BOLD}📦 檢查 Node.js...${NC}"
if ! command -v node &>/dev/null; then
  echo -e "  ${RED}❌ 找不到 Node.js${NC}"
  echo ""
  echo "  安裝方式："
  echo "    macOS:   brew install node"
  echo "    Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "    其他:    https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo -e "  ${RED}❌ Node.js 版本過舊 ($NODE_MAJOR.x)，需要 22+${NC}"
  exit 1
fi
echo -e "  ${GREEN}✅ Node.js $(node --version)${NC}"

# ── 檢查 npm ──────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  echo -e "  ${RED}❌ 找不到 npm${NC}"
  exit 1
fi
echo -e "  ${GREEN}✅ npm $(npm --version)${NC}"

# ── 安裝依賴 ──────────────────────────────────────────
echo ""
echo -e "${BOLD}📦 安裝依賴...${NC}"
# `node_modules` existing does not mean it matches package-lock.json. Always
# reconcile it so upgrades (especially Pi runtime fixes) are not silently skipped.
npm install
echo -e "  ${GREEN}✅ 依賴已與 package-lock.json 同步${NC}"

# ── 檢查 Pi Agent ─────────────────────────────────────
echo ""
echo -e "${BOLD}🤖 檢查 Pi Agent...${NC}"
PI_RUNTIME_VERSION="$(node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version")"
echo -e "  ${GREEN}✅ Web 內建 Pi runtime: ${PI_RUNTIME_VERSION}${NC}"

if command -v pi &>/dev/null; then
  PI_CLI_VERSION="$(pi --version 2>/dev/null || true)"
  PI_CLI_VERSION="${PI_CLI_VERSION%%$'\n'*}"

  if [ -z "$PI_CLI_VERSION" ]; then
    echo -e "  ${YELLOW}⚠️  找到全域 Pi CLI，但無法讀取版本${NC}"
  elif [ "$PI_CLI_VERSION" = "$PI_RUNTIME_VERSION" ]; then
    echo -e "  ${GREEN}✅ 全域 Pi CLI 版本一致: ${PI_CLI_VERSION}${NC}"
  else
    echo -e "  ${YELLOW}⚠️  全域 Pi CLI ${PI_CLI_VERSION} 與 Web runtime ${PI_RUNTIME_VERSION} 不一致${NC}"
    echo "  僅使用 Web 不受影響；終端機的 pi 指令仍會使用 ${PI_CLI_VERSION}。"

    if [ -t 0 ]; then
      read -p "$(echo -e ${CYAN}是否將全域 Pi CLI 同步為 ${PI_RUNTIME_VERSION}？[y/N]${NC} )" sync_pi_cli
      case "$sync_pi_cli" in
        y|Y)
          npm install -g "@earendil-works/pi-coding-agent@${PI_RUNTIME_VERSION}"
          UPDATED_PI_CLI_VERSION="$(pi --version 2>/dev/null || true)"
          UPDATED_PI_CLI_VERSION="${UPDATED_PI_CLI_VERSION%%$'\n'*}"
          if [ "$UPDATED_PI_CLI_VERSION" = "$PI_RUNTIME_VERSION" ]; then
            echo -e "  ${GREEN}✅ 全域 Pi CLI 已同步為 ${PI_RUNTIME_VERSION}${NC}"
          else
            echo -e "  ${YELLOW}⚠️  安裝完成，但 pi --version 回報 ${UPDATED_PI_CLI_VERSION:-未知版本}${NC}"
          fi
          ;;
        *)
          echo "  保留全域 Pi CLI ${PI_CLI_VERSION}。"
          ;;
      esac
    else
      echo "  如需同步：npm install -g @earendil-works/pi-coding-agent@${PI_RUNTIME_VERSION}"
    fi
  fi
else
  echo -e "  ${YELLOW}ℹ️  未安裝全域 Pi CLI（僅使用 Web 不需要安裝）${NC}"
  echo "  如需在終端機使用 pi：npm install -g @earendil-works/pi-coding-agent@${PI_RUNTIME_VERSION}"
fi

PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [ -d "$PI_DIR" ]; then
  echo -e "  ${GREEN}✅ Pi Agent 資料目錄: $PI_DIR${NC}"
else
  echo -e "  ${YELLOW}ℹ️  Pi Agent 資料目錄尚未建立: $PI_DIR${NC}"
  echo "  首次在 Web 或 CLI 完成設定與使用時會建立。"
fi

# ── 驗證 ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}🔍 驗證...${NC}"
if node_modules/.bin/tsc --noEmit; then
  echo -e "  ${GREEN}✅ TypeScript 編譯通過${NC}"
else
  echo -e "  ${RED}❌ TypeScript 編譯失敗，已停止 Production build${NC}"
  exit 1
fi

# ── Production build ─────────────────────────────────
echo ""
echo -e "${BOLD}🏗️  建置 Production...${NC}"
npm run build
echo -e "  ${GREEN}✅ Production build 完成${NC}"

# ── 啟動 ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}✅ 安裝完成！${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  啟動 Production：${BOLD}npm start${NC}"
echo -e "  重新建置：       ${BOLD}npm run build${NC}"
echo -e "  更新並重新建置： ${BOLD}git pull && npm install && npm run build${NC}"
echo ""
echo -e "  預設埠號：      ${BOLD}30141${NC}"
echo ""

# ── 詢問是否立即啟動 ──────────────────────────────────
if [ -t 0 ]; then
  read -p "$(echo -e ${CYAN}是否立即啟動 Production 伺服器？[Y/n]${NC} )" choice
  case "$choice" in
    n|N)
      echo "bye 👋"
      exit 0
      ;;
    *)
      echo ""
      echo -e "${CYAN}啟動 Production...${NC}"
      echo -e "  打開 http://localhost:30141"
      echo -e "  Ctrl+C 停止"
      echo ""
      exec npm start
      ;;
  esac
fi
