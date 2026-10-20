# Design

Why the panel, popup and demo look the way they do, what the tokens are, and where the copy rules
come from. Read this before changing any of the three surfaces.

## What each surface is for

| Surface | The one decision it exists for |
| --- | --- |
| DevTools panel | Find an address, then change it. Everything else is available but ordered behind that. |
| Toolbar popup | Say whether this tab is set up: its title, whether the page agent is running, and the bridge state. A token field appears only when the bridge refuses the extension or needs a token. Nothing else fits in 380px, so nothing else is there. |
| Demo (Foundry) | Be a plausible target: state in linear memory, a number on screen you can watch move. |

The panel is not a dashboard. It has no stat row, no activity feed and no invented numbers. Its
layout is one readable column in the order you work: what you are attached to → the scan → the hits
→ what you can do to one address → advanced tooling → the raw escape hatch.

## The three ideas that carry the identity

1. **The signal path.** The header states the target; the `Now` line under it states tab → instance →
   address (`Foundry · w1 · 0x408`). It updates as you click, so the panel always answers "what am I
   about to write to?" without you re-reading three fields.
2. **One accent, used only where the answer is.** A deep teal marks the primary action, the live
   indicator, an interactive address and a focused card. Nothing else is coloured. Danger and warning
   colours exist but only appear when they mean something.
3. **Monospace is machine text only.** Addresses, values, hex dumps, RPC payloads and instance ids.
   Every human sentence is set in the system UI face. This is why the panel reads as an instrument
   rather than a form: the eye can tell at a glance which parts are data.

## Tokens

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--paper` | `#faf9f7` | `#131312` | Page behind cards |
| `--surface` | `#ffffff` | `#1a1a19` | Cards, rows, popup |
| `--surface-2` | `#f4f2ee` | `#232322` | Inputs, output blocks, zebra rows |
| `--line` | `#e3ded5` | `#2d2d2a` | Hairlines |
| `--ink` | `#1a1917` | `#f2f0ea` | Primary text |
| `--ink-2` | `#5b564d` | `#b5afa2` | Hints, output text |
| `--ink-3` | `#6b665c` | `#948e83` | Labels, notes, empty states |
| `--accent` | `#0d7461` | `#38c3a4` | Primary action, live state, links |
| `--danger` | `#ad382b` | `#ff8578` | Refusals, failed calls |
| `--warn` | `#7d5200` | `#f0b451` | A refused token, or a page whose CSP blocks hooks |

The demo is the exception: it is a game, so it runs a molten palette (`#ff7a2f` on `#0e100f`) and a
44px score. A target that looks like the inspector makes it harder to tell which window you are about
to write to. Its quietest text (`#8a948b`) still measures 5.1:1 on the raised stat cards.

Radii: 10px cards, 7px controls, 999px pills only. Spacing is a 4px scale, 12px between cards.

## Theme

Light is the default; <kbd>T</kbd> (or **Theme**) switches to dark and the choice is remembered. The
panel does not follow `prefers-color-scheme`: a panel that silently turns dark at night is a
different product than the one described here. The popup is light only: it is open for seconds,
and a second theme there would be one more thing to keep in sync.

## Type

System UI at 12.5px for the panel, `ui-monospace` at 11.5px for data, tabular numerals everywhere a
number can change. 11px is the floor for any text a person has to read (labels, pills, table heads,
keys); nothing goes smaller. No display face, no wide-tracked uppercase labels, no monospace
headlines.

## States

- **Empty** states name the cause and the next action (`list .empty`): "No hits yet. Run First Scan
  with a value you can see on screen." Never a bare "No data".
- **Waiting** states (pairing, an attach in flight) are a warning pill on the header, never a spinner that ends nowhere.
- **Refused** (`NO_AGENT`, `HOOK_EVAL_BLOCKED`, `BAD_PARAMS`) shows the code and the sentence that
  fixes it, because those codes are the ones a human hits first.
- **Error** output is tinted with `--danger` and keeps the text on screen; a failed call must not
  clear the previous answer.

## Motion

120ms ease-out on colour and border only, plus an 80ms press on buttons. Nothing animates on load,
nothing loops, nothing moves without being asked. Scroll-to-card in the palette uses the browser's
smooth scroll; that is the only movement over 200ms.

## Keyboard

<kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> opens the palette (every card, filterable, arrow keys,
Enter). <kbd>?</kbd> opens help, <kbd>T</kbd> switches theme, <kbd>Esc</kbd> closes. Shortcuts are
ignored while you are typing in a field.

## Copy

Two rules: never invent a fact, and never use a word you would not say out loud to a colleague.

| Instead of | Write |
| --- | --- |
| "Seamlessly unlock the full power of WebAssembly memory" | "Read and write a running WebAssembly module's memory." |
| "No data" | "No hits yet. Run First Scan with a value you can see on screen." |
| "An error occurred" | "`NO_AGENT`: the page agent is not running. Detach, then Attach." |
| "Blazing fast scans" | "Scans run inside the page, so only matches cross the bridge." |

Banned outright: unlock/elevate/empower/seamless/robust, significance inflation ("the future of"),
unsourced social proof, signposting ("let's dive in"), decorative emoji, and any number that is not
measured.

## Accessibility

Every control is reachable by keyboard and has a visible focus ring (2px accent, 1px offset).
Labels are real `<label>` elements wrapping their input. Status changes are text, not colour alone.
The palette and help sheet are `role="dialog"` and close on <kbd>Esc</kbd>. Measured contrast against
the card surface: `--ink` 17.6:1 light / 15.3:1 dark, `--ink-2` 7.3:1 / 8.0:1, `--ink-3` 5.7:1 /
5.4:1, `--accent` 5.7:1 / 7.9:1. `--ink-3` is the floor and is only used for labels and notes. Any new
pair needs 4.5:1 for normal text.

## Screenshots

`docs/img/*.png` are produced by `tests/e2e/screenshots.spec.ts`, which the normal suite ignores:

```bash
WASMCHEAT_SHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts
```

It drives the real extension: attaches the demo tab, scans, freezes, books a mark, then captures the
panel in light and dark, the help sheet, the popup and the demo window. If a screenshot and the UI ever
disagree, the screenshot is stale, not the other way round.
