/**
 * Link helpers. In the static click-through preview (npm run preview:export)
 * pages are plain .html files opened from a relative folder, so links and
 * public assets must be relative. In the real site these return the path as-is.
 */
export const IS_PREVIEW = process.env.NEXT_PUBLIC_PREVIEW_MODE === "1";

/** Internal page link, e.g. page("/services") or page("/#register"). */
export function page(href: string): string {
  if (!IS_PREVIEW || !href.startsWith("/")) return href;
  const [path, hash] = href.split("#");
  const file = path === "/" || path === "" ? "index.html" : `${path.slice(1)}.html`;
  return hash !== undefined ? `${file}#${hash}` : file;
}

/** File from /public, e.g. asset("/images/hero.webp"). */
export function asset(src: string): string {
  return IS_PREVIEW && src.startsWith("/") ? `.${src}` : src;
}

/** True when `href` points at the page currently shown. */
export function isActive(href: string, pathname: string): boolean {
  if (href.includes("#")) return false;
  if (IS_PREVIEW) {
    // Preview pages are files like ".../services.html", possibly inside a sub-folder.
    const file = pathname.split("/").pop() || "";
    const name = file.replace(/\.html$/, "");
    return href === "/" ? name === "" || name === "index" : name === href.slice(1);
  }
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
