# Background Work

Run commands in the background and receive updates in Pi's TUI.

## Usage

| Tool | Action |
| --- | --- |
| `bash({command, background: true})` | Start a job and return immediately. |
| `background_status({id?})` | Inspect jobs and output. |
| `background_wait({id})` | Wait up to 60 seconds and collect a finished result. |
| `background_stop({id})` | Cancel a job and return its result. |
| `monitor({command, timeout?})` | Report output events while a command runs. |

Foreground Bash commands automatically continue in the background after 30 seconds.
Ctrl+B or `/background` promotes one immediately without restarting it.
During a wait, the same action releases the wait while the command continues.
Remap `extension.background.promote` in `keybindings.json`; `[]` disables it.

Escape in the main editor or `/background mute` silences existing jobs without
stopping them. Status and wait still return their results. Automatic updates wait
while Pi is busy or a form is open.

## Limits

Monitors batch nonblank output lines at least five seconds apart. Filter events
in the command itself. Their default lifetime is 300 seconds, capped at 1800;
oversized events or pending batches stop the watcher with an error.

Up to eight managed commands can run, including foreground work, with 64 retained
job records. Command capture stops at 32 MiB; redirect larger output to a file.
Page retained output through `read_output`.

Commands use Pi's execution timeout. Backgrounding never extends the deadline;
request a longer `timeout` when starting work that needs it.

Jobs use the selected Bash tool, including Teleport and Safety policies. Workspace
loss never falls back to local execution. Session replacement, reload, and
shutdown stop owned work. Explicit background requests require the TUI.
