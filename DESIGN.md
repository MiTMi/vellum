---
name: Vellum
description: Ink on vellum — a warm paper ground, one red used as rubrication, and typography doing the work of decoration.
colors:
  vellum: "#fbfaf7"
  vellum-deep: "#f3f1ea"
  paper: "#ffffff"
  ink: "#1c1a17"
  ink-muted: "#6e6a62"
  ink-dark-ground: "#1c1a17"
  ink-dark-text: "#efece5"
  ink-dark-muted: "#a9a399"
  minium: "#b23a2c"
  minium-deep: "#962f23"
  minium-light: "#d4553f"
  hairline: "#e6e2d8"
typography:
  display:
    fontFamily: "Newsreader Variable, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(34px, 6.4vw, 72px)"
    fontWeight: 560
    lineHeight: 1.04
    letterSpacing: "-0.018em"
  headline:
    fontFamily: "Newsreader Variable, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(30px, 3.8vw, 42px)"
    fontWeight: 550
    letterSpacing: "-0.008em"
  title:
    fontFamily: "Newsreader Variable, Iowan Old Style, Georgia, serif"
    fontSize: "19px"
    fontWeight: 500
    fontStyle: "italic"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
rounded:
  xs: "2px"
  sm: "4px"
  md: "7px"
  lg: "9px"
  xl: "10px"
  pill: "50%"
spacing:
  xs: "8px"
  sm: "10px"
  md: "12px"
  lg: "20px"
  xl: "28px"
  section: "96px"
  gutter: "72px"
components:
  button-primary:
    backgroundColor: "{colors.minium}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 22px"
    height: "46px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.minium-deep}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 22px"
    height: "46px"
  button-small:
    height: "34px"
    padding: "0 14px"
  input-search:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 16px 0 44px"
    height: "48px"
  card-sheet:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.xl}"
  card-feature:
    backgroundColor: "{colors.vellum}"
    rounded: "{rounded.md}"
    padding: "28px 26px 30px"
---

# Design System: Vellum

## Overview

**Creative North Star: "The Scriptorium"**

A warm sheet, dark ink, and a second ink in red kept for marking. The
system takes its logic from the manuscript room: the ground is vellum
rather than white, the display face is a text serif rather than a
display face, and the one saturated color in the palette is not a brand
color at all — it is *rubrication*, the scribe's practice of marking
structure in red lead so a reader can find their way through a page of
unbroken text. Pilcrows, section eyebrows, the blinking caret, and the
primary action are all the same gesture: a mark, not a decoration.

The density is editorial rather than promotional. Sections breathe at
96px, body copy sits at 17px with a 1.6 line-height, and the page is
mostly type and space — an eyebrow is italic serif in red, not a pill; a
section marker is a pilcrow, not an icon. Where a graphic element is
needed, it is a sheet of paper: bordered, softly shadowed, and slightly
warmer than the ground it rests on. The hero is not an illustration of
the product but a hand-built facsimile of one of its documents, whose
page title is literally the page's `<h1>`.

Components are papery and tactile — the material metaphor is the point,
and the confirmed direction is to lean into it rather than flatten it.
Note honestly that the current implementation is more restrained than
that character implies: outside the hero sheet and the screenshots,
surfaces are flat and separated by hairlines. **That gap is headroom for
future landing work, not a defect to correct silently.**

**Key Characteristics:**

- One accent, used as a marking practice and nothing else
- A text serif (Newsreader) carrying display duty; Inter for reading
- Warm paper ground (#fbfaf7), never pure white as the page
- Hairlines separate; shadows are reserved for things that are paper
- Motion is a load-in and a hover hint, fully disabled under
  `prefers-reduced-motion`
- One deliberate inversion: a single ink-dark band, used once

**Scope.** This file documents the **landing family only** — `/`, `/help`
and `/legal`, all driven by `src/landing/landing.css`. The workspace app
at `/app` has its own visual system in `src/styles/app.css`, and it is
**frozen by product constraint**: its UI and UX are preserved exactly as
they are, and no design work applies to it. See PRODUCT.md.

**Confirmed rejection:** this world is **not dark-mode-first**. The
ground is warm light paper; dark appears only as the one inverted
principles band, never as a default or an alternate theme.

Other constraints commonly assumed for a system like this — that it must
stay quiet, avoid animation, or avoid category conventions — were offered
and **not** confirmed. They are not prohibitions here. The incumbent
voice is restrained, but future landing work is free to be bolder.

## Colors

A warm, low-chroma paper palette with a single saturated red held in
reserve for marking.

### Primary

- **Minium** (`#b23a2c`): the red lead of manuscript rubrication — the
  pigment that gives "miniature" its name. Used only for marks: pilcrows,
  the italic serif eyebrow above each section, the hero caret, and the
  primary button's fill. **Deep Minium** (`#962f23`) is its pressed and
  hovered state. **Light Minium** (`#d4553f`) exists solely so the mark
  survives on the ink-dark band, where the base red goes muddy.

### Neutral

- **Vellum** (`#fbfaf7`): the page ground. Warm, off-white, never `#fff`.
  Everything sits on this unless it is meant to read as a separate sheet.
- **Deep Vellum** (`#f3f1ea`): one step down, for tiles and callouts that
  need to recede from the ground rather than lift off it.
- **Paper** (`#ffffff`): pure white, and *only* for surfaces that
  represent an actual sheet — the hero document, band sections, cards.
  Its job is contrast against Vellum, not to be the page.
- **Ink** (`#1c1a17`): body and heading text. Warm near-black, never
  `#000`.
- **Muted Ink** (`#6e6a62`): secondary copy, captions, the ghost drag
  handle that appears on block hover.
- **Hairline** (`#e6e2d8`): every border and divider in the system.
- **Ink Dark Ground** (`#1c1a17`), **Ink Dark Text** (`#efece5`), **Ink
  Dark Muted** (`#a9a399`): the inverted principles band only.

### Named Rules

**The Rubrication Rule.** Minium marks structure; it never fills, tints,
or decorates. If a red element is not a pilcrow, an eyebrow, a caret, or
the single primary action, it is wrong. The rarity is what makes the mark
legible.

**The Warm Ground Rule.** The page is Vellum, not white. Pure `#ffffff`
means "this is a sheet resting on the page" — using it as a background
collapses the entire material metaphor.

## Typography

**Display Font:** Newsreader Variable (with Iowan Old Style, Georgia,
serif)
**Body Font:** Inter (with the system UI stack)
**Mono Font:** `ui-monospace`, SF Mono, Menlo

Both faces are bundled locally via `@fontsource` imports in `landing.ts`
— **never a CDN `<link>`**, because the PWA precache picks the woff2 files
up from the bundle and a CDN reference would break the offline shell.

**Character:** Newsreader is a *text* serif asked to do display work, so
headings read as prose set large rather than as a logo. Paired with Inter
for body copy, the page looks like a document that has been typeset, not
a website that has been branded. The italic serif eyebrow is the hinge
between the two: it is the one place the serif appears small, and it is
always red.

### Hierarchy

- **Display** (560, `clamp(34px, 6.4vw, 72px)`, 1.04, -0.018em): the hero
  document's title. Appears once per page. The floor is deliberately low —
  raising it overflows the narrowest phones — so the scale is carried by
  the `vw` rate and the ceiling, not by the minimum.
- **Headline** (550, `clamp(30px, 3.8vw, 42px)`, -0.008em): section
  titles. The CTA band runs slightly larger (`clamp(32px, 4.2vw, 46px)`)
  and deep-dive rows slightly smaller (`clamp(28px, 3.4vw, 38px)`) — one
  family, three weights of emphasis.
- **Title** (500, 19px, italic serif, Minium): the eyebrow. Structural
  label above a section, always preceded by a pilcrow.
- **Body** (400, 17px, 1.6): all reading copy. The hero subhead steps up
  to 19px.
- **Label** (500, 12.5px): nav, meta, and small UI text.

### Named Rules

**The Prose-Not-Logo Rule.** Headings are set in a text serif and never
tracked out, uppercased, or letterspaced as a wordmark. Negative tracking
(-0.008em to -0.01em) tightens them as size grows; that is the only
tracking adjustment in the system.

## Layout

A single centered column, `--wrap: 1072px`, with a 60px sticky nav
(`--nav-h`). Vertical rhythm is coarse and consistent: **96px** between
major sections, 72px as the gutter between a deep-dive row's copy and its
figure, and a small 8/10/12/20px scale for everything inside a component.

The nav is sticky and translucent — `rgba(251, 250, 247, 0.85)` with
`backdrop-filter: saturate(180%) blur(12px)` — and gains its hairline
bottom border only once the page has scrolled, so the top of the page
reads as an uninterrupted sheet.

Three breakpoints, each collapsing rather than rearranging: **980px**
(grids narrow), **860px** (deep-dive rows stack, figure below copy), and
**640px** (single column, hero type at its clamp floor, block hover
affordances suppressed). There is no separate mobile composition — the
same document reflows.

## Elevation & Depth

**The system is flat except where something is literally paper.** Depth
is carried by a 1px Hairline border and by the Vellum → Paper step in
ground color, not by shadow. Two shadows exist in the entire system, both
soft, both large-radius, and both applied only to surfaces that represent
a physical sheet.

### Shadow Vocabulary

- **Sheet** (`box-shadow: 0 1px 2px rgba(28,26,23,0.05), 0 16px 48px
  rgba(28,26,23,0.10)`): the hero document. A tight contact shadow plus a
  wide ambient one — the way a page sits on a desk.
- **Shot** (`box-shadow: 0 1px 2px rgba(28,26,23,0.05), 0 10px 34px
  rgba(28,26,23,0.09)`): product screenshots. The same recipe, lifted
  slightly less, so a screenshot never outranks the hero.

Both are tinted with the ink color rather than pure black, so the warmth
of the ground survives underneath them.

### Named Rules

**The Shadow-Means-Paper Rule.** A shadow declares "this is a sheet". If
an element is not representing a physical page, it gets a hairline
instead. Adding a shadow to a button, a nav, or a tile breaks the
system's only depth signal.

## Shapes

Soft, small, unfussy radii — nothing is pill-shaped and nothing is sharp.
The scale runs 2px (accent bars) → 4px (inline chips) → **7px (the
default: buttons, tiles)** → 9px (search fields) → 10px (sheets and
screenshots). Larger surfaces take larger radii, so curvature stays
optically constant.

Borders are always 1px Hairline. The one deliberate asymmetry in the
system is the agent chat mock's `14px 14px 4px 14px` — a speech bubble's
tail, and the only place a corner is allowed to differ from its siblings.

## Components

### Buttons

- **Shape:** gently curved (7px), 46px tall, 22px horizontal padding, 8px
  gap to any icon. A small variant runs 34px tall with 14px padding.
- **Primary:** Minium fill, white text, transparent border. This is the
  only filled element on the page and there is at most one per view.
- **Hover / Focus:** background shifts to Deep Minium over 0.15s ease.
  No lift, no scale, no shadow.
- **Secondary:** Paper fill, Ink text, Hairline border; on hover the
  border darkens to `#d1ccc0`. Everything happens at the edge.

### Cards / Containers

- **Corner Style:** 7px for feature tiles, 10px for anything reading as a
  sheet.
- **Background:** feature tiles use Vellum on a Paper band (recessive);
  sheets use Paper on the Vellum ground (raised).
- **Shadow Strategy:** none, unless the card *is* a sheet — see
  Elevation.
- **Border:** 1px Hairline.
- **Internal Padding:** 28px, asymmetric at the bottom (`28px 26px 30px`)
  to optically center text that has no descender room.

### Inputs / Fields

- **Style:** Paper fill, 1px Hairline, 9px radius, 48px tall, 16px text.
  The Help Center search insets its left padding to 44px to clear an
  inline 17px icon.
- **Focus:** border shifts toward Minium; no glow, no ring offset.
- **Placeholder:** Muted Ink.

### Navigation

- 60px tall, sticky, translucent Vellum with a saturating backdrop blur.
  Links are 12.5–14px Inter in Muted Ink, moving to Ink on hover over
  0.15s. The bottom hairline is transparent at rest and fades in on
  scroll — the only chrome that reacts to scroll position anywhere.

### The Pilcrow

The system's signature. A red ¶ in Newsreader, set upright, standing
before every section eyebrow. It is the smallest possible statement of
the whole thesis: this is a document, and someone has marked it up. It
carries no interaction and no meaning beyond structure, and it must not
be replaced with an icon, a bullet, a rule, or a colored bar.

### The Hero Sheet

Not a screenshot — a hand-built facsimile of a Vellum document, whose
page title *is* the `<h1>`. Its rows are `.block` elements that reveal a
ghost drag handle (`⠿`, Muted Ink) on hover at `left: -26px`, exactly as
the real editor does. Its checkbox ticks, load-in stagger, and blinking
caret are pure CSS, all suppressed under `prefers-reduced-motion`.

## Do's and Don'ts

### Do:

- **Do** keep Minium to marks only — pilcrow, eyebrow, caret, one primary
  action per view (The Rubrication Rule).
- **Do** set the page on Vellum (`#fbfaf7`) and reserve Paper (`#ffffff`)
  for surfaces that represent a sheet (The Warm Ground Rule).
- **Do** separate with 1px Hairline (`#e6e2d8`); reach for shadow only
  when the element is paper (The Shadow-Means-Paper Rule).
- **Do** set headings in Newsreader with negative tracking, as prose set
  large (The Prose-Not-Logo Rule).
- **Do** bundle fonts through `@fontsource` imports so the PWA precache
  captures them.
- **Do** wrap every animation in a `prefers-reduced-motion` escape, as
  the hero already does.
- **Do** check `src/help/help.css` before changing landing tokens — it
  defines **no `:root` of its own** and inherits this system wholesale, so
  `/help` and `/legal` restyle with `/`.
- **Do** update `scripts/e2e-landing.mjs` in the same commit as any
  structural change: it pins the `.hero h1` copy, 9 `.feature` cards, 7
  `.deep .row`s, the section anchors, and the CTA hrefs. `e2e-pwa.mjs`
  also asserts the headline.

### Don't:

- **Don't** introduce a dark default or a theme toggle. This world is
  light; the single inverted band is the exception that proves it.
- **Don't** use pure white as a page background or pure black as text.
- **Don't** add a second accent hue. If something needs emphasis and
  cannot be Minium, it should be emphasized with type or space instead.
- **Don't** put a shadow on a button, a nav, or a tile.
- **Don't** replace the pilcrow or the italic serif eyebrow with icons,
  bullets, or uppercase tracked-out labels.
- **Don't** letterspace or uppercase the serif.
- **Don't** load fonts from a CDN.
- **Don't** apply any of this to the workspace app at `/app` — its design
  is frozen by product constraint (PRODUCT.md).
