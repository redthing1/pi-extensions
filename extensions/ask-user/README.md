# Ask user

`ask_user({ questions: [{ question, label?, options?: [{ label, description? }] }] })`
opens a TUI form and returns the submitted questions and answers. Up to six
questions and eight choices per question; free text is always available.

The optional question label names its tab. Choose with arrows and Enter or a
number; use **Type something** for free text or Ctrl+E to qualify a choice.
Left/right moves between tabs outside the editor. Tab/Shift+Tab works throughout,
preserving unfinished text. The Submit tab reviews answers before sending them;
drafts must be confirmed first. Escape backs out of editing, then cancels the form.
**Chat about this** closes the form and asks the agent to discuss the current
question. Neither cancellation nor discussion submits drafts.

Long content wraps and scrolls. Key hints follow configured bindings. Form-only
actions `extension.askUser.previous`, `extension.askUser.next`, and
`extension.askUser.edit` can be remapped in `keybindings.json`; their defaults are
Shift+Tab, Tab, and Ctrl+E. Ordinary editor keys retain their meaning while typing.

The tool waits for input, requires the interactive TUI, and has no plan mode or
timeout. It uses the existing Teleport and Safety integration contracts and keeps
drafts in memory. Session shutdown and tool cancellation close the form.

Run isolated checks with `PI_ASK_CHECKOUT=/path/to/pi-mono node scripts/check.mjs`.

`scripts/live.mjs` runs synthetic scenarios with `opencode-go/deepseek-v4.1-flash`
through the existing Docker/Teleport fixture. Invoke only with authorization for
live inference and use of the selected provider credential. It requires explicit
`PI_ASK_CHECKOUT`, `PI_ASK_AUTH_SOURCE`, and `PI_ASK_DOCKER_IMAGE` (a reviewed local
`sha256:` image ID). Optional `PI_ASK_CLI` selects the installed CLI. Use a short
temporary base for SSH/tmux socket paths. The controller keeps credentials outside
the container and removes its state, keys, terminal, and container after testing.
