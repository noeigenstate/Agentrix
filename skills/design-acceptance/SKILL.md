---
name: design-acceptance
description: The owner's five acceptance criteria for any UI design or restyle in Agentrix (clear focus, uniform alignment, regular spacing, restrained colour and material, one product), with measurable thresholds and the audit script that scores them. Use whenever a design mockup, concept page or UI change is handed in or reviewed.
---

# Accepting a design: five questions, measured

The owner accepts a design by five questions: 有没有明确的焦点？对齐是否统一？间距是否有规律？颜色与材质是否克制？每个组件是否像同一个产品的一部分？
Each is answered with numbers, not taste. Measure the app window's UI only: not the wallpaper, photos or brand marks
(mark those `data-audit-ignore`).

| # | Question | Metric | Pass |
| --- | --- | --- | --- |
| 1 | Clear focus | F1 elements at the largest font size; next size down | 1; ≤ 0.8× |
| | | F2 solid primary buttons in view | ≤ 1 |
| | | F3 12px-blurred grayscale screenshot | what stands out is the intended focus (a person checks) |
| 2 | Uniform alignment | A1 distinct left edges per pane | ≤ 4 |
| | | A2 near-misses (edges 1–3px apart) | 0 |
| | | A3 vertical centres within a row | differ ≤ 1px |
| 3 | Regular spacing | S1 padding/margin/gap off the scale {2,4,8,12,16,20,24,32,40,48,64} | 0 |
| | | S2 distinct spacing values | ≤ 8 |
| | | S3 repeated rows/cards | identical heights and gaps |
| 4 | Restrained colour and material | C1 chromatic hue families (30° buckets, saturation ≥ 25%) | ≤ 3: needs-you, working, danger |
| | | C2 chromatic background area of the pane | ≤ 5% |
| | | C3 backdrop-filters / box-shadows / surface alphas | ≤ 2 / ≤ 3 / ≤ 4 |
| 5 | One product | P1 border radii | ≤ 4, from one set |
| | | P2 font sizes / weights | ≤ 6 / ≤ 3 |
| | | P3 button variants, heights | ≤ 2 variants, one height (a compact one only inside rows) |
| | | P4 transition duration and easing | one of each |
| | | P5 icon family, icon sizes | one family, ≤ 3 sizes |
| | | P6 token sets across pages of the same product | identical |

## Grayscale checklist (the owner's 灰度设计验收清单)

Layout and hierarchy are accepted in grayscale before any colour work. Judge the page converted to grayscale (and the
blurred F3 shot), at the default size, a mid size (about 1100×720) and the minimum window size. Report each item
PASS/FAIL with the screenshot and what was measured.

1. 不看文字，只看排版，能找到最重要的操作区域: with text ignored, the primary action area stands out first.
2. 所有卡片、输入框和按钮的圆角都有统一规则: radii of cards, inputs, selects, buttons, rows and tags come from one stated rule.
3. 主文字、辅助文字、占位文字有明确的明暗差异: three clearly distinct grey levels, measured from pixels.
4. 左侧列表的选中状态即使没有品牌色也能被识别: selection shows by fill and indicator, not hue.
5. 输入框、下拉菜单、按钮的点击区域足够清晰: every control has visible bounds or a hover fill, at least 32px tall.
6. 窗口缩小后不会出现布局拥挤或文字异常截断: no crowding or clipped controls; long text ends in a clean ellipsis.
7. 所有边框都有必要，没有重复描边或过重的视觉轮廓: no double outlines (box plus inner field, card plus pane) or heavy strokes.

## Definitions (so a hand count and the script agree)

- **Alignment line (A1, A2):** the left edge of a row's first visible box (a heading, row container, card, the first
  control of a toolbar) and of each column's text block. Icon, text and tag side by side in one row are one line.
- **Repeated components (S3):** adjacent siblings of the same class; a group label or divider between them starts a new
  run, so its gap is not compared.
- **Accent colour (C1, C2):** colours inside a pane (tags, badges, filled buttons, highlighted rows), as a share of
  that pane's area. The pane's own glass surface is material, not accent, and near-black or near-white colours
  (lightness < 12% or > 92%) are not accents.
- **Radius (P1):** 0 is no radius and is not counted; every pill (radius ≥ half the height) counts as one value.

## How

- `npm run audit:design -- <page.html> [more pages] --root <window selector> [--view name=query]` writes
  `audit.md` and `audit.json` with every metric, its value, PASS/FAIL and the offending selectors, plus the blurred
  screenshot for F3. Give two or more pages to check P6.
- Every brief for design work (Sonnet subagent or Codex concepts) carries this table, and the worker reports the
  measured numbers. The lead reruns the audit and opens the F3 picture before showing the owner.
- A deliberate exception (a fourth hue for an error state, say) is named in the report with its reason; it is not
  silently passed.
