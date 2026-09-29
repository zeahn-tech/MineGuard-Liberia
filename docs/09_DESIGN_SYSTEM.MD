# 09 — Design System — Papery

**Status:** implemented in `src/index.css`; used across all pages.

## Concept

Newspaper / editorial. Warm paper, quiet ink, thin rules, serif hierarchy,
generous whitespace. Operational clarity over decoration; minimal animation.

## Tokens

| Token | Light | Dark |
|-------|-------|------|
| background (paper) | `#F0EEE6` | `#191713` |
| foreground (ink) | `#232019` | `#E9E6DB` |
| card | `#F8F7F2` | `#201E19` |
| primary (ink) | `#232019` | `#E9E6DB` |
| secondary / muted | `#E6E3D8` | `#2A2820` |
| destructive | `#9C2B1E` | `#D4685C` |
| border | `#D5D1C2` | `#3A372E` |
| chart 1–5 | `#2C5545 #9C2B1E #B07D2B #3E4C66 #6B6558` | lightened equivalents |

Radius is deliberately small (`0.25rem`) for a crisp, print-like feel.

## Typography

- Headings: Source Serif 4 / Noto Serif / Georgia stack (`.display` utility:
  serif, weight 600, tight leading, slight negative tracking).
- Body: Inter / Helvetica stack.
- Codes and stamps: Spline Sans Mono / IBM Plex Mono stack.
- `.kicker` — small caps section label above headlines (11px, letterspaced).

## Signature elements

- `.paper` — card with hairline border and faint inset grain.
- `.rule`, `.rule-double` — newspaper hairlines and double rules.
- `.stamp` — bordered mono status tag used for lifecycle/verification states.
- `.stat-figure` — tabular serif numerals for statistics.
- `.paper-grain` — subtle page texture on full-screen surfaces.

## Component conventions

- Tables: hairline row dividers, muted header row, hover accent only.
- Statuses always rendered as stamps; severity color only for high/critical.
- Buttons: square-ish (radius-sm), ink primary, outline secondary.
- Motion: opacity fades only; no parallax, bounce, or decorative motion.

## Accessibility rules

- Body text ≥ 14px; muted text tested against paper background.
- Contrast: ink on paper ≈ 13:1; muted text ≈ 5.5:1.
- Focus visible via ring token; touch targets ≥ 36px.

## Accessibility audit [EXECUTED 2026-09-28 — five core flows]

Per docs/16 definition-of-done item 5. Method: static source audit of every
interactive element, dialog, form control, image, and landmark across the
target flows (F1 public report, F2 sign-in, F3 staff sites, F4 field
inspections, F5 operator compliance), plus programmatic WCAG contrast
computation over the actual design tokens. Findings and fixes recorded in
`tests/accessibility-audit.test.ts`, which pins the fixes so they cannot
regress.

**Confirmed defects found and fixed:**

1. **Contrast (WCAG AA failure)** — `--muted-foreground` #6b6558 on
   `--accent` measured **4.20:1** (min 4.5). Token darkened to #5d5648:
   ≥4.95:1 on every surface it renders against (paper 6.25, card 6.77,
   secondary 5.66, accent 5.27).
2. **No skip navigation** — neither portal shell had a skip link and `<main>`
   carried no id. Both shells now render a "Skip to main content" link
   (visually hidden until focused) targeting `#main-content`.
3. **Keyboard-unreachable navigation rows** — the Inspections and Sites
   tables activate on click only. Rows are now `tabIndex={0}` with
   Enter/Space activation, a focus-visible outline, and an aria-label.
4. **Keyboard-unreachable accordion** — the template editor's section
   headers were clickable divs. Now `role="button"`, `tabIndex={0}`,
   `aria-expanded`, Enter/Space handling.
5. **Placeholder-only form inputs** — all seven Auth page inputs (sign-in,
   sign-up, MFA code, recovery, new-password) announced nothing to screen
   readers; each now carries an `aria-label`.
6. **Unassociated labels** — the new-inspection dialog's two selects and the
   draft form's question controls (select/number/text per answer key) had no
   label association; fixed with htmlFor/id pairs keyed `q-si:qi`.
7. **Notification bell disclosure semantics** — no `aria-expanded` /
   `aria-haspopup`, no Escape close, keyboard-tabbable click-away layer.
   Fixed: expanded state exposed, Escape closes, click-away `aria-hidden`.

**Verified already compliant (no change needed):** Radix dialogs (focus
trap, Escape, aria-modal, labelled via DialogTitle — all audited dialogs
have one); native `<select>` controls (keyboard-operable by default);
icon-only buttons carried aria-labels; evidence thumbnails and the MFA QR
code have alt text; the evidence opener is a real `<button>`.

**Residual honest limits:** the audit is static-source + token-mathematics;
it cannot execute a live screen reader or measure real focus order inside
running dialogs. A guided assistive-technology pass (NVDA/VoiceOver on the
deployed app) remains [PLANNED] and is recommended before pilot launch.
Touch-target size is enforced by the design system (buttons ≥ 36px) but not
per-element measured here.
