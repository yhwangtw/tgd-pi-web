import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "lib/capabilities.json"), "utf8"));
const START = "<!-- capability-table:start -->";
const END = "<!-- capability-table:end -->";

const labels = {
  en: {
    intro: "This table is generated from `lib/capabilities.json`; it is the product contract for Web support and runtime dependencies.",
    headers: ["Capability", "Foundation", "Web delivery", "Global Pi CLI", "Always-on server", "Trust boundary"],
    foundation: {
      "pi-sdk": "Official Pi SDK",
      "pi-extension-api": "Official Extension API",
      "pi-package-format": "Official package format",
      "pi-web": "Pi Web",
    },
    webSupport: { native: "Native", adapted: "Web adapter" },
    cli: { yes: "Required", no: "Not required" },
    server: { yes: "Required", no: "Normal Web runtime" },
    trust: {
      none: "None",
      workspace: "Trusted workspace",
      decision: "Explicit confirmation",
      host: "Single-user host",
      endpoint: "Trusted endpoint/command",
      operator: "Operator configuration",
    },
  },
  zh: {
    intro: "下表由 `lib/capabilities.json` 自動產生，是 Web 支援程度與執行依賴的產品契約。",
    headers: ["能力", "基礎", "Web 提供方式", "全域 Pi CLI", "常駐 Server", "信任邊界"],
    foundation: {
      "pi-sdk": "官方 Pi SDK",
      "pi-extension-api": "官方 Extension API",
      "pi-package-format": "官方套件格式",
      "pi-web": "Pi Web",
    },
    webSupport: { native: "原生 Web", adapted: "Web 轉接" },
    cli: { yes: "需要", no: "不需要" },
    server: { yes: "必須常駐", no: "一般 Web runtime" },
    trust: {
      none: "無",
      workspace: "受信任工作區",
      decision: "明確確認",
      host: "單一使用者主機",
      endpoint: "受信任端點／指令",
      operator: "管理者設定",
    },
  },
};

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(locale) {
  const copy = labels[locale];
  const rows = manifest.capabilities.map((capability) => [
    `**${capability.title[locale]}**`,
    copy.foundation[capability.foundation],
    copy.webSupport[capability.webSupport],
    copy.cli[capability.globalPiCliRequired ? "yes" : "no"],
    copy.server[capability.backgroundServerRequired ? "yes" : "no"],
    copy.trust[capability.trust],
  ]);
  return [
    START,
    copy.intro,
    "",
    `| ${copy.headers.join(" | ")} |`,
    `| ${copy.headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
    END,
  ].join("\n");
}

function syncFile(file, locale, write) {
  const fullPath = path.join(root, file);
  const source = fs.readFileSync(fullPath, "utf8");
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${file} is missing capability table markers`);
  const expected = `${source.slice(0, start)}${table(locale)}${source.slice(end + END.length)}`;
  if (expected === source) return true;
  if (write) {
    fs.writeFileSync(fullPath, expected);
    return true;
  }
  console.error(`${file} capability table is stale. Run npm run docs:capabilities.`);
  return false;
}

const write = process.argv.includes("--write");
const ok = syncFile("README.md", "en", write) && syncFile("README.zh-TW.md", "zh", write);
if (!ok) process.exit(1);
console.log(write ? "Capability tables updated." : `Capability tables are current (${manifest.capabilities.length} capabilities).`);
