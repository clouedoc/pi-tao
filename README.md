# pi-slopchop-jj

> [!NOTE]
> This is a Jujutsu-only fork of [pi-slopchop](https://github.com/robzolkos/pi-slopchop). It focuses on `jj` workflows and does not support Git repositories.

`/diff` opens a terminal-native review and annotation surface for Pi in a Jujutsu workspace.

It lets you stop after an agent turn, review the current change or stack inside Pi, add precise feedback, and insert a follow-up prompt into Pi's editor.

## Review scopes

| Key | Scope | Revisions |
| --- | --- | --- |
| `1` | working copy | `@-` to `@` |
| `2` | parent change | `@--` to `@-` |
| `3` | stack vs trunk | `fork_point(trunk() \| @)` to `@` |

The UI opens the first available scope in this order:

1. working copy
2. stack vs trunk
3. parent change
4. current file contents when no scope contains a change

Stack files are ordered for review priority: files referenced by more changed files first, then modified/renamed before added/copied before deleted, then source files before tests/docs/changesets, then path order.

## Install

```bash
pi install npm:pi-slopchop-jj
```

Restart Pi or run `/reload`, then open a Jujutsu workspace and run:

```text
/diff
```

The review UI does not send feedback automatically. It inserts the generated prompt into Pi's editor so you can review or edit it before sending.

## Basic flow

1. Run `/diff`.
2. Pick a review scope with `1`, `2`, or `3`.
3. Move to the file and line you want to review.
4. Add feedback:
   - `f` for a line comment with `FIX` preselected
   - `d` or `c` for a line comment with `DISCUSS` preselected
   - `l` for a file comment
   - `a` for a whole-review note
5. Press `s` to insert the generated prompt into Pi's editor.
6. Edit it if needed, then send it normally.

For fast repeated feedback, select a changed line, press `t`, then press a template shortcut from the comments panel. Press `e` afterwards to refine the generated comment.

## Feedback model

### Line comments

Line comments attach to an added or deleted line. Hold `Shift+↑` or `Shift+↓` to extend the selection across a range on the same diff side.

Examples:

- `Why was this deleted?`
- `What is this code doing?`
- `Use a clearer name here.`

### File comments

Use file comments when feedback applies to the whole file change.

Examples:

- `Explain this file-level refactor.`
- `This file now does too much.`

### Whole-review note

Use a whole-review note for feedback about the entire reviewed change or stack.

Examples:

- `Explain the overall intention of this change.`
- `Check whether this stack can be simplified.`

### FIX and DISCUSS

Use `FIX` when the next agent turn should change something. Use `DISCUSS` for explanation, rationale, tradeoffs, or proposals.

The generated prompt distinguishes FIX-only, DISCUSS-only, and mixed reviews so discussion comments do not become accidental edits.

## Navigation

### Global

- `1 / 2 / 3` — switch scope
- `Tab / Shift+Tab` — cycle focus
- `/` — search files
- `?` — toggle help
- `w` — toggle wrapping
- `v` — toggle unified / side-by-side diff
- `u` — toggle unchanged context in working-copy and parent-change scopes
- `h` — hide/show comments
- `s` — insert the generated prompt into Pi's editor
- `Esc` or `Ctrl+C` — exit, with confirmation when draft feedback exists
- mouse wheel — scroll the pane under the cursor

### Navigator

- `↑↓` or `j/k` — move between files
- `Ctrl+d / Ctrl+u` — move by half a pane
- `gg / G` — jump to top / bottom
- `r` — toggle related-files filtering in the stack scope
- `Enter` — focus the diff

In related mode, `→` means the active file references that file, `←` means that file references the active file, and `↔` means both.

### Diff

- `↑↓` or `j/k` — move between selectable lines
- `Shift+↑↓` — extend the line range on the current side
- `← / →` — choose the deleted or added side of a replacement in side-by-side view
- `Ctrl+d / Ctrl+u` — move by half a pane
- `gg / G` — jump to top / bottom
- `n / p` — next / previous hunk
- `o` — open the selected location in `$EDITOR`
- `f` — add a FIX line comment
- `d` or `c` — add a DISCUSS line comment
- `e` — edit the selected line comment
- `x` — delete the selected line comment
- `l` — add a file comment
- `a` — add a whole-review note
- `t` — open template shortcut mode

Side-by-side view keeps deleted lines on the left and added lines on the right. Line comments attach to the selected side and line number.

Comment markers in the diff gutter:

- `●` — FIX
- `◆` — DISCUSS

### Comments

- `↑↓` or `j/k` — move through comments
- `Ctrl+d / Ctrl+u` — move by half a pane
- `gg / G` — jump to top / bottom
- `e` or `Enter` — edit
- `d` — delete

### Comment editor

- `Tab` — toggle FIX / DISCUSS
- `Enter` — save
- `Shift+Enter` — newline
- `Esc` — cancel

## Template shortcut configuration

Optional user configuration lives at:

```text
~/.pi/agent/extensions/slopchop.json
```

Example:

```json
{
  "version": 1,
  "builtins": {
    "disable": ["restore-deleted"]
  },
  "shortcuts": [
    {
      "id": "trace-added",
      "key": "x",
      "label": "trace",
      "intent": "discuss",
      "side": "added",
      "text": "Explain how execution reaches this line."
    }
  ]
}
```

- `version` — schema version, currently `1`
- `builtins.disable` — built-in template shortcut IDs to disable
- `shortcuts` — custom template shortcuts

Each custom shortcut requires a stable `id`, one-character `key`, short `label`, `fix` or `discuss` intent, `added`, `deleted`, or `both` side, and comment `text`.

