import logoUrl from "@/assets/logo.svg";
import { cn } from "@/lib/utils";

/**
 * MineGuard Liberia brand mark (Liberian flag, county map and pickaxe on a
 * shield). Decorative: every placement sits next to the visible wordmark
 * "MineGuard", so the image is hidden from assistive technology.
 *
 * Size it with a Tailwind `size-*` class; width/height attributes reserve the
 * default 24px box so the layout never shifts while the SVG loads.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden="true"
      width={24}
      height={24}
      decoding="async"
      draggable={false}
      className={cn("shrink-0 select-none rounded-[22%]", className)}
    />
  );
}
