import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";

// Static contrast checks cannot resolve a translucent surface over a gradient.
// Exercise the missing 180 palette pairs against real rendered backdrop pixels,
// at narrow/wide widths and three positions within the product's Glass canvas.
const surfaces = ["--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--user-bg", "--assistant-bg", "--tool-bg", "--bg-elev-1", "--bg-elev-2"];
const roles = ["--text-muted", "--text-dim", "--accent-text", "--color-success-text", "--color-error-text", "--color-project-text"];

for (const width of [390, 1440]) {
  test(`${width}px: Glass text and status pairs remain readable on the rendered gradient`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?session=aaaa1111-2222-3333-4444-555566667777");
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    const evidence = [];

    for (const dark of [false, true]) for (const offset of [0, 350, 700]) {
      const pairs = await page.evaluate(({ surfaces, roles, dark, offset }) => {
        document.getElementById("glass-contrast-samples")?.remove();
        document.documentElement.dataset.skin = "glass";
        document.documentElement.classList.toggle("dark", dark);
        const style = document.getElementById("glass-contrast-style") ?? document.createElement("style");
        style.id = "glass-contrast-style";
        style.textContent = "body > *:not(#glass-contrast-samples) { visibility: hidden !important; }";
        document.head.append(style);
        const grid = document.createElement("div");
        grid.id = "glass-contrast-samples";
        grid.style.cssText = `position:fixed;top:${offset}px;left:0;right:0;background:var(--bg-panel);display:grid;grid-template-columns:repeat(10,1fr);z-index:9999;`;
        const cases = surfaces.flatMap(surface => [
          ...roles.map(role => ({ surface, role, tint: null as string | null })),
          ...["success", "error", "project"].map(status => ({ surface, role: `--color-${status}-text`, tint: `--color-${status}-bg` })),
          { surface, role: "--accent-text", tint: "--color-accent-bg" },
        ]);
        cases.forEach((pair, index) => {
          const host = document.createElement("div");
          host.style.cssText = `height:20px;background:var(${pair.surface});`;
          const sample = document.createElement("div");
          sample.id = `glass-pair-${index}`;
          sample.style.cssText = `width:100%;height:100%;color:var(${pair.role});${pair.tint ? `background:var(${pair.tint});` : ""}`;
          host.append(sample);
          grid.append(host);
        });
        document.body.append(grid);
        return cases;
      }, { surfaces, roles, dark, offset });

      const png = await page.screenshot({ animations: "disabled" });
      const results = await page.evaluate(async ({ png, pairs }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const colorCanvas = document.createElement("canvas");
        colorCanvas.width = colorCanvas.height = 1;
        const colors = colorCanvas.getContext("2d")!;
        const luminance = (rgb: number[]) => rgb.map(channel => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);

        return pairs.map((pair, index) => {
          const element = document.getElementById(`glass-pair-${index}`)!;
          const bounds = element.getBoundingClientRect();
          colors.clearRect(0, 0, 1, 1);
          colors.fillStyle = getComputedStyle(element).color;
          colors.fillRect(0, 0, 1, 1);
          const foreground = Array.from(colors.getImageData(0, 0, 1, 1).data);
          const pixels = context.getImageData(Math.ceil(bounds.x) + 1, Math.ceil(bounds.y) + 1, Math.max(1, Math.floor(bounds.width) - 2), 18).data;
          let ratio = Infinity;
          for (let i = 0; i < pixels.length; i += 4) {
            const background = [pixels[i], pixels[i + 1], pixels[i + 2]];
            const text = background.map((value, j) => foreground[j] * foreground[3] / 255 + value * (1 - foreground[3] / 255));
            const a = luminance(background), b = luminance(text);
            ratio = Math.min(ratio, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
          }
          return { ...pair, ratio };
        });
      }, { png: png.toString("base64"), pairs });

      evidence.push({ width, dark, offset, results });
    }
    writeFileSync(test.info().outputPath("glass-contrast-evidence.json"), JSON.stringify(evidence, null, 2));
    const failures = evidence.flatMap(view => view.results.filter(pair => !Number.isFinite(pair.ratio) || pair.ratio < 4.5)
      .map(pair => ({ dark: view.dark, offset: view.offset, ...pair })));
    expect(evidence.flatMap(view => view.results)).toHaveLength(540);
    expect(failures, "Every Glass pair must meet 4.5:1 at every sampled backdrop position").toEqual([]);
  });
}
