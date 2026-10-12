/**
 * Builds a static, click-through preview of the public pages into preview-out/.
 *
 *   npm run preview:export
 *
 * It's for reviewing the design only: there's no server, so the registration
 * form simulates a successful submission, and /admin + /api are left out.
 * All links and asset paths are made relative so the folder can be opened
 * from any location (a static host, a zip, or a private preview link).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const tmp = path.join(os.tmpdir(), "unibee-preview-build");
const out = path.join(root, "preview-out");

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(out, { recursive: true, force: true });

const skip = new Set(["node_modules", ".next", ".preview-build", "preview-out", ".data", ".git", "out"]);
fs.cpSync(root, tmp, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(root, src);
    if (!rel) return true;
    if (skip.has(rel.split(path.sep)[0])) return false;
    return !/^src[\\/]app[\\/](api|admin)([\\/]|$)/.test(rel); // server-only parts
  },
});
fs.symlinkSync(path.join(root, "node_modules"), path.join(tmp, "node_modules"), "dir");

execSync("npx next build", {
  cwd: tmp,
  stdio: "inherit",
  env: { ...process.env, UNIBEE_PREVIEW_EXPORT: "1", NEXT_PUBLIC_PREVIEW_MODE: "1", NEXT_TELEMETRY_DISABLED: "1" },
});

fs.cpSync(path.join(tmp, "out"), out, { recursive: true });
fs.rmSync(tmp, { recursive: true, force: true });

// Make every absolute path relative (all pages sit at the folder root).
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
for (const file of walk(out)) {
  const ext = path.extname(file);
  if (![".html", ".js", ".css", ".txt"].includes(ext)) continue;
  let s = fs.readFileSync(file, "utf8");
  const before = s;
  if (ext === ".css") {
    s = s.replace(/url\((["']?)\/_next\/static\/media\//g, "url($1../media/");
  } else if (ext === ".js") {
    s = s.replace(/"\/_next\/"/g, '"./_next/"');
  } else {
    // Covers HTML attributes and the escaped copies inside the inline React payload,
    // so the server HTML and the client render stay identical.
    s = s.replace(/(["'(]|\\")\/(_next\/|icon\.png|apple-icon\.png|images\/|brand\/)/g, "$1./$2");
  }
  if (s !== before) fs.writeFileSync(file, s);
}
// Remove files the preview doesn't need.
for (const f of ["robots.txt", "sitemap.xml", "404.html"]) fs.rmSync(path.join(out, f), { force: true });
for (const f of walk(out)) if (f.endsWith(".txt")) fs.rmSync(f);
console.log(`\nPreview ready in ${path.relative(root, out)}/ (${walk(out).length} files)`);
