# Background work

Run commands in the background and receive completion updates in Pi's TUI.

- `bash({command, background: true})` starts a job and returns a receipt.
- `background_status({id?})` inspects jobs and output.
- `background_wait({id})` waits up to 60 seconds and collects a finished result.
- `background_stop({id})` cancels a job and returns its result.
- `monitor({command, timeout?})` reports output events while a watcher runs.

Ctrl+B or `/background` promotes the current foreground command without restarting
it. During a wait, the same action releases the wait while the command continues.
Remap `extension.background.promote` in `keybindings.json`; `[]` disables it.

Escape in the main editor or `/background mute` silences existing jobs without
stopping them. Their results remain available through status and wait. Updates
wait while Pi is busy or a form is open. Session replacement, reload, and shutdown
stop owned work.

Monitors treat nonblank output lines as events and batch updates at least five
seconds apart. Filter meaningful changes in the command itself. The default
lifetime is 300 seconds, capped at 1800. Oversized events or pending batches stop
the watcher with an error.

Up to eight background commands can run, with 64 retained job records. Command
capture stops at 32 MiB; redirect larger output to a file. Completed output can
be paged through `read_output`.

Uses the selected Bash tool, including Teleport and Safety policies. Workspace
loss never falls back to local execution. Print, JSON, and RPC support ordinary
foreground Bash and reject explicit background requests.

## Checks

The [collection check](../../README.md#development) includes synthetic tests.
The optional live controller is `test/background-work/scripts/live.mjs`, run from
the repository root with explicit `PI_BACKGROUND_CHECKOUT`,
`PI_BACKGROUND_AUTH_SOURCE`, and `PI_BACKGROUND_DOCKER_IMAGE` settings. The image
must be an already-built local `sha256:` ID from the Teleport test Dockerfile.
Live checks require authorization for the selected provider credential and model
calls. `PI_BACKGROUND_CLI` selects an installed CLI instead of the source entry.
