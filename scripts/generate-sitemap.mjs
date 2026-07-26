import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const SITE_HOST = "https://cadviewer.xyz";

const routes = JSON.parse(
  readFileSync(path.join(rootDir, "src/siteRoutes.json"), "utf-8")
).filter((entry) => entry.path);

const lastmod = new Date().toISOString().split("T")[0];

const urlEntries = routes
  .map(
    ({ path: routePath, changefreq, priority }) => `  <url>
    <loc>${SITE_HOST}${routePath}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`
  )
  .join("\n");

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>
`;

const outPath = path.join(rootDir, "public/sitemap.xml");
writeFileSync(outPath, sitemap);

console.log(`Generated sitemap.xml with ${routes.length} URLs -> public/sitemap.xml`);
