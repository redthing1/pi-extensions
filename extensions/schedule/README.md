# Schedule Extension

Minimal in-session scheduling for Pi.

- `/schedule` opens the TUI panel.
- `/delay 10m review the deployment` creates a one-shot scheduled follow-up.
- State is stored as custom session entries and is not sent to the model.
- Scheduled prompts are delivered with `sendUserMessage()`.
- Timers only run while the session is open.
- Restoring a session or resuming a paused overdue schedule runs it at most once.

Accepted duration examples:

- `10m`
- `1h30m`
- `2 hours`
- `1h and 15m`
- `in 1.5h`

`/delay` uses a compact duration as its first argument, such as `30s`, `10m`,
`1h30m`, or `2d`. Manage or cancel the resulting one-shot schedule with
`/schedule`.

Accepted local time examples:

- `14:30`
- `9am`
- `tomorrow 9:30`
- `fri 17:00`
- `2026-06-18 9am`
- `6/18 9am`

