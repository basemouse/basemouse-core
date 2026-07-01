# BaseMouse Design System — "Terminal Industrial"

Approved 2026-06-11 via /plan-design-review (docs/designs/website-redesign.md).
The reference mockup is law: `docs/designs/website-redesign-mockup.html`.
Every page BaseMouse ships — marketing, /claim, future docs/dashboard — uses
this system. If a change can't cite a token or rule below, it doesn't ship.

## Identity

Near-black industrial surface, one amber signal color, monospace truth.
The site speaks fluent developer: spec-sheet density, uppercase micro-labels,
a live terminal as the centerpiece. We sell auditability — the design behaves
like something you'd audit.

Voice: utility language, zero hype. House line: "NO BLACK BOXES. NO SILENT EDITS."

## Tokens (CSS variables — never hardcode these values)

```css
--bg: #0b0b09;          /* near-black ground            */
--panel: #121310;       /* raised surfaces              */
--line: #262722;        /* hairlines                    */
--line-hot: #3a3b33;    /* emphasized borders           */
--fg: #e8e6df;          /* body text                    */
--dim: #8b897f;         /* secondary text — ≥16px ONLY  */
--amber: #ffb000;       /* THE signal color             */
--amber-ink: #1a1404;   /* text on amber                */
--amber-dim: rgba(255,176,0,.14);  /* tinted fills      */
--ok: #9acd32;          /* status-good only             */
```

## Type

- **Display:** Archivo 800/900, `font-stretch` 110–125%, UPPERCASE, line-height ≈ .95
- **Everything else:** JetBrains Mono 400/500/700
- **Micro-labels:** 11.5–13px, UPPERCASE, letter-spacing .08–.16em, `--dim`
- **Body floor: 16px.** `--dim` on `--bg` is 4.6:1 — passes WCAG only at ≥16px.
- ALL-CAPS display headlines carry sentence-case `aria-label`s.

## Components

| Component | Anatomy |
|---|---|
| `terminal-window` | bar (3 hollow squares + session label) + body; the homepage hero instance is LIVE |
| `capability-row` | `/0N` amber index · uppercase title · dim copy · big amber stat |
| `rate-cell` | plan column; featured = `--amber-dim` fill; ends in its own GET KEY button |
| `spec-strip` | inline `UNIT/REV/STORE` metadata row — replaces "eyebrow" labels |
| `topbar` | wordmark · ● live status · nav · amber GET YOUR KEY pill |

## Brand

**BASE MOUSE** in Archivo Black (MOUSE in amber) + the pictorial mouse mark,
recolored to the system: original linework, amber strokes on a `--panel` tile,
`--ok` green dot (it echoes the live-status badge). The mark is also the
favicon. `theme-color: #0b0b09`. (Decision 7B's wordmark-only call was
reversed by the user after seeing it live — the mark stays, the purple died.)

## Motion (exactly these; all comprehension-serving)

1. Hero session self-types on first load (once per session, skipped under
   `prefers-reduced-motion`).
2. Capability stats count up on first scroll-into-view.
3. Cursor blink (`steps(1)`, 1.1s).

## Accessibility (hard requirements)

- Scanline overlay: opacity ≤ .35; removed under `prefers-reduced-motion`
  AND `prefers-contrast: more`.
- Amber buttons use `--amber-ink` text (≈12:1).
- Interactive terminal: real `<input>` with visible amber focus ring and label;
  chips are `<button>`s with ≥44px touch targets.
- Tab order: topbar → terminal input → chips → sections. Skip-link present.
- All content through `textContent` — no innerHTML (XSS posture, see app.js).

## Responsive intent (not "it stacks")

- **≥1100px** — hero 5/6 split; capability rows 4-col; rate card 3-col.
- **700–1100px** — headline ABOVE terminal (terminal stays full-width: it is
  the anchor); capability stat becomes a trailing inline badge.
- **<700px** — topbar reduces to brand + GET KEY; terminal min font 16px;
  capability rows stack with hairline separators; rate card vertical, Team first.

## Prohibited (the slop list)

Purple anywhere · icon-in-circle decorations · centered-everything ·
uniform rounded-everything · decorative blobs/waves/gradients · emoji as
design elements · system font stacks · cards that don't earn their existence ·
"eyebrow + h2" mood-repetition sections.
