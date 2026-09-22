const { chromium } = require("playwright");

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("http://localhost:5173/viewer", { waitUntil: "networkidle" });
  await sleep(1000);
  const fileInput = page.locator('input[type="file"]');
  await fileInput.waitFor({ state: "attached" });
  await fileInput.setInputFiles("/Users/devaraj/Downloads/Drawings/Assembly Drawings/Machining Drawings/Stuffing Box Assembly.stp");
  const toggle = page.locator('xpath=//span[@class="cad-label" and text()="Explode View"]/following-sibling::button');
  await toggle.waitFor({ state: "visible", timeout: 180000 });
  await sleep(500);
  await toggle.click();
  let entries = null;
  for (let i = 0; i < 120; i++) {
    entries = await page.evaluate(() => window.__cadViewer?.computeExplodePlan?.() ?? null);
    if (Array.isArray(entries) && entries.length === 13) break;
    await sleep(500);
  }
  const restOverlaps = await page.evaluate(() => window.__cadViewer.checkExplodeOverlapsAtAmount(0));
  console.log("REST (amount=0) overlaps:", JSON.stringify(restOverlaps, null, 2));
  await browser.close();
}
run().catch((e) => { console.error(e); process.exit(1); });
