---
name: ui-standard
description: Use when designing, building, restyling or reviewing any user interface, unless the project has its own UI standard; show a clickable mockup before building, judge the result with five measured questions and a grayscale checklist, keep colour and material restrained, use regular spacing and one set of sizes, and have another model accept the screenshots.
trigger: auto
when: 设计、实现、改版或审查界面时生效；项目已有自己的界面规范时以项目为准
requires: none
title: 界面规范
summary: 先出可点击设计稿再动手，按五个量化问题和灰度清单验收，颜色克制、间距成刻度；截图由另一个模型验收。
---

# UI standard

## When this applies

Read and follow this skill whenever you design, build, restyle or review any user interface: a new screen, a component,
a theme, a table, an animation or a layout fix. It is not needed for a change that touches no visible interface.
If the project has its own UI standard or design-system skill in skills/, .claude/skills/ or .codex/skills/, or names
one as a word in its root AGENTS.md or CLAUDE.md, follow the project's standard instead; its tokens and palette win over
the defaults below.

## What to do

1. **Show before building.** For anything more than a small fix, make a clickable HTML mockup with three toggles:
   current, proposal and notes. For a restyle, draw several named concepts to pick from, each built as CSS and SVG and
   never as a pasted picture. Record every decision the user makes and do not propose it again.
2. **Measure the five questions** on the design (see "The five measured questions"). Answer with numbers, not taste.
3. **Judge the grayscale checklist first**, with colour removed (see "Grayscale checklist"), then add colour on top of
   a layout that already works.
4. **Build from the owning tokens.** Find the token or rule that owns a value before changing it (see "Styles") and
   change the source. Follow the palette, colour, size and rhythm rules below.
5. **Make it crisp and calm:** whole-pixel sizes, one icon family, motion that respects reduced motion (see "Motion"
   and "Crispness").
6. **Verify in the running app** with screenshots from an isolated profile in light and dark, at the default, a mid
   (about 1100px) and the minimum width. Another model accepts the screenshots, never their author.

### The five measured questions

Measure the application's own interface only, not wallpapers, photos or brand marks.

| # | Question | Metric | Pass |
| --- | --- | --- | --- |
| 1 | Is there one clear focus? | Elements at the largest font size; the next size down | 1; at most 0.8x of it |
| | | Solid primary buttons in view | at most 1 |
| | | A 12px-blurred grayscale screenshot | what stands out is the intended focus |
| 2 | Is alignment uniform? | Distinct left edges per pane | at most 4 |
| | | Near-misses (edges 1 to 3px apart) | 0 |
| | | Vertical centres within one row | differ by at most 1px |
| 3 | Is spacing regular? | Padding, margin and gap values off the scale | 0 |
| | | Distinct spacing values | at most 8 |
| | | Repeated rows or cards | identical heights and gaps |
| 4 | Are colour and material restrained? | Chromatic hue families | at most 5 semantic colours |
| | | Chromatic background area of a pane | at most 5% |
| | | Backdrop filters, box shadows, translucent surfaces | at most 2, 3 and 4 |
| 5 | Is it one product? | Distinct border radii | at most 4, from one set |
| | | Font sizes and weights | at most 6 and 3 |
| | | Button variants and heights | at most 2 variants, one height |
| | | Transition duration and easing | one of each |
| | | Icon family and sizes | one family, at most 3 sizes |

Name any deliberate exception in the report with its reason; never pass it silently.

### Grayscale checklist

Judge the page converted to grayscale, and the blurred screenshot, at the default size, a mid size and the minimum
size. Report each item as PASS or FAIL with the screenshot and what was measured.

1. With the text ignored, the primary action area stands out first.
2. Cards, inputs and buttons take their radii from one stated rule.
3. Primary, secondary and placeholder text are clearly different in lightness, measured from pixels.
4. The selected item in a list is recognisable without any brand colour, by a fill and an indicator.
5. Inputs, menus and buttons have a clear click area: visible bounds or a hover fill, at least 32px tall.
6. At a small window there is no crowding and no abnormally clipped text.
7. Every border is necessary: no double outlines (a box plus an inner field, a card plus a pane) and no heavy strokes.

### Light theme

- A light theme is not an inverted dark theme. It speaks the dark theme's visual language with its own values.
- Borders and dividers are lighter than instinct says; text is never lightened to match them.
- White carries content (cards, menus, a focused item); light grey marks what is interactive (hover, selected, inputs).
- Use one soft hover shadow at most, for example `0 4px 12px rgb(0 0 0 / .05)`. No gradients, no glass, no tinted panels.
- Text contrast is at least 4.5:1 on every surface it sits on; check the selected and hover surfaces too.
- Default reference palette, used only when the project has none of its own:

| Role | Value |
| --- | --- |
| Canvas | #F8F9FB |
| Panels and cards | #FFFFFF |
| Sidebar | #F7F8FA |
| Input | #FAFAFB |
| Hover | #F3F5F7 |
| Selected | #E9EBEF |
| Border | #E4E7EB |
| Active border | #A8B7C9 |
| Divider | #ECEDF0 |
| Primary text | #24272D |
| Secondary text | #69717D |
| Success | #438F73 |

### Colour

- Everything is neutral grey except the semantic states (succeeded, running, needs attention, failed) and brand marks.
- Colour goes on icons and indicators (a check, a cross, a dot, a ring, a bar), never as a fill of a pill, card or panel.
- There is no separate accent colour: a checked switch, a picked option or the active tab uses the text colours.
- Every state also has a shape or a word, so it still reads in grayscale: a filled or hollow dot, a ring, a tag's text.

### Sizes and rhythm

- Spacing comes from one scale: 4, 8, 12, 16, 24, 32, 40, 48, 64 (in logical px).
- One radius rule: a fixed radius per kind of element (region, card, container, control, tag), stated once and reused.
- At most 6 font sizes and 3 weights. Hierarchy comes from size, contrast and spacing, not from heavier weights.
- Controls are at least 32px tall. Use one icon family, with a stroke weight that matches the text beside it.
- A component keeps the same radius, font, icon size, box and hover feedback at every width. When space runs out, hide
  a label, ellipsize or wrap the row; never shrink a control or wrap text inside it.

### Tables and lists

- When a table scrolls sideways, pin the identifying column on the left and the status column on the right.
- A status is a mark plus a word, never colour alone.
- Keep an empty table with its headers; do not replace it with a blank area.
- Wrap long paths after separators, one item per line.
- Counts and totals come from structured data, never parsed from displayed text.

### Motion

- Never spin a border to mean busy. Send soft rings outward from the mark, fading as they spread.
- A hover hop (a one-shot movement of an item) hangs its `:hover` on the element that does not move, never on the moving
  item, or an item hopping out from under the pointer restarts forever.
- Stop every loop and hop under reduced motion, and keep durations and easing to one set.

### Crispness

- Use whole-pixel sizes and positions; no fractional translate or scale on text or icons at rest.
- An odd stroke width sits on half-pixel coordinates; icons are vectors, never bitmaps.
- Check zoomed crops at 100%, 150% and 200% scaling: edges are sharp and no glow bleeds into text.

### Styles

- Before changing a value, search the shared tokens and the feature styles for the owning token or rule.
- Change the source rule or token; do not stack overrides on top of it.
- When a token has per-theme or per-layout overrides, update every one of them together.
- Verify computed styles in the running app, not by reading CSS: a change can build and still make no visible difference.

## Rules

- Mockup first for anything beyond a small fix; the user's earlier decisions are kept and not re-proposed.
- Measure with numbers; judge layout in grayscale before colour.
- Colour only on icons and indicators for semantic states; no coloured fills, gradients, glass or tinted panels.
- Spacing from the scale, at most 6 font sizes and 3 weights, controls at least 32px tall, one icon family.
- Change the owning token or rule, never stack overrides.
- No spinning borders, honour reduced motion, and never let a text be clipped or the page scroll sideways.
- The author never accepts their own screenshots; another model does.

## Done when

- The mockup was shown and the user's decisions are recorded, or the change was small enough to need none.
- The five questions have measured numbers that pass, and each grayscale item is PASS with a screenshot, or the
  deliberate exception is named with its reason.
- Screenshots from an isolated profile in light and dark at the default, a mid and the minimum width show no page-level
  horizontal scroll and no clipped text, and computed styles in the running app match the intent.
- Another model has accepted the screenshots. Report the files changed, the measured numbers and any exception.
