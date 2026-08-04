# pi-tao

`pi-tao` is a simple extension that allows you to keep peace of mind
while doing AI-assisted programming.

It's changing fast and I'm not sure what to put here... but trust me,
it's the next big thing.

## Basic flow

1. Run `/jj:describe` to describe the change you want in your editor.
2. Run `/jj` to send that description to the agent as the task specification.
3. Run `/jj:diff` to open the terminal-native review and annotation surface on the result. Pass a workspace path, a change ID, or both, such as `/jj:diff ../other-workspace`, `/jj:diff beef`, or `/jj:diff ../other-workspace abcde`.
4. Pick Change or Stack with `1` or `2`. In Change, press `r` to choose another change.
5. Move to the file and line you want to review.
6. Add feedback:
   - `f` for a line comment with `FIX` preselected
   - `d` or `c` for a line comment with `DISCUSS` preselected
   - `l` for a file comment
   - `a` for a whole-review note
7. Press `s` to insert the generated prompt into Pi's editor.
8. Edit it if needed, then send it normally.

For fast repeated feedback, select a changed line, press `t`, then press a template shortcut from the comments panel. Press `e` afterwards to refine the generated comment.

## Installation

```bash
pi install git:github.com/clouedoc/pi-tao
```

## Commands

| Command | Description |
| --- | --- |
| `/jj:diff [path] [change ID]` | Review the current or specified change in the current or specified workspace |
| `/jj:cwd` | Show the default workspace used by `/jj:diff` and `/jj` |
| `/jj:cd <path>` | Set the default workspace used by `/jj:diff` and `/jj` |
| `/jj:describe` | Edit the current change description in your editor |
| `/jj:log [x]` | Show the `x` most recent commits (default 5) |
| `/jj:new` | Create a new change on top of `@` |
| `/jj` | Send the current change description to the agent as the task specification |

`/jj` treats the description of `@` as the complete task specification and asks the agent to implement it without reorganizing jj changes. It queues the task as a follow-up when the agent is busy.

## `jj:diff` Template shortcut configuration

Optional user configuration lives at:

```text
~/.pi/agent/extensions/tao.json
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


## Credits

> [!NOTE]
> `pi-tao` was initially forked from [pi-slopchop](https://github.com/robzolkos/pi-slopchop).
