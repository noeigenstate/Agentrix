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
| 4 | Restrained colour and material | C1 chromatic hue families (30° buckets, saturation ≥ 25%) | ≤ 5 semantic colours + the Claude mark |
| | | C2 chromatic background area of the pane | ≤ 5% |
| | | C3 backdrop-filters / box-shadows / surface alphas | ≤ 2 / ≤ 3 / ≤ 4 |
| 5 | One product | P1 border radii | ≤ 4, from one set |
| | | P2 font sizes / weights | ≤ 6 / ≤ 3 |
| | | P3 button variants, heights | ≤ 2 variants, one height (a compact one only inside rows) |
| | | P4 transition duration and easing | one of each |
| | | P5 icon family, icon sizes | one family, ≤ 3 sizes |
| | | P6 token sets across pages of the same product | identical |

## Grayscale checklist (the owner's 灰度设计验收清单)

Layout and hierarchy are accepted in grayscale, even though the app carries a few semantic colours:
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
The title bar, the decision page, Settings and dialogs use the first HEX; the **workbench** (the project grid and a project in
focus) overrides some tokens, shown in brackets, see below.

| Role | Token | HEX (workbench) | Where |
| --- | --- | --- | --- |
| App background | `--bg-app` | #181818 (#191919) | main page, empty canvas, wells that sink into it; in the workbench the grid canvas and the centre (terminal, reading view, file preview) |
| Top navigation bar | `--bg-titlebar` | #1C1C1C | the title bar (40px, the same everywhere) and the file tab strip |
| Left sidebar | `--bg-sidebar` | #232323 (#222222) | project and session lists, the explorer, Settings' categories |
| Right info pane | `--bg-aside` | #232323 (#202020) | the docked activity pane |
| Pane well | `--bg-aside-well` | #2D2D2D (#2B2B2B) | in the activity pane only: the model chip and the meters' tracks |
| Card | `--bg-card` | #262626 (#242424) | project cards, dialogs; in the workbench also your message bubble and the tool groups in focus |
| Input | `--bg-input` | #2D2D2D (#2A2A2A) | the message composer, fields, chips and wells inside a card |
| Popup | `--bg-menu` | #303030 | dropdowns, context menus, tooltips, popovers, toasts, floating panels |
| Hover | `--bg-hover` | #343434 (#303030) | row and button hover; inside a menu in the workbench it is `--bg-selected`, so it differs from the menu |
| Selected | `--bg-selected` | #383838 (#373737) | current project, nav item, selected rows |
| Border | `--border` | #424242 | cards, controls, dropdowns (1px) |
| Hover border | `--border-hover` | #595959 | a control's border on hover |
| Divider | `--divider` | #333333 (#343434) | between regions, hairlines, list dividers |
| Primary text | `--text-1` | #F2F2F2 | headings, main content |
| Secondary text | `--text-2` | #B5B5B5 | descriptions, secondary labels, placeholders |
| Tertiary text | `--text-3` | #999999 | dates, times, counts, auxiliary information |
| Disabled text | `--text-disabled` | #777777 | disabled states |
| Primary button | `--button-primary` / `--button-primary-text` | #E5E5E5 / #181818 | the one main action; its hover is `--text-1` |
| Focus ring | `--focus-ring` | #D0D0D0 | every `:focus-visible` ring, and only keyboard focus |
| Claude Code | `--agent-claude` | #D97757 | its brand icon |
| Codex | `--agent-codex` | #34D5A5 (light #0D8F6A) | its mark and status dot, to tell the CLI apart |
| Succeeded | `--success` | #70BFA4 | command done, check passed, a finished round's tag and dot (never a card edge) |
| Running | `--running` | #78A8CC | tasks in progress: a working card's edge, tag and dot, the reading view's running dot |
| Needs approval | `--warning` | #D8AE67 | only where something waits for the owner's decision |
| Failed | `--danger` | #DE7878 | errors and failures |
| Usage | `--usage` | #68B8AE | progress bars and usage meters |

Light theme 白底黑字 (the owner's values, one line each; a white panel on a light canvas, the borders and the ink as below):
- Canvas `--bg-app` #F8F9FB (behind the grid cards and the decision page); panels that carry content stay white: `--bg-card` #FFFFFF, a focused project, menus (`--bg-menu` #FFFFFF).
- Title bar and sidebar `--bg-titlebar` / `--bg-sidebar` #F7F7F8; input `--bg-input` #F7F8FA; hover `--bg-hover` #F3F5F7; selected `--bg-selected` #E9EBEF.
- Border `--border` #E2E6EB; active border `--border-hover` #A8B7C9 (an active, hovered or focused-input control's edge, 2:1, never the keyboard focus ring); divider `--divider` #ECEDF0.
- Text `--text-1` #20242A (also `--button-primary`); `--text-2` #626B77; `--text-3` #636B77 (4.5:1 on the canvas, hover and selected); `--text-disabled` #9AA1AB; `--focus-ring` #3C4043.
- The one card shadow in light: a grid card under the pointer gets `0 4px 12px rgb(0 0 0 / .05)`, background and border unchanged; none while dragged, in the focus motion or in focus mode.

- Hue rule: **everything is neutral grey except these seven**: Claude's brand icon, Codex's mark, succeeded, running, needs approval, failed, usage.
  There is no accent and no "key interaction" colour: a checked switch or checkbox, a picked option or tile, the active file tab,
  a toggled icon button, the guide's current dot and a spinner take `--text-1` or `--text-2`; a link is underlined. Codex's mark and
  status dot take `--agent-codex`. Not coloured by these rules: file-type icons (`--fi-*` in file-icons.css, content), ANSI output, syntax,
  diff bands, images. **One owner exception:** list bullets and numbers in the reading view are `--usage`.
- Colour goes on icons and indicators (a check, a cross, a dot, a ring, a bar), never on a pill, a card or a panel background: a
  command pill is a grey pill with grey text, and only its check is green, its cross red, its running dot blue. A state colour paints a
  ring, a tag's text, a dot or an icon, never a panel. Warning and danger appear only for what is waiting or failed; usage meters do not warm.
- State keeps a non-hue cue next to its colour (ring, tag shape, dot shape), so it still reads in grayscale: working is a
  filled tag and dot, finished a plain tag and a filled dot with no edge, finished-and-unseen an outlined tag and a hollow dot
  (its grid card breathes a white glow, a soft inset vignette from the edge inward with no hard line, until it is viewed), failed a
  square dot. A project in focus draws no edge at all; its tag carries the state.
- Radii: 0 for layout regions, 16 for project cards, menus and dialogs, 12 for message containers (your bubble, tool groups, code
  and error wells, file cards), composers and dropdown triggers, 8 for buttons, rows and small wells, pill for tags. Layout regions
  are separated by a colour step, a divider and spacing, not by cards.
- No glass, wallpaper or gradients, and no tinted panels. The only shadows are the dropdown menu's, in the grid the white inset glow
  that breathes on a finished card not yet seen, and, in light, the hover shadow of a grid card.
- Dropdowns use `src/shared/Select.tsx`, never a native `<select>` (its pop-up is drawn by the OS in system blue).
- Native GUI checks drive it with `scripts/select-helper.mjs`.

## The workbench

- Its tokens are overridden on `.workspace-layout:not(:has(> .home-layer))` (themes.css), the layout that holds the grid and a
  project in focus; the decision page is a layer in the same layout, so it is left out. The title bar, Settings and dialogs are
  outside it. `--bg-titlebar` is global (#1C1C1C). `--bg-aside` is the activity pane's own surface (#202020 in the workbench, the
  sidebar colour elsewhere), and `--bg-aside-well` (#2B2B2B) the pane's one fill, for the model chip and the meters' tracks.
- Menus inside the workbench set `--bg-hover` to `--bg-selected` (the popup colour equals the workbench hover). Menus drawn on the page
  body keep the standard hover.
- A grid card's reading view is the card colour; in focus it is the app colour. Your message and the tool groups are one step above
  it (`--flow-card`: the input colour on a card, the card colour in focus). The agent's plain reply has no card; code blocks, errors
  and file cards are wells (`--bg-app` with a divider edge, radius 12). The model tag over the composer hides while the activity pane,
  which shows the model route, is open.
- Toggling a pane or a view never moves the header or the title bar: the activity pane runs from the title bar to the bottom, behind the header's
  right cluster (status and buttons, which fit its 340px column), and the header and the output's top never move; only the output beside it narrows.
- The title bar has no settings button: the app menu (new project, back to projects, full screen, Settings, and an update waiting to
  install) opens from the logo and title at its left, and in a project the activity pane's toggle sits at its right.
- The activity pane is a quiet status inspector: groups without cards or borders on the pane colour, a 13px title, 12px content, 11px
  notes, 20px between groups, 4 to 12px inside a group, 16px padding. The plan's first usage bar is `--usage`; every other meter is
  `--text-3` on the well.

## Sizes (the owner's spec, logical px)

Title bar 40 · explorer rows 30 to 32 with 13px text · message body 13 to 14px on a 1.5 to 1.6 line · message container radius 12 · tool
pill 28 high (its 18px icon centred on it) · chat padding 24 left and right (16 in a card narrower than 480px) · right pane padding 16 ·
composer 48 to 56 high and growing, radius 12 · default border 1px `--border` (#424242).

Type scale (the owner's, both themes): page title 20 to 22 / 600; project name, group head and button text 14 / 600 (names in `--text-1`, group heads in `--text-2`); body 13 to 14 / 400; helper line 12 / 400 in `--text-2` or `--text-3`; status tag 11 to 12 / 600 (Windows has no real 500, so 600). Hierarchy comes from size, contrast and spacing, not from heavier weights. Controls: 32 high, 1px `--border`, radius 8 (composers 12); secondary buttons and dropdown triggers use `--bg-control` (white in light), inputs `--bg-input`.

One spec at every width (the owner's 多工作区一致性): a component (the launcher tiles and mode switch, the composer, the panel header buttons) keeps the same radius, font, icon size, box and hover feedback in a 300px grid card, a wide card and focus mode. When space runs out, hide a label, ellipsize or wrap the row; never shrink a control or let its text wrap inside it. Check by measuring computed styles at 1/2/4/6 projects in 1600x1000 and 1000x700 windows plus focus mode.

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
