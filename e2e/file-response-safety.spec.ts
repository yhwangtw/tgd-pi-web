import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { encodeFilePathForApi } from "../lib/file-paths";
import { isolatedPreviewDocument } from "../lib/preview-policy";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
const url = (name: string, type = "raw") => `/api/files/${encodeFilePathForApi(path.join(process.env.E2E_PROJECT_CWD!, name))}?type=${type}`;
const html = `<!doctype html><html><head><title>Isolated fixture</title><style>body{font:16px system-ui;margin:24px}button{padding:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>
<h1>Preview fixture</h1><button id="increment">Count: 0</button><button id="navigate">Try top navigation</button><button id="api-navigation" onclick="location.href='/api/sessions'">Try API navigation</button><pre id="proof">Waiting</pre>
<script>
(async () => {
  const proof = {};
  try { void document.cookie; proof.cookies = 'allowed'; } catch { proof.cookies = 'blocked'; }
  try { void localStorage.getItem('fixture'); proof.storage = 'allowed'; } catch { proof.storage = 'blocked'; }
  try { await fetch('/__preview_probe__', {credentials:'include'}); proof.network = 'allowed'; } catch { proof.network = 'blocked'; }
  try { void window.parent.document.body; proof.parent = 'allowed'; } catch { proof.parent = 'blocked'; }
  let count = 0;
  document.querySelector('#increment').onclick = (event) => event.target.textContent = 'Count: ' + ++count;
  document.querySelector('#navigate').onclick = () => { try { window.top.location.href = '/__preview_probe__'; } catch { proof.navigation = 'blocked'; document.querySelector('#proof').textContent = JSON.stringify(proof); } };
  document.querySelector('#proof').textContent = JSON.stringify(proof);
})();
</script></body></html>`;

test.beforeAll(() => {
  const root = process.env.E2E_PROJECT_CWD!;
  writeFileSync(path.join(root, "safe-preview.html"), html);
  writeFileSync(path.join(root, "safe-preview.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text y="30">SVG fixture</text><script>document.documentElement.setAttribute("data-script-ran","yes")</script></svg>');
  writeFileSync(path.join(root, "stream-fixture.bin"), Buffer.alloc(5 * 1024 * 1024, 97));
});

async function trackProbe(page: Page) {
  const requests: string[] = [];
  await page.route("**/__preview_probe__", route => { requests.push(route.request().url()); return route.fulfill({ body: "Unexpected network access" }); });
  return requests;
}

test("direct HTML and SVG URLs are isolated by the real response", async ({ page, request }) => {
  const requests = await trackProbe(page);
  const response = await page.goto(url("safe-preview.html"));
  expect(response!.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
  await expect(page.locator("#proof")).toContainText('"network":"blocked"');
  await expect(page.locator("#proof")).toContainText('"cookies":"blocked"');
  await expect(page.locator("#proof")).toContainText('"storage":"blocked"');
  await page.getByRole("button", { name: "Count: 0" }).click();
  await expect(page.getByRole("button", { name: "Count: 1" })).toBeVisible();
  expect(requests).toEqual([]);
  await page.goto(url("safe-preview.svg"));
  await expect(page.locator("svg")).toBeVisible();
  await expect(page.locator("svg")).not.toHaveAttribute("data-script-ran", "yes");
  for (const [name, type] of [["safe-preview.html", "raw"], ["safe-preview.svg", "raw"], ["safe-preview.svg", "read"], ["safe-preview.svg", "download"]]) {
    for (const range of [undefined, "bytes=0-31", "bytes=bad"]) {
      const result = await request.get(url(name, type), { headers: range ? { Range: range } : {} });
      expect(result.status()).toBe(range === "bytes=bad" ? 416 : range ? 206 : 200);
      expect(result.headers()["content-security-policy"]).toContain("sandbox");
      expect(result.headers()["content-security-policy"]).not.toContain("allow-same-origin");
      expect(result.headers()["x-content-type-options"]).toBe("nosniff");
    }
  }
});

test("response sandbox protects an iframe without its own sandbox attribute", async ({ page }) => {
  const requests = await trackProbe(page);
  await page.goto(MAIN);
  const originalUrl = page.url();
  await page.evaluate(src => {
    const frame = document.createElement("iframe");
    frame.id = "response-policy-probe";
    frame.src = src;
    document.body.appendChild(frame);
  }, url("safe-preview.html"));
  const frame = page.frameLocator("#response-policy-probe");
  await expect(frame.locator("#proof")).toContainText('"parent":"blocked"');
  await expect(frame.locator("#proof")).toContainText('"network":"blocked"');
  // A synthetic click avoids positioning a test-only iframe over app controls.
  await frame.locator("#navigate").evaluate((button: HTMLButtonElement) => button.click());
  await expect(frame.locator("#proof")).toContainText('"navigation":"blocked"');
  expect(page.url()).toBe(originalUrl);
  expect(requests).toEqual([]);
});

test("standalone preview navigation cannot bypass the API origin gate", async ({ page }) => {
  await page.goto(url("safe-preview.html"));
  await expect(page.locator("#proof")).toContainText('"network":"blocked"');
  const response = page.waitForResponse(result => new URL(result.url()).pathname === "/api/sessions");
  await page.getByRole("button", { name: "Try API navigation" }).click();
  const result = await response;
  expect((await result.request().allHeaders())["sec-fetch-site"]).toBe("cross-site");
  expect(result.status()).toBe(403);
  expect(result.headers()["cache-control"]).toContain("no-store");
  expect(result.headers()["vary"]).toContain("Sec-Fetch-Site");
  expect(await result.json()).toEqual({ error: "Cross-origin request blocked" });
});

test("inline srcDoc uses the same network restrictions", async ({ page }) => {
  const requests = await trackProbe(page);
  await page.goto(MAIN);
  await page.evaluate(content => {
    const frame = document.createElement("iframe");
    frame.id = "inline-policy-probe";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = content;
    document.body.appendChild(frame);
  }, isolatedPreviewDocument(html));
  const frame = page.frameLocator("#inline-policy-probe");
  await expect(frame.locator("#proof")).toContainText('"network":"blocked"');
  await expect(frame.locator("#proof")).toContainText('"storage":"blocked"');
  await expect(frame.locator("#proof")).toContainText('"parent":"blocked"');
  expect(requests).toEqual([]);
});

for (const style of ["original", "trae"]) {
  test(`${style}: preview remains interactive with readable mobile isolation help`, async ({ page }) => {
    await page.addInitScript(style => {
      if (window.top !== window) return;
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-font-size", "xlarge");
      localStorage.setItem("pi-skin", "trae");
    }, style);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MAIN);
    await expect(page.getByText("專案架構分析").first()).toBeVisible();
    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await page.getByRole("treeitem", { name: "safe-preview.html" }).click();
    const panel = page.locator(".right-panel-container.right-panel-open");
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    const frame = page.frameLocator('iframe[title="HTML preview"]');
    await expect(frame.locator("#proof")).toContainText('"network":"blocked"');
    await frame.getByRole("button", { name: "Count: 0" }).click();
    await expect(frame.getByRole("button", { name: "Count: 1" })).toBeVisible();
    const note = panel.locator("details").filter({ has: page.locator("summary", { hasText: "Isolated preview" }) });
    await note.locator("summary").focus();
    await note.locator("summary").press("Enter");
    await expect(note).toHaveAttribute("open", "");
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("html")).toHaveAttribute("data-font-size", "xlarge");
      await expect(note.getByText(/Embedded scripts and assets only/)).toBeVisible();
      expect(await note.locator("summary").evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await expect.poll(() => note.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      for (const label of ["Code", "Preview", "Ask Pi", "Inspector", "More file actions"]) {
        const control = panel.getByRole("button", { name: label, exact: true });
        await expect(control).toBeVisible();
        await expect.poll(() => control.evaluate(el => {
          const box = el.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth && el.scrollWidth <= el.clientWidth;
        })).toBe(true);
      }
      if (style === "trae") {
        expect(await panel.getByRole("button", { name: "Ask Pi", exact: true }).evaluate(el => {
          const sample = document.createElement("span");
          sample.style.color = "var(--color-accent-fg)";
          document.body.append(sample);
          const expected = getComputedStyle(sample).color;
          sample.remove();
          return getComputedStyle(el).color === expected;
        })).toBe(true);
      }
      await expect(frame.getByRole("heading", { name: "Preview fixture" })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`preview-${style}-${width}.png`) });
    }
    await note.locator("summary").click();
    await expect(note).not.toHaveAttribute("open");
  });
}

test("large downloads retain exact bytes, ranges and cancellation", async ({ page, request }) => {
  const response = await request.get(url("stream-fixture.bin", "download"));
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toContain("attachment;");
  expect(await response.body()).toEqual(Buffer.alloc(5 * 1024 * 1024, 97));
  const range = await request.get(url("stream-fixture.bin", "download"), { headers: { Range: "bytes=-2" } });
  expect(range.status()).toBe(206);
  expect(await range.text()).toBe("aa");
  await page.goto(MAIN);
  const cancelled = await page.evaluate(async src => {
    const controller = new AbortController();
    const response = await fetch(src, { signal: controller.signal });
    const reader = response.body!.getReader();
    const first = await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    return { received: first.value!.length > 0, aborted: controller.signal.aborted };
  }, url("stream-fixture.bin", "download"));
  expect(cancelled).toEqual({ received: true, aborted: true });
});
