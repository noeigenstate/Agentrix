---
name: theme-style-overrides
description: Use when changing a size, color or font of any Agentrix view (reading view text, cards, composer), or when a CSS change builds fine but makes no visible difference in the app.
---

# Theme tokens and feature styles

The renderer selects `mono` (default) or `light` through `data-theme` on `<html>`. Shared colours live in
`src/shared/styles/themes.css`: base tokens on `:root`, light overrides under `:root[data-theme="light"]`, and
workbench tokens on `.workspace-layout:not(:has(> .home-layer))`. A token declared on the layout overrides the value
inherited from `:root`, and theme-qualified rules can override feature styles under `src/features/<feature>/*.css`.

## Rule

- Before changing a size or color, search the shared and feature styles for the same selector or token:
  `rg -n -e "reading-scroll" -e "--reading-text" src/shared/styles src/features/reading` (use the class or token you change).
  Change the owning rule or shared variable instead of adding competing overrides.
- When changing a workbench token, update the corresponding light workbench block in `themes.css` too; otherwise
  a layout-local dark value can override the light value inherited from `:root`.
- The reading view's text sizes multiply by `--reading-text` (set on `:root` in `src/features/reading/reading.css`).
  A new font size in the reading view is written `calc(13px * var(--reading-text))`.
- Verify in the app, not by reading CSS: in a desktop probe read
  `getComputedStyle(element).fontSize` on an isolated profile (`AGENTRIX_DATA_DIR`), and take screenshots in the
  `mono` and `light` themes, in both small-card and focused layouts.

## Light theme principle

The light theme speaks the dark theme's visual language, it is not its colours inverted: borders and dividers are lighter than instinct says (`#E4E7EB`, `#ECEDF0`), text is never lightened to match (`#24272D`, `#69717D`).
