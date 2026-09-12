# ryanlindsey.me design language

This design system ships a token layer, a type scale and three families. It ships no components, so do not look for them: build controls yourself and style them with the vocabulary below. The reference is 1980s new wave and Swiss punk. Flat bright color as signal, square corners, and one loud accent.

## Setup

Link `styles.css`. It carries the font faces, the color tokens, the type scale, the utility classes and the element defaults, and it needs no build step, no provider and no JavaScript.

Themes switch on one attribute: put `data-theme="light"` or `data-theme="dark"` on `<html>`. With the attribute absent, the operating system preference applies. Every color token is redeclared per theme, so one attribute re-themes an entire design with no duplicate classes and no `dark:` variants anywhere.

## The vocabulary

Color, as `bg-*`, `text-*` and `border-*`, across twelve names:

| Name                                   | Use                                                        |
| -------------------------------------- | ---------------------------------------------------------- |
| `bg`, `surface`, `surface-raised`      | page ground, card ground, raised card ground               |
| `ink`, `ink-muted`                     | body text, secondary text                                  |
| `rule`                                 | borders and dividers                                       |
| `accent`, `accent-ground`, `accent-on` | links and focus, filled accent ground, text on that ground |
| `ok`, `warn`, `danger`                 | status only                                                |

Type, as one class carrying size, line height, tracking and weight: `text-display`, `text-title`, `text-heading`, `text-subheading`, `text-body`, `text-small`, `text-micro`.

Families: `font-display` is Space Grotesk and belongs on headings, `font-sans` is Inter and is the default body face, `font-mono` is IBM Plex Mono and carries metadata, labels and code.

Article prose: wrap long-form content in `prose-rl`.

For anything the classes do not cover, read the token directly: `var(--rl-accent)`, `var(--rl-rule)`, `var(--rl-cut)`. Never write a literal hex, because a hex cannot follow the theme.

## What the system does not give you

Layout, spacing, border widths and radius are yours. `border-rule` sets a border color and no width, so pair it with your own. Keep radius at zero: nothing in this design is rounded.

## House rules

Pink is the single signature accent, and it carries links, focus, rules and marks. Green is the success and live ramp and is never a brand color, which is what keeps a green badge unambiguous next to a green link.

Color is flat. No gradient, no glow, no offset shadow.

Focus is a 2px solid `var(--rl-accent)` outline at 2px offset, with square corners.

The type scale is deliberately short and jumps. There is no gentle middle, so reach for `text-display` or `text-title` when something should land, and `text-body` or `text-small` for everything else.

Motion is a cut rather than a fade. `var(--rl-cut)` is 80ms, which sits below the threshold where a transition reads as easing, and that is the point. Budget three moments of motion per screen.

Numbers line up: apply `font-variant-numeric: tabular-nums` to figures, and note that `time` elements and anything carrying `data-numeric` already do.

## Where the truth lives

Read `styles.css` and the files it imports before styling anything. `tokens/tokens.css` holds the palette for every theme including print, `tokens/scale.css` holds the families and the type scale, `tokens/utilities.css` is the complete class list, `tokens/base.css` holds the element defaults, and `fonts/fonts.css` holds the faces.

## An idiomatic block

```html
<article class="bg-surface border-rule" style="border: 1px solid">
  <p class="text-micro font-mono text-ink-muted">CASE STUDY</p>
  <h2 class="text-heading font-display text-ink">Cutting a deploy to ninety seconds</h2>
  <p class="text-body text-ink-muted">One paragraph of standfirst, set in Inter.</p>
  <a class="text-small font-mono text-accent" href="#">Read it</a>
</article>
```
