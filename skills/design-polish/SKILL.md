---
name: design-polish
description: Use when asked to make part of Agentrix look more refined or premium (高级、质感、精致、漂亮), to restyle a button, card or icon, or to "generate a few styles to choose from". Codex draws concepts, the user picks one, and the pick is built as crisp code (CSS and SVG), never a pasted picture.
---

# Polishing a look: concepts from Codex, the user's pick, built crisp

## 1. Show Codex what is there

Take a screenshot of the current state with an isolated desktop probe (`AGENTRIX_DATA_DIR` in a new folder, the 晴空
theme), or reuse `docs/images/*.jpg`. Put references under `.test-output/<topic>/`.

## 2. Ask Codex for named directions

Write the prompt to a scratch file:
- What the element is, where it sits and what it does. Say which states to draw: default, hover, pressed, disabled,
  and busy (e.g. a countdown).
- The rules every concept keeps: sharp wallpaper, frosted glass panes, white text, no dark overlay over the window,
  Simplified Chinese labels.
- 4–5 directions, each with a short name and concrete material, light, shape and type ("glossy red dome in a metal
  bezel", "graphite glass with gradient hairline edges").
- Output: `.test-output/<topic>/<n>-<slug>.png`, copied from where the image tool saves them. No other file changes,
  no commit, no app or test run.

Run it in the background:

```
codex exec -m gpt-6.1-sol -c model_reasoning_effort=max -c service_tier='"fast"' -C <repo> -i <reference.png> -o <scratch>/out.md - < <scratch>/prompt.md
```

It takes about two minutes per image. Keep working on other things meanwhile.

## 3. Let the user choose

Open every image before showing it. Present them all, one line each on what sets it apart, and offer to combine
("1's glass with 4's type").

## 4. Build the pick as code

- **Surfaces and buttons are CSS:**
  - Layered gradients for the face.
  - Stacked `box-shadow`s: an inset top highlight, a solid offset shadow for depth, and a soft coloured glow.
  - A `::before` gloss over the upper half.
  - `transform` for hover and pressed.
  - A flat grey look when disabled.
- **Icons are vectors:** an icon-set component at one weight, or an inline SVG drawn on a 24-unit grid. Never a
  generated bitmap. Apple's (SF Symbols) way:
  - Stroke weight matches the text beside it (about 1.5 px at 16 px).
  - Round caps and joins, simple geometric shapes.
  - Outline by default, the filled twin for selected or active.
  - Optical sizes: draw small sizes on their own, don't just scale down.
  - One family across the app: never mix regular, bold and duotone side by side.
- **App icons** are a squircle (continuous corners) with a soft top-lit gradient, exported as SVG, then rendered to
  the sizes the platform needs.

- **Agent brand avatars** use the exact supplied official vector paths and proportions, with source attribution.
  Keep checksum-verified SVG sources exempt from Git newline conversion; verify their hashes through checkout filters.
  GPT/Codex uses OpenAI's Blossom; Claude uses its official spark. Do not redraw their geometry or animate its parts.
  Use the supplied white/black OpenAI variants for contrast. Task cards show real state text, without invented progress bars.

- **Small marks over the wallpaper** (timeline nodes, badges) are hollow: a hairline rim and the glyph in the
  kind's colour, the wallpaper showing through. A dark filled disc reads as a black hole there, and the user
  rejected it. A line joining them runs from rim to rim, never through a see-through mark. Rays meeting at a centre
  (an asterisk) start at the centre, or their round caps leave a dark speck.

- **Motion for "busy" never spins a border** (the user calls it cheap). A running mark sends soft rings out from its
  rim, fading as they spread (two, half a cycle apart). Official brand geometry stays still. Check motion with a strip
  of clip screenshots taken 100ms apart, and stop every loop under `data-motion="off"` and reduced motion.
- **A hover hop** (the user wanted items to "jump" when the pointer passes, no glow): a one-shot keyframe on the card,
  up about 12px, down, a small second bounce, landing at 0. Hang the `:hover` on the row that does not move, never on the
  moving card, or a card hopping out from under the pointer restarts forever. Arm hops on `pointermove` and disarm them
  on `scroll` (a data attribute on the scroller), or every item sliding under a still pointer hops while scrolling and
  right after. Check with a probe sampling the card's `translateY` every 50ms.
- **Balance a column with a gutter.** Measure the room left and right of the cards in CSS pixels in a probe; a timeline's
  times and nodes read as margin, so take room from them and give the right side more. Everything in the column
  (conversation, choices, command list, composer) shares one pair of inset variables, so the edges line up.

## 5. Make it crisp

- Whole-pixel sizes and positions.
- An odd stroke width sits on half-pixel coordinates.
- No fractional `translate` or `scale` on text or icons at rest.
- `shape-rendering: geometricPrecision` on SVG.
- Check zoomed crops of a probe's screenshot at 100%, 150% and 200% scaling: edges must be sharp, and no glow may
  bleed into the text.

## 6. Check it in the app

Run the probe again and check every state: hover, pressed and disabled by mouse; the busy state by driving it.
Confirm the behaviour around it is unchanged. For a reset button, the countdown and cancel still guard it; test with
a fake agent and catch the command it would send, never with a real account.
