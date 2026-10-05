import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * In-page section jump that never mutates the URL hash.
 *
 * The app is served behind HashRouter: a raw `<a href="#section">` click
 * REWRITES location.hash, and the router parses whatever follows `#` as a
 * ROUTE — so `#principles` became route "principles", matched the `*`
 * catch-all and rendered the 404 page. Every in-page anchor therefore goes
 * through this handler: preventDefault keeps the router's hash intact while
 * the `href` stays for semantics and the element scrolls into view.
 */
export function sectionJump(id: string) {
  return (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };
}
