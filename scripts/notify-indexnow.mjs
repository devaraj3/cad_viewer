import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const SITE_HOST = "cadviewer.xyz";
const INDEXNOW_KEY = "e2782e29ad7b4cb1af8bb164ce461ddf";

const routes = JSON.parse(
  readFileSync(path.join(rootDir, "src/siteRoutes.json"), "utf-8")
).filter((entry) => entry.path);

const urlList = routes.map((route) => `https://${SITE_HOST}${route.path}`);

const body = {
  host: SITE_HOST,
  key: INDEXNOW_KEY,
  keyLocation: `https://${SITE_HOST}/${INDEXNOW_KEY}.txt`,
  urlList,
};

const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

console.log(`IndexNow response status: ${response.status}`);

if (response.ok) {
  console.log(`Success: notified IndexNow of ${urlList.length} URLs.`);
} else {
  const text = await response.text();
  console.error(`Failure: IndexNow rejected the request. ${text}`);
  process.exit(1);
}
