# goal

Pi extension for a single branch-local looping goal.

Behavior:

- Registers `/goal`.
- Registers `get_goal`, `create_goal`, and `update_goal`.
- Keeps one branch-local goal in append-only session entries.
- Automatically appends a continuation after a normal Pi settlement, preserving the model's cached context. Pi alone owns provider retries. A terminal provider error leaves the goal active but marks its loop as waiting; a later successful turn clears that marker, while `/goal resume` clears it explicitly and restarts the loop.
- Supports token budgets such as `80k` and `1.5m`.
- Shows a compact footer status, an interactive status panel, and a form-style setup flow.

Commands:

- `/goal` opens setup when no goal exists, or the panel when a goal exists.
- `/goal <objective> [--budget 80k]` sets or replaces a goal after confirmation.
- `/goal replace <objective> [--budget 80k]` replaces without confirmation.
- `/goal status`, `/goal pause`, `/goal resume`, `/goal clear`.
- `/goal budget <tokens|clear>` sets or clears the token budget.

Shortcut:

- `F8` pauses an active goal or resumes a paused, blocked, or waiting goal.

`create_goal` only creates explicitly requested goals, `get_goal` reads state, and `update_goal` only marks a goal `complete` or `blocked`.

Reload with `/reload` in Pi after editing this extension.
