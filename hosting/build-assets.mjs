import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(here, "dist");
const cachePath = path.join(root, "ingest", ".public-feed-cache.json");
const allowedItemKeys = new Set([
  "tweet_id", "author_handle", "author_name", "author_avatar", "text", "media",
  "quoted", "created_at", "likes", "rts", "replies", "views", "url", "badge",
]);

const snapshot = JSON.parse(await readFile(cachePath, "utf8"));
if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) {
  throw new Error("Public-feed cache is missing or empty; refresh it through the ingest server before deploying.");
}
for (const item of snapshot.items) {
  for (const key of Object.keys(item)) {
    if (!allowedItemKeys.has(key)) throw new Error(`Refusing to publish unexpected public-feed field: ${key}`);
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.join(root, "ingest", "landing.html"), path.join(out, "index.html"));
await cp(path.join(root, "docs", "reader.png"), path.join(out, "landing-reader.png"));
await writeFile(path.join(out, "public-feed.json"), `${JSON.stringify(snapshot)}\n`);

console.log(`Built static landing assets with ${snapshot.items.length} sanitized cards from ${snapshot.generated_at}.`);
