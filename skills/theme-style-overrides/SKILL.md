---
name: theme-style-overrides
description: Use when changing a size, color or font of any Agentrix view (reading view text, cards, composer), or when a CSS change builds fine but makes no visible difference in the app.
---

# Theme stylesheets override feature styles

The renderer sets `data-theme="catalina"` on `<html>`, and `src/shared/styles/clarity.css` (with the other
shared stylesheets) restyles feature classes under `:root[data-theme] …`. Those rules win over a feature's own stylesheet,
so a change made only in `src/features/<feature>/*.css` can do nothing at all.

## Rule

- Before changing a size or color, search the theme files for the same selector:
  `grep -rn "reading-scroll" src/shared/styles` (use the class you change). Change both, or move the value into a
  variable both use.
- The reading view's text sizes all multiply by `--reading-text` (set on `:root` in `reading.css`), the theme's
  overrides included (`clarity.css`: `.reading-scroll`, and `.focus-mode .reading-scroll`, the project opened full
  screen). A new font size in the reading view is written `calc(13px * var(--reading-text))`.
- Verify in the app, not by reading CSS: in a desktop probe read
  `getComputedStyle(element).fontSize` on an isolated profile (`AGENTRIX_DATA_DIR`), and take a screenshot in the
  Catalina theme.

## Light theme principle

The light theme speaks the dark theme's visual language, it is not its colours inverted: borders and dividers are lighter than instinct says (`#E2E6EB`, `#ECEDF0`), text is never lightened to match (`#20242A`, `#626B77`).
