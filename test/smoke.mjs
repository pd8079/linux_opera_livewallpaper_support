import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(join(projectRoot, file), "utf8");

const manifest = JSON.parse(await read("manifest.json"));
assert.equal(manifest.manifest_version, 3, "the extension must use Manifest V3");
assert.equal(manifest.chrome_url_overrides?.newtab, "newtab.html", "new-tab override is missing");
assert.deepEqual(manifest.permissions, ["storage"], "permissions should stay minimal");
assert.equal(manifest.host_permissions, undefined, "the extension must not request host permissions");

for (const file of ["newtab.html", "styles.css", "app.js", "README.md"]) {
  const contents = await read(file);
  assert.ok(contents.length > 0, `${file} must not be empty`);
}

const html = await read("newtab.html");
assert.match(html, /id="wallpaper-video"/, "the new-tab page needs a video element");
assert.match(html, /id="video-import"/, "the new-tab page needs a local file input");
assert.match(html, /id="wallpaper-list"/, "the new-tab page needs a wallpaper library");
assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i, "scripts must be packaged locally");

const app = await read("app.js");
for (const [pattern, description] of [
  [/indexedDB/, "IndexedDB"],
  [/globalThis\.chrome\?\.storage\?\.local/, "chrome.storage.local"],
  [/URL\.createObjectURL/, "object URL playback"],
  [/elements\.video\.play\(\)/, "video playback"],
  [/video\/mp4/, "MP4 validation"],
  [/video\/webm/, "WebM validation"],
  [/prefers-reduced-motion/, "reduced-motion handling"],
  [/activationQueue/, "serialized wallpaper activation"],
  [/sourceToken/, "stale media-event protection"]
]) {
  assert.match(app, pattern, `app.js is missing the ${description} behavior`);
}
assert.doesNotMatch(app, /\beval\s*\(/, "runtime code execution is not allowed");
assert.doesNotMatch(app, /new\s+Function\s*\(/, "dynamic functions are not allowed");
assert.doesNotMatch(app, /https?:\/\//, "the extension must not fetch remote code or media");

console.log("Extension manifest and offline source smoke checks passed.");
