import type { ReactNode } from "react";
import { Link } from "react-router";
import { BrandMark } from "@/components/BrandMark";
import { LEGAL_PRODUCT } from "@/lib/legal";

// Content width of the page the banner sits above, so the brand and the action
// line up with the page's own column. Full class names (not interpolated) so
// Tailwind can see them.
const WIDTH = {
  lg: "max-w-lg",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
} as const;

/**
 * Top banner for the public (signed-out or pre-workspace) pages: legal
 * documents, the community report form and tracker, and the company
 * invitation / join pages. Sticky and translucent, identical in behaviour to
 * the staff portal, registry and operator top bars, so the brand link and the
 * page's action stay in reach while the page scrolls.
 *
 * `children` is the optional right-hand action (a link or button).
 */
export function PublicHeader({
  width = "3xl",
  children,
}: {
  width?: keyof typeof WIDTH;
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
      <div
        className={`mx-auto flex ${WIDTH[width]} items-center justify-between gap-3 px-4 py-4 md:px-8`}
      >
        <Link to="/" className="flex min-h-9 min-w-0 items-center gap-2">
          <BrandMark className="size-5 shrink-0" />
          <span className="display text-base whitespace-nowrap">{LEGAL_PRODUCT}</span>
        </Link>
        {children}
      </div>
    </header>
  );
}
