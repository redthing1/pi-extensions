# BTW & You Should Know

Ask side questions and optionally receive observations without interrupting the
main task. Both features use the active model in Pi's TUI.

## Usage

| Command | Action |
| --- | --- |
| `/btw <question>` | Start a side question from the current conversation. |
| `/btw` | Open the current answer and follow-ups. |
| `/btw cancel` | Stop the side answer. |
| `/ysk` | Enable the observer, or open its current finding or status. |
| `/ysk off` | Disable the observer. |
| `/ysk show` | Open a finding. |
| `/ysk dismiss` | Dismiss a finding. |

Enter opens a follow-up composer. Escape returns to reading, then closes the
panel without canceling the answer. Ctrl+X stops it; Ctrl+O opens forwarding and
discard actions. Forwarding places the exchange in the main composer without
submitting it or overwriting an existing draft.

Remap `extension.btw.stop` and `extension.btw.actions` in `keybindings.json`.

## Observer

You Should Know starts disabled. It checks after at least six completed model
turns and two minutes, with no concurrent side request. Findings appear quietly
in the footer. Opening one reuses its answer without another model call.
Ignored findings expire after six more turns and increase the cooldown, up to
eight minutes.

Side requests preserve the prepared context and execute no tools. Load this
extension after context-transforming extensions such as Teleport. State stays in
memory; compaction, model or reasoning changes, and conversation navigation clear
side topics. Shutdown and reload cancel pending requests.
