import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { PublicHeader } from "@/components/PublicHeader";
import { useAuth } from "@/hooks/use-auth";

const LINKS = [
  { to: "/public", label: "Home", end: true },
  { to: "/public/safety", label: "Safety information" },
  { to: "/public/glossary", label: "Glossary" },
  { to: "/public/notices", label: "Notices" },
  { to: "/report", label: "Report a concern" },
];

/** Page frame for the public information area (/public/*). Open to everyone — no sign-in needed;
 *  everything shown here is approved, published content. */
export function PublicShell({ title, kicker, intro, children }: { title: string; kicker?: string; intro?: string; children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  return (
    <div className="min-h-screen bg-background paper-grain">
      <PublicHeader width="3xl">
        <Link
          to={isAuthenticated ? "/account" : "/auth"}
          className="inline-flex min-h-9 shrink-0 items-center text-sm text-muted-foreground hover:text-foreground"
        >
          {isAuthenticated ? "My account" : "Sign in"}
        </Link>
      </PublicHeader>
      <nav aria-label="Public information" className="border-b border-border">
        <ul className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4 py-2 md:px-8">
          {LINKS.map((l) => (
            <li key={l.to} className="shrink-0">
              <NavLink
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  `inline-flex min-h-9 items-center rounded-md px-3 text-sm ${
                    isActive ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"
                  }`
                }
              >
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        {kicker && <p className="kicker">{kicker}</p>}
        <h1 className="display mt-2 text-3xl md:text-4xl">{title}</h1>
        {intro && <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{intro}</p>}
        <div className="mt-8">{children}</div>
        <p className="mt-12 border-t border-border pt-4 text-xs text-muted-foreground">
          Information on this site is published only after Ministry review. It is general guidance, not
          legal or medical advice. This is not an official Government of Liberia system.
        </p>
      </main>
    </div>
  );
}
