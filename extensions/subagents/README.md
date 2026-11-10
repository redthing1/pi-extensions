# Subagents

Delegate focused tasks to child Pi processes, locally or through Teleport.

## Usage

```ts
subagent({
  tasks: [{
    label: "review",
    task: "Review the authentication flow.",
    tools: ["read", "grep", "parent_message"]
  }],
  background: true
})
```

Each task requires `task` and `tools`; `tools: []` grants no tools. Working
directory, model, and thinking level default to the parent's. A model override
stays within the parent's provider and scoped models. `background` is required:
`true` returns child IDs immediately; `false` waits for results.

| Tool | Action |
| --- | --- |
| `subagent_list` | List outstanding work or inspect selected children. |
| `subagent_send` | Send context or steering to a running child. |
| `subagent_wait` | Wait for results; the default timeout is 30 seconds. |
| `subagent_cancel` | Request cancellation and wait up to 30 seconds for cleanup. |

`subagent_wait` accepts `timeoutSeconds: null` to wait indefinitely. Large results
provide continuation calls. Inspection and completion notices do not collect a
result; reading its final page does. Collected runs remain available by ID or
with `includeCollected: true`.

`/subagents` opens the live panel. A child granted `parent_message` can send findings
while it continues. Finished children cannot be reopened.

## Settings

In `~/.pi/agent/subagents/config.json`:

```json
{ "maxConcurrency": 4 }
```

Four children run at once by default; excess tasks queue. Children inherit the
applicable workspace and policy contributions. They do not inherit ambient
extensions or delegation tools. Session replacement, reload, and shutdown stop
owned work.

Run records live under `runs/subagents` in the Pi agent directory. Client ZDR keeps
messages and results in memory and cleans temporary launch inputs when children end.
