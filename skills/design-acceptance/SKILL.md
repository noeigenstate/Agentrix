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
| 4 | Restrained colour and material | C1 chromatic hue families (30° buckets, saturation ≥ 25%) | ≤ accent + 4 status + 2 agent marks |
| | | C2 chromatic background area of the pane | ≤ 5% |
| | | C3 backdrop-filters / box-shadows / surface alphas | ≤ 2 / ≤ 3 / ≤ 4 |
| 5 | One product | P1 border radii | ≤ 4, from one set |
| | | P2 font sizes / weights | ≤ 6 / ≤ 3 |
| | | P3 button variants, heights | ≤ 2 variants, one height (a compact one only inside rows) |
| | | P4 transition duration and easing | one of each |
| | | P5 icon family, icon sizes | one family, ≤ 3 sizes |
| | | P6 token sets across pages of the same product | identical |

## Grayscale checklist (the owner's 灰度设计验收清单)

Layout and hierarchy are accepted in grayscale, even though the app now carries the accent and the status colours:
colour is added on top of a design that already works without it. Judge the page converted to grayscale (and the
blurred F3 shot), at the default size, a mid size (about 1100×720) and the minimum window size. Report each item
PASS/FAIL with the screenshot and what was measured.

1. 不看文字，只看排版，能找到最重要的操作区域: with text ignored, the primary action area stands out first.
2. 所有卡片、输入框和按钮的圆角都有统一规则: radii of cards, inputs, selects, buttons, rows and tags come from one stated rule.
3. 主文字、辅助文字、占位文字有明确的明暗差异: the text levels (`--text-1`, `--text-2`, `--text-3`) are clearly distinct, measured from pixels.
4. 左侧列表的选中状态即使没有品牌色也能被识别: selection shows by fill (`--bg-selected`) and indicator, not by hue.
5. 输入框、下拉菜单、按钮的点击区域足够清晰: every control has visible bounds or a hover fill, at least 32px tall.
6. 窗口缩小后不会出现布局拥挤或文字异常截断: no crowding or clipped controls; long text ends in a clean ellipsis.
7. 所有边框都有必要，没有重复描边或过重的视觉轮廓: no double outlines (box plus inner field, card plus pane) or heavy strokes.

## The accepted colour standard (what new UI must match)

The owner's semantic colours, one token per role in `src/shared/styles/themes.css`. **New UI uses only these tokens**: never a
grey picked from a scale, never a literal hex, and no alias that renames one. Each surface takes the token of its role.

| Role | Token | HEX | Where |
| --- | --- | --- | --- |
| App background | `--bg-app` | #181818 | main workspace, empty canvas, wells that sink into it |
| Top navigation bar | `--bg-titlebar` | #202020 | the title bar (38px) and the file tab strip |
| Left sidebar | `--bg-sidebar` | #232323 | project and session lists, the explorer, Settings' categories, the docked activity pane |
| Card | `--bg-card` | #262626 | project cards, agent tiles, task information, dialogs, activity and reading cards |
| Input | `--bg-input` | #2D2D2D | the message composer, fields, chips and wells inside a card |
| Popup | `--bg-menu` | #303030 | dropdowns, context menus, tooltips, popovers, toasts, floating panels |
| Hover | `--bg-hover` | #343434 | row and button hover |
| Selected | `--bg-selected` | #383838 | current project, nav item, selected rows |
| Border | `--border` | #404040 | cards, controls, dropdowns |
| Hover border | `--border-hover` | #595959 | a control's border on hover |
| Divider | `--divider` | #333333 | between regions, hairlines, list dividers |
| Primary text | `--text-1` | #F2F2F2 | headings, main content |
| Secondary text | `--text-2` | #B5B5B5 | descriptions, secondary labels, placeholders |
| Tertiary text | `--text-3` | #999999 | dates, times, counts, auxiliary information |
| Disabled text | `--text-disabled` | #777777 | disabled states |
| Primary button | `--button-primary` / `--button-primary-text` | #E5E5E5 / #181818 | the one main action; its hover is `--text-1` |
| Focus ring | `--focus-ring` | #D0D0D0 | every `:focus-visible` ring, and only keyboard focus |
| Brand accent | `--accent` | #65B8AE | key interactions and active state: checked boxes and switches, picked options, links, meters and progress, the active tab bar, spinners |
| Success | `--success` | #4CAF83 | task complete: a finished round, a passed step |
| Warning | `--warning` | #E5B45A | needs approval or attention: a decision waiting on you, a question |
| Danger | `--danger` | #E47777 | execution failed |
| Claude Code | `--agent-claude` | #D97757 | the agent's mark |
| Codex | `--agent-codex` | #34D5A5 | Agentrix's own colour to tell the CLI apart |

- Hue rule: **chrome is grey.** The only colour is the accent (key interactions, active state), the four status colours
  (working = accent, finished = success, needs you = warning, failed = danger), the two agent marks, and the file-type icons
  (`--fi-*` in file-icons.css, whose type colours are content). Content keeps its colour too (ANSI output, syntax, diff bands,
  images). The accent is never the focus ring, the primary button or a selected background.
- State keeps a non-hue cue next to its colour (ring, tag shape, dot shape), so it still reads in grayscale: working is a
  filled tag and dot, finished a plain tag and a filled dot, finished-and-unseen an outlined tag and a hollow dot (its ring
  breathes in white while fresh, then settles into success), failed a square dot.
- Radii: 0 for layout regions, 16 for real cards, menus and dialogs, 12 for composers and dropdown triggers, 8 for
  buttons, rows and wells, pill for tags. Layout regions are separated by a colour step, a divider and spacing, not by cards.
- No glass, wallpaper, glow or gradients, and no tinted panels. The one shadow is the dropdown menu's. A state colour paints
  a ring, a tag's text, a dot or an icon, never a panel.
- Dropdowns use `src/shared/Select.tsx`, never a native `<select>` (its pop-up is drawn by the OS in system blue).
- Native GUI checks drive it with `scripts/select-helper.mjs`.

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
