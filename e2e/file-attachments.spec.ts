import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const sessionId = "aaaa1111-2222-3333-4444-555566667777";
const input = (page: Page) => page.getByTestId("composer-shell").locator("textarea");
const picker = (page: Page) => page.locator('input[type="file"][aria-label="Attach files"]');
const project = () => process.env.E2E_PROJECT_CWD!;
async function open(page: Page) {
  await page.goto(`/?session=${sessionId}`);
  await expect(input(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach files", exact: true })).toBeVisible();
}

for (const style of ["original", "trae"]) for (const width of [390, 1440]) {
  test(`${style} ${width}: attaches a real document and preserves the project copy`, async ({ page }, info) => {
    await page.addInitScript(style => { localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-skin", "trae"); }, style);
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const name = `report ${style} ${width}.txt`;
    await input(page).fill("請閱讀這個檔案");
    const fileChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach files", exact: true }).click();
    await (await fileChooser).setFiles({ name, mimeType: "text/plain", buffer: Buffer.from("這是實際上傳的檔案。\nhello") });
    await expect(input(page)).toHaveValue(`請閱讀這個檔案\n@"${name}" `);
    expect(await readFile(path.join(project(), name), "utf8")).toContain("實際上傳");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("attachment.png"), animations: "disabled" });
    await page.getByRole("button", { name: `Remove context ${name}`, exact: true }).click();
    await expect(input(page)).not.toHaveValue(new RegExp(name));
    expect(await readFile(path.join(project(), name), "utf8")).toContain("實際上傳");
  });
}

test("shows upload errors, protects existing files and retries without losing the draft", async ({ page }) => {
  await open(page);
  await input(page).fill("keep my draft");
  await picker(page).setInputFiles({ name: "README.md", mimeType: "text/markdown", buffer: Buffer.from("do not overwrite") });
  await expect(page.getByLabel("File uploads").getByRole("alert")).toContainText("already exists");
  expect(await readFile(path.join(project(), "README.md"), "utf8")).toContain("# Demo project");
  await expect(input(page)).toHaveValue("keep my draft");
  await page.getByRole("button", { name: "Dismiss upload error README.md" }).click();
  let fail = true;
  await page.route("**/api/files/**", route => {
    if (route.request().method() === "POST" && fail) { fail = false; return route.fulfill({ status: 503, json: { error: "Temporary upload failure" } }); }
    return route.continue();
  });
  await picker(page).setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry succeeded") });
  await expect(page.getByLabel("File uploads").getByRole("alert")).toContainText("Temporary upload failure");
  await page.getByRole("button", { name: "Retry upload retry.txt" }).click();
  await expect(input(page)).toHaveValue("keep my draft\n@retry.txt ");
  expect(await readFile(path.join(project(), "retry.txt"), "utf8")).toBe("retry succeeded");
});

test("accepts document drops, keeps edits during upload and blocks premature sends", async ({ page }) => {
  await open(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/files/**", async route => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  await input(page).fill("first draft");
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer(); data.items.add(new File(["dropped contents"], "dropped.csv", { type: "text/csv" })); return data;
  });
  await input(page).dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(page.getByText("Drop files to attach", { exact: true })).toBeVisible();
  await input(page).dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByText("Uploading…", { exact: true })).toBeVisible();
  await input(page).fill("edited during upload");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  release();
  await expect(input(page)).toHaveValue("edited during upload\n@dropped.csv ");
  expect(await readFile(path.join(project(), "dropped.csv"), "utf8")).toBe("dropped contents");
});

test("uploads before a new project's first conversation and exposes Files upload", async ({ page }) => {
  const newProject = path.join(process.env.E2E_ROOT!, "new-upload-project");
  await mkdir(newProject, { recursive: true });
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const projectPicker = page.getByTestId("project-switcher");
  await projectPicker.getByRole("textbox").fill(newProject);
  await projectPicker.getByRole("textbox").press("Enter");
  await expect(input(page)).toBeVisible();
  await picker(page).setInputFiles({ name: "new.txt", mimeType: "text/plain", buffer: Buffer.from("no saved session required") });
  await expect(input(page)).toHaveValue("@new.txt ");
  expect(await readFile(path.join(newProject, "new.txt"), "utf8")).toBe("no saved session required");
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload files", exact: true }).click();
  await (await chooser).setFiles({ name: "explorer.txt", mimeType: "text/plain", buffer: Buffer.from("visible upload action") });
  await expect(page.getByRole("treeitem", { name: "explorer.txt", exact: true })).toBeVisible();
  expect(await readFile(path.join(newProject, "explorer.txt"), "utf8")).toBe("visible upload action");
});

test("accepts files above the proxy's former 10 MB boundary", async ({ page }) => {
  await open(page);
  const bytes = Buffer.alloc(11 * 1024 * 1024, 65);
  await picker(page).setInputFiles({ name: "large-upload.txt", mimeType: "text/plain", buffer: bytes });
  await expect(input(page)).toHaveValue("@large-upload.txt ");
  expect((await readFile(path.join(project(), "large-upload.txt"))).equals(bytes)).toBe(true);
});

test("can cancel an in-flight upload and continue editing", async ({ page }) => {
  await open(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/files/**", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await gate;
    await route.fulfill({ json: { results: [{ name: "cancel.txt", ok: true }] } }).catch(() => {});
  });
  await input(page).fill("keep editing");
  await picker(page).setInputFiles({ name: "cancel.txt", mimeType: "text/plain", buffer: Buffer.from("cancel fixture") });
  await page.getByRole("button", { name: "Cancel upload cancel.txt" }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  release();
  await expect(input(page)).toHaveValue("keep editing");
});

test("keeps image previews while uploading multiple document formats", async ({ page }) => {
  await open(page);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
  await picker(page).setInputFiles([
    { name: "pixel.png", mimeType: "image/png", buffer: png },
    { name: "附件.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nfixture") },
    { name: "table upload.csv", mimeType: "text/csv", buffer: Buffer.from("name,amount\nfixture,1") },
  ]);
  await expect(input(page)).toHaveValue('@附件.pdf @"table upload.csv" ');
  await expect(page.getByRole("button", { name: "Remove image", exact: true })).toBeVisible();
  expect(await readFile(path.join(project(), "附件.pdf"), "utf8")).toContain("%PDF-1.4");
  expect(await readFile(path.join(project(), "table upload.csv"), "utf8")).toContain("fixture,1");
});
