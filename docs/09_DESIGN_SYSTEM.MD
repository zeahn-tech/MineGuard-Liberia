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
