import { BrandMark } from "@/components/BrandMark";
import {
  LEGAL_PRODUCT,
  LEGAL_UPDATED,
  LEGAL_VERSION,
  formatLegalDate,
  legalContactEmail,
} from "@/lib/legal";
import { reopenConsent } from "@/lib/consent";
import { ArrowLeft } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";

export type LegalSection = { id: string; title: string; body: ReactNode };

/** Footer / inline links to the two legal pages. */
export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <span className={className}>
      <Link to="/terms" className="underline underline-offset-4 hover:text-foreground">
        Terms of Use
      </Link>
      <span aria-hidden="true"> · </span>
      <Link to="/privacy" className="underline underline-offset-4 hover:text-foreground">
        Privacy Policy
      </Link>
      <span aria-hidden="true"> · </span>
      <Link to="/cookies" className="underline underline-offset-4 hover:text-foreground">
        Cookie Policy
      </Link>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        onClick={reopenConsent}
        className="underline underline-offset-4 hover:text-foreground"
      >
        Cookie settings
      </button>
    </span>
  );
}

/** "email the program office at x" — or, when no address is configured, a
 *  pointer to the program office that provides access (never an invented one). */
export function ContactLine() {
  const email = legalContactEmail();
  return email ? (
    <>
      email the program office at{" "}
      <a className="underline underline-offset-4" href={`mailto:${email}`}>
        {email}
      </a>
    </>
  ) : (
    <>contact the MineGuard Liberia program office (the administrators who provide access to the platform)</>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-foreground/90">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-foreground/90 marker:text-muted-foreground">{children}</ul>;
}

export function Sub({ children }: { children: ReactNode }) {
  return <h3 className="pt-1 text-sm font-semibold">{children}</h3>;
}

/** Shared page shell for the Terms of Use and the Privacy Policy. */
export function LegalLayout({
  kicker,
  title,
  intro,
  sections,
  other,
}: {
  kicker: string;
  title: string;
  intro: ReactNode;
  sections: LegalSection[];
  other: { to: string; label: string };
}) {
  const navigate = useNavigate();

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} — ${LEGAL_PRODUCT}`;
    window.scrollTo(0, 0);
    return () => {
      document.title = previous;
    };
  }, [title]);

  // The app uses hash routing, so "#section" links would be read as routes:
  // scroll programmatically instead.
  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };

  return (
    <div className="min-h-screen min-w-0 bg-background paper-grain">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-4 md:px-8">
          <Link to="/" className="flex min-h-9 min-w-0 items-center gap-2">
            <BrandMark className="size-5 shrink-0" />
            <span className="display text-base whitespace-nowrap">{LEGAL_PRODUCT}</span>
          </Link>
          <button
            type="button"
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
            className="inline-flex min-h-9 shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" /> Back
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl min-w-0 px-4 py-10 md:px-8">
        <p className="kicker">{kicker}</p>
        <h1 className="display mt-2 text-3xl break-words md:text-4xl">{title}</h1>
        <p className="mt-2 text-xs text-muted-foreground">
          Version {LEGAL_VERSION} · Effective {formatLegalDate(LEGAL_UPDATED)}
        </p>
        <div className="mt-5 space-y-3">{intro}</div>

        <nav aria-label={`${title} contents`} className="paper mt-8 p-4">
          <p className="kicker mb-2">Contents</p>
          <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {sections.map((s, i) => (
              <li key={s.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => jump(s.id)}
                  className="min-h-7 w-full text-left text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {i + 1}. {s.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10">
          {sections.map((s, i) => (
            <section key={s.id} aria-labelledby={`${s.id}-h`} className="min-w-0">
              <h2
                id={s.id}
                tabIndex={-1}
                className="display scroll-mt-6 border-b border-border pb-2 text-xl break-words outline-none"
              >
                <span id={`${s.id}-h`}>
                  {i + 1}. {s.title}
                </span>
              </h2>
              <div className="mt-4 space-y-3 break-words">{s.body}</div>
            </section>
          ))}
        </div>

        <footer className="mt-14 border-t border-border pt-6 text-xs text-muted-foreground">
          <p>
            {LEGAL_PRODUCT} · Terms, Privacy and Cookie Policy version {LEGAL_VERSION}, effective{" "}
            {formatLegalDate(LEGAL_UPDATED)}. Not an official Government of Liberia system;
            designed for potential government adoption.
          </p>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <Link to={other.to} className="underline underline-offset-4 hover:text-foreground">
              {other.label}
            </Link>
            <Link to="/" className="underline underline-offset-4 hover:text-foreground">
              Home
            </Link>
          </p>
        </footer>
      </main>
    </div>
  );
}

