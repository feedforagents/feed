# Design system

One electric-blue (`#0066FF`-inspired) accent on crisp X-style light and dark neutrals. Color carries meaning; position and weight carry hierarchy.

- **Surfaces.** `background` is the page (pure white in light mode, pure OLED black in dark mode), `card` a raised panel, `popover` anything floating, `scrim` a pure-black modal backdrop. `muted` and `secondary` are quiet fills, `accent` the neutral hover and selection fill.
- **Text.** `foreground` by default, `muted-foreground` for what matters less. Every `x-foreground` is
  the text color on `x`, and each pair meets WCAG AA in both themes.
- **Edges.** `border` divides and may be faint. `input` is the edge of a control (a field, a checkbox, an
  outlined button): it and the focus `ring` stand at least 3:1 off `background` and `card` in both
  themes (WCAG 1.4.11).
- **Meaning.** `primary` is the text/link accent and focus `ring`; `feed-brand` (`#0066FF`) with `feed-brand-foreground`
  fills primary CTAs and active indicators. `destructive`, `danger-solid`, `ok`, `warn` and `info` are
  states, never decoration.
- **Shape.** One `radius`; `rounded-sm`, `-md`, `-lg` and `-xl` derive from it. Three shadows, by elevation.
- **Motion.** `fast` for hover and press, `base` for most changes, `slow` for entering and leaving.
- **Dark.** Follows the system; a `.dark` or `.light` class on an ancestor overrides it.

Name a value by its token (`bg-primary`, `var(--primary)`), never by its value. Where a literal color
is unavoidable, such as a chart series or third-party markup, say why on the line above:
`// eslint-disable-next-line design-system/no-literal-colors -- chart series`.

## Changing it

`tokens.json` is the source; the CSS in `generated/` and the table below are built from it. Nothing reads
this prose into tokens. To change the design, describe it, and have the change written as a list in a file:

```json
[{ "path": "color.light.primary", "value": "oklch(0.45 0.21 262)", "reason": "deeper accent" }]
```

- `node ../../vibestack/design/cli.ts apply changes.json` refuses an unknown path, an invalid value or a
  pair below AA, and prints each token before and after.
- The same with `--write` updates `tokens.json`, the CSS and the table.
- `pnpm build` regenerates; `pnpm check` fails on invalid tokens, low contrast or a stale table.

<!-- tokens:start -->
| Color | Light | Dark |
| --- | --- | --- |
| `background` | oklch(1 0 0) | oklch(0 0 0) |
| `foreground` | oklch(0.19 0.012 250) | oklch(0.95 0.005 260) |
| `card` | oklch(0.975 0.002 240) | oklch(0.205 0.006 260) |
| `card-foreground` | oklch(0.19 0.012 250) | oklch(0.95 0.005 260) |
| `popover` | oklch(1 0 0) | oklch(0.14 0.004 260) |
| `popover-foreground` | oklch(0.19 0.012 250) | oklch(0.95 0.005 260) |
| `primary` | oklch(0.495 0.226 262) | oklch(0.68 0.168 262) |
| `primary-foreground` | oklch(1 0 0) | oklch(0.145 0.006 260) |
| `secondary` | oklch(0.955 0.006 255) | oklch(0.235 0.012 260) |
| `secondary-foreground` | oklch(0.19 0.012 250) | oklch(0.95 0.005 260) |
| `muted` | oklch(0.955 0.006 255) | oklch(0.2 0.006 260) |
| `muted-foreground` | oklch(0.48 0.018 255) | oklch(0.64 0.01 255) |
| `accent` | oklch(0.955 0.004 250) | oklch(0.22 0.006 260) |
| `accent-foreground` | oklch(0.19 0.012 250) | oklch(0.95 0.005 260) |
| `destructive` | oklch(0.545 0.215 26) | oklch(0.7 0.175 24) |
| `destructive-foreground` | oklch(1 0 0) | oklch(0.145 0.006 260) |
| `border` | oklch(0.908 0.007 255) | oklch(0.32 0.008 250) |
| `input` | oklch(0.62 0.014 255) | oklch(0.515 0.015 260) |
| `ring` | oklch(0.495 0.226 262) | oklch(0.68 0.168 262) |
| `ok` | oklch(0.52 0.125 155) | oklch(0.78 0.165 155) |
| `warn` | oklch(0.545 0.134 55) | oklch(0.82 0.155 78) |
| `info` | oklch(0.52 0.11 235) | oklch(0.78 0.112 232) |
| `feed-brand` | oklch(0.562 0.244 261.3) | oklch(0.562 0.244 261.3) |
| `feed-brand-foreground` | oklch(1 0 0) | oklch(1 0 0) |
| `scrim` | oklch(0 0 0) | oklch(0 0 0) |
| `danger-solid` | oklch(0.57 0.23 26) | oklch(0.57 0.23 26) |
| `danger-solid-foreground` | oklch(1 0 0) | oklch(1 0 0) |

| Token | Value |
| --- | --- |
| `radius` | 0.5rem |
| `font.sans` | ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif |
| `font.mono` | ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace |
| `shadow.sm` | 0 1px 2px oklch(0 0 0 / 0.08) |
| `shadow.md` | 0 4px 12px oklch(0 0 0 / 0.12) |
| `shadow.lg` | 0 12px 32px oklch(0 0 0 / 0.18) |
| `breakpoint.sm` | 40rem |
| `breakpoint.md` | 48rem |
| `breakpoint.lg` | 64rem |
| `breakpoint.xl` | 80rem |
| `duration.fast` | 100ms |
| `duration.base` | 150ms |
| `duration.slow` | 300ms |
| `ease.standard` | cubic-bezier(0.4, 0, 0.2, 1) |
<!-- tokens:end -->
