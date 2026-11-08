# Goal

Keep Pi working toward one explicit goal, with an optional token budget.

## Usage

```text
/goal Implement the new command --budget 80k
```

`/goal` opens setup or the current goal panel. The footer shows progress.
A goal belongs to the current conversation branch.

| Command | Action |
| --- | --- |
| `/goal status` | Show state and usage. |
| `/goal pause` | Pause continuation. |
| `/goal resume` | Resume a paused, blocked, or waiting goal. |
| `/goal replace <objective> [--budget 80k]` | Replace the goal without confirmation. |
| `/goal budget <tokens>`, `/goal budget clear` | Set or remove the budget. |
| `/goal clear` | Clear the goal. |

Budgets accept values such as `80k` and `1.5m`. F8 pauses or resumes the goal.
Setting a new objective through `/goal <objective>` asks before replacing an
existing goal.

The model can read, explicitly create, complete, or mark a repeatedly blocked
goal through `get_goal`, `create_goal`, and `update_goal`. A normal settlement
continues an active goal. A terminal provider error leaves it waiting until a
successful turn or `/goal resume`.
