# Subagents

Delegate distinct work to focused child Pi processes. Each task requires explicit `task` and `tools`:

```ts
subagent({
  tasks: [{ label: "review", task: "Review the authentication flow.", tools: ["read", "grep", "parent_message"] }],
  background: true
})
```

`tools: []` grants no tools. Cwd and model default to the parent's; thinking level is inherited. An explicit
model stays within the same provider and scoped models.

`background` is required: `true` returns immediately; `false` waits for results.

`/subagents` opens a live current-session panel. Select a child to inspect its activity, messages, and
full result; collected history is available on request. Live children can be cancelled with confirmation.
Inspection does not collect results for the parent.

- `subagent`: start tasks; foreground waits, background returns child IDs immediately.
- `subagent_list`: compact outstanding overview; `ids` inspects tasks, activity, and messages.
- `subagent_send`: queue context or steering to one live child, without waiting for a reply.
- `subagent_wait`: wait up to 30 seconds for all selected results; `timeoutSeconds` overrides the limit,
  or `null` waits indefinitely. Timeout returns status without cancelling or collecting. Large results
  give an exact continuation call.
- `subagent_cancel`: cancel selected children and await cleanup.

Escape stops waiting for cancellation; owned cleanup continues without collecting unfinished results.

Children may use `parent_message` only when explicitly granted. It publishes a useful finding, question,
or blocker and returns immediately. Children continue independently; there is no wait-for-answer state.
Steering cannot undo an executing tool or change a child's capabilities. Finished children are not reopened.

Each background completion is announced independently at a safe parent boundary. Explicit messages also
arrive there; ordinary activity stays in focused inspection. Stopping the parent suppresses automatic
resumption until its next run. Notices and inspection do not collect results: final-page delivery does.
Collected runs leave the default overview but remain accessible by ID or `includeCollected: true`.
Lists and message inspection supply continuations rather than silently losing retained work.

One session-owned FIFO scheduler runs up to four children by default; excess work queues. A failure does
not cancel siblings. Switching sessions, reload, and shutdown end owned work. Cards show activity, messages,
cumulative tokens, and last-response context; expansion reveals full detail and results.

Safety, workspace, requested tool providers, and provider runtimes contribute their own launch context.
Unknown or duplicate tool providers fail before launch. Children do not inherit ambient extensions or
delegation tools. Subagents uses the same lifecycle locally and through Teleport.

Optional `subagents/config.json` (`{"maxConcurrency":4}`) lives under Pi's
agent directory, honoring `PI_CODING_AGENT_DIR`. Persistent run records live under `runs/subagents` there.
Client-ZDR messages/results remain in memory; private OS-temp launch inputs are cleaned when children
end, including failure and cancellation. Complete result paging works without access to artifact paths.

