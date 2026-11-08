# Schedule

Send a follow-up later or create a repeating prompt in the current session.

## Usage

```text
/delay 10m Review the deployment
```

`/delay <duration> <message>` creates a one-shot follow-up. Use a compact duration
such as `30s`, `10m`, `1h30m`, or `2d`.

`/schedule` opens the panel to create, edit, pause, resume, run, or delete a schedule.
Choose a relative delay, local time, or repeating interval. Relative forms include
`2 hours` and `1h and 15m`; local-time forms include `14:30`, `tomorrow 9am`, and
`fri 17:00`.

Choose whether a busy agent waits until idle or queues the prompt as a follow-up.
Timers run only while the session is open. Schedule state is saved with the
conversation; restoring a session runs an overdue one-shot schedule at most once.
