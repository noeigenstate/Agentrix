---
name: ui-standard
description: Use when designing, building, restyling or reviewing any user interface, unless the project has its own UI standard; for UI building beyond a small fix, show a clickable mockup; judge the result with five measured questions and a grayscale checklist, keep colour and material restrained, use regular spacing and one set of sizes, and have another model accept the screenshots, or the user when no second model is available.
trigger: auto
when: 设计、实现、改版或审查界面时生效；项目已有自己的界面规范时以项目为准
requires: none
title: 界面规范
summary: 界面开发超出小修时先出可点击设计稿，按五个量化问题和灰度清单验收，颜色克制、间距成刻度；截图由另一个模型验收，没有时由用户验收。
---

# UI standard

## When this applies

Read and follow this skill whenever you design, build, restyle or review any user interface: a new screen, a component,
a theme, a table, an animation or a layout fix. It is not needed for a change that touches no visible interface.
Follow the user's instructions and the project's existing UI standard, design system, palette and component conventions,
wherever they are documented. Use the defaults below only where those sources do not specify a rule. If project sources
conflict, follow the currently accepted standard or the user's explicit choice and record the conflict.

## What to do

1. **Show before building.** For UI building beyond a small fix, show an interactive mockup appropriate to the target
   platform, with current, proposal and notes views; mark current N/A for a new screen. For a restyle, present several
   named concepts. Concept references may be images, but build the selected UI with the platform's interface
   primitives. Record the user's decisions and do not re-propose them. A review of an existing UI does not require a
   new mockup.
2. **Measure the five questions** on the design (see "The five measured questions"). Record numeric measurements for
   them. For visual judgments such as what stands out in the blurred image, record PASS or FAIL and explain the
   evidence rather than inventing a numeric score.
3. **Judge the grayscale checklist first**, with colour removed (see "Grayscale checklist"), then add colour on top of
   a layout that already works.
4. **Build from the owning tokens.** Find the token or rule that owns a value before changing it (see "Styles") and
   change the source. Follow the palette, colour, size and rhythm rules below.
5. **Make it crisp and calm:** whole logical-pixel sizes, one icon family, motion that respects reduced motion (see
   "Motion" and "Crispness").
6. **Verify in the running app.** Use isolated or safe test data. Check the applicable default, hover, pressed,
   disabled and busy states, keyboard focus and activation, scrolling and reduced motion. Capture every theme the
   product ships at the default viewport, a supported intermediate width between the default and minimum, and the
   minimum supported viewport. Record an unavailable size as N/A. Another model, or the user when no second model is available, accepts the screenshots, never
   their author; report that acceptance as outstanding until one of them has accepted.

### The five measured questions

Measure the application's own interface only, not wallpapers, photos or brand marks.

| # | Question | Metric | Pass |
| --- | --- | --- | --- |
| 1 | Is there one clear focus? | Visible text blocks at the largest font size; the next distinct font size down | 1; at most 0.8x of it |
| | | Solid primary buttons in view | at most 1 |
| | | A 12px-blurred grayscale screenshot | what stands out is the intended focus |
| 2 | Is alignment uniform? | Distinct left edges per pane | at most 4 |
| | | Near-misses (edges 1 to 3px apart) | 0 |
| | | Vertical centres within one row | differ by at most 1px |
| 3 | Is spacing regular? | Nonzero padding, margin and gap values off the scale 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 | 0 |
| | | Distinct nonzero spacing values | at most 8 |
| | | Repeated rows or cards | fixed-height groups have identical heights and gaps; content-driven groups may grow, with consistent gaps and padding |
| 4 | Are colour and material restrained? | Chromatic hue families | at most 5 semantic colours |
| | | Chromatic background area of a pane | at most 5% |
| | | Distinct non-none backdrop filters, non-none shadows and nonzero background alpha values | at most 2, 3 and 4 |
| 5 | Is it one product? | Distinct border radii | at most 4, from one set |
| | | Font sizes and weights | at most 6 and 3 |
| | | Button variants and heights | at most 2 variants; one standard height and at most one compact height inside rows |
| | | Nonzero transition durations and their easings | at most 1 of each; N/A if there are no transitions |
| | | Icon family and sizes | one family, at most 3 sizes |
| | | Token definitions across at least two relevant screens | one shared set; page-specific exceptions named |

The default style rules below are stricter than these measurement ceilings where they apply. Measure the distinct
backdrop filters, shadows and background alpha values even when the design has no glass, gradients or tinted panels.
Project and user rules take precedence as stated above. Name any deliberate exception in the report with its reason;
never pass it silently.

Record the theme, state, viewport in logical pixels and device scale for each measurement. In a web UI, use browser
developer tools, computed styles and bounding rectangles; in a native UI, use the platform's inspector or layout
diagnostics. A screenshot ruler may measure geometry when its scale is known. Mark a property UNKNOWN, not PASS, if it
cannot be measured.

Count a visible text block once, excluding duplicated ancestor text. For alignment, count the first box in each row and
each text column's left edge, rounding to the nearest logical pixel; an icon and text in one row share one line. Compare
repeated rows or cards within adjacent runs of the same component type; a separator starts a new run.

If there are no visible text blocks, mark the first font-size metric N/A. If there is only one distinct font size, check
the largest-size block count and mark the next-size ratio N/A.

For colour, convert to HSL and count colours with saturation at least 25% and lightness from 12% through 92% in
30-degree hue buckets. Exclude the pane's own surface and non-interface content. Measure coloured-background coverage as
the union of clipped descendant background rectangles divided by the pane area. Count distinct material values, not
instances. Exclude zero radius and count all pill radii as one value. Compare the shared token definitions across
relevant screens; mark the comparison N/A if only one screen exists.

### Grayscale checklist

Judge grayscale and 12px-blurred screenshots at the recorded default, intermediate and minimum supported sizes. Report
each applicable item as PASS or FAIL with its evidence; use N/A for an absent component and UNKNOWN for an unmeasurable
property.

1. If the screen has a primary action, its area stands out with the text ignored. Otherwise mark this item N/A and
   identify the intended visual focus.
2. Cards, inputs and buttons take their radii from one stated rule.
3. Record the foreground-to-background contrast and grayscale lightness of primary, secondary and placeholder text when
   present. Check that their intended hierarchy is distinguishable and explain the judgment.
4. The selected item in a list is recognisable without any brand colour, by a fill and an indicator.
5. Inputs, menus and buttons have visible bounds or hover feedback and a hit area of at least 32 × 32 logical px. Follow
   a larger platform touch-target requirement when applicable, and provide a visible keyboard focus indicator.
6. At the minimum supported size, unrelated controls do not overlap and text is not accidentally clipped.
7. Do not draw two outlines around the same visual container. Record the width and reason for any border judged
   unusually heavy.

### Light theme

- A light theme is not an inverted dark theme. It speaks the dark theme's visual language with its own values.
- Borders and dividers are lighter than instinct says; text is never lightened to match them.
- White carries content (cards, menus, a focused item); light grey marks what is interactive (hover, selected, inputs).
- Follow the project's material rules. If none exist, use at most one soft hover shadow, for example
  `0 4px 12px rgb(0 0 0 / .05)`, and default to surfaces without gradients, glass or tint.
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
| Secondary text | #69717D; use #636B77 (or primary text) on selected surfaces |
| Success | #438F73 for indicators; #37745E for text |

### Colour

- By default, keep interface chrome and surfaces neutral, reserving colour for semantic indicators, status text and
  brand marks. Do not recolour content such as photos, illustrations, code, diffs or charts. Avoid semantic-colour
  fills on pills, cards and panels unless the project or user specifies them.
- Put colour on icons and indicators (a check, a cross, a dot, a ring, a bar). Unless the project defines an accent, a
  checked switch, a picked option or the active tab uses the text colours.
- Every state also has a shape or a word, so it still reads in grayscale: a filled or hollow dot, a ring, a tag's text.

### Sizes and rhythm

- Spacing comes from one scale: 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 logical px. Zero means no spacing; use at most
  eight distinct nonzero values per screen.
- One radius rule: a fixed radius per kind of element (region, card, container, control, tag), stated once and reused.
- At most 6 font sizes and 3 weights. Hierarchy comes from size, contrast and spacing, not from heavier weights.
- Inputs, menus and buttons have visible bounds or hover feedback and a hit area of at least 32 × 32 logical px; follow
  a larger platform touch-target requirement and show a visible keyboard focus indicator. Use one icon family, with a
  stroke weight that matches the text beside it.
- Keep component radius, font, icon size, minimum hit area and hover feedback consistent across widths. Let content
  containers grow or rows wrap. An intentionally ellipsized label must expose its full text on focus or activation;
  hiding a label must preserve its accessible name.

### Tables and lists

- For a horizontally scrolling table, keep its identifying column and, when present, its status column visible on
  opposite edges if enough room remains for the data. Otherwise provide a readable alternative, such as a stacked view.
  Label the scroll region and make it keyboard accessible.
- Show status with a mark and a word, never colour alone.
- Keep table headers when there are no rows and show an explicit empty-state message.
- Render each path in its own block. Allow breaks after `/` or `\`, break long unseparated segments when necessary, and
  indent continuation lines so separate paths remain distinguishable.
- Counts and totals come from structured data, never parsed from displayed text.

### Motion

- Follow the project's busy-state pattern; without one, avoid spinning borders and provide a static mark or text. If
  using outward rings, fade them as they spread.
- If using a hover hop, bind hover to a stationary hit area, arm the hop on pointer movement and disarm it during
  scrolling until the pointer moves again. Check this with a stationary pointer while scrolling.
- Stop nonessential loops and hops under reduced motion, and use one duration and easing set for the remaining
  transitions.

### Crispness

- Prefer whole logical-pixel sizes and avoid fractional transforms on text or icons at rest. For axis-aligned strokes,
  align to the device-pixel grid where practical: centre an odd-device-pixel-width stroke on a half-device-pixel
  coordinate and an even-device-pixel-width stroke on a whole-device-pixel coordinate.
- Use vector sources for interface glyphs where supported; provide raster resources at the sizes a platform requires.
- Inspect screenshot crops at 100%, 150% and 200% device scaling when supported. Report unavailable scales and visible
  blur or glow bleeding into text.

### Styles

- Before changing a value, search the shared tokens and the feature styles for the owning token or rule.
- Change the source rule or token; do not stack overrides on top of it.
- Inspect every affected per-theme and per-layout override; update those that need the change while preserving
  intentional differences.
- Verify the result in the running UI. Use computed styles for web interfaces or the platform's property inspector or
  diagnostics for native interfaces; report any property that cannot be measured.

## Rules

- Mockup first for UI building beyond a small fix; the user's earlier decisions are kept and not re-proposed.
- Measure with numbers; judge layout in grayscale before colour.
- Follow the project's palette and material rules; otherwise use neutral interface chrome and reserve colour for
  semantic indicators, status text and brand marks.
- Spacing from the scale, at most 6 font sizes and 3 weights, a hit area of at least 32 × 32 logical px, one icon family.
- Change the owning token or rule, never stack overrides.
- Honour reduced motion and provide a non-motion status cue. Do not accidentally clip text or allow page-level
  horizontal scrolling; a labelled, keyboard-accessible region may scroll horizontally.
- The author never accepts their own screenshots; another model does, or the user when no second model is available.

## Done when

- For UI building beyond a small fix, the mockup was shown and the user's decisions were recorded. An existing-UI
  review or small fix needs no new mockup.
- Each applicable metric of the five questions has a measured value and a PASS or a named exception; absent metrics are
  N/A and unmeasurable metrics are UNKNOWN. Each applicable grayscale item has a PASS with evidence or a named
  exception. Give the reason for every deliberate exception.
- Every theme the product ships, at the recorded viewport sizes, has been inspected in the running UI. Page-level
  horizontal scrolling and accidental clipping are absent; intentionally ellipsized text remains accessible in full.
- Another model, or the user when no second model is available, has accepted the screenshots. Until one of them has,
  or if a required check is unavailable, report it as outstanding rather than claiming completion. Report the changed
  files, the measurements and any exception.
