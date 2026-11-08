# BTW and You Should Know

Side questions and a quiet optional observer for Pi's terminal UI. Uses the harness fork’s prepared-context APIs. Side requests execute no tools and keep their state in memory.

- `/btw <question>` opens a side topic from the current prepared conversation.
- `/btw` opens its answer, follow-ups, and an action to place the exchange in the main composer.
- `/btw cancel` stops the side answer without stopping the main task.
- `/ysk` enables You Should Know for this session; once enabled, it opens a finding or shows status. `/ysk off` disables it.
- `/ysk show` opens a finding; `/ysk dismiss` dismisses it.

Answers and follow-ups stay in one panel. Enter opens the reply composer; Escape returns to reading, then closes the panel while preserving the topic and draft. Closing leaves a running answer active. The footer shows `btw · answering`, or `btw · ready` for an unread answer; opening clears the unread indicator. Ctrl+X stops an answer; Ctrl+O opens forwarding and discard actions. These bindings are configurable as `extension.btw.stop` and `extension.btw.actions`. Arrow and page keys scroll while reading. Follow-ups keep their original context; a new question uses current main context. Forwarding preserves the existing main composer draft and does not submit it.

The footer shows `ysk` while the observer is enabled and `ysk · checking` during a request. A finding appears as a short Markdown preview without taking focus. Opening acknowledges it and clears the preview; the explanation remains available through `/ysk` until it expires or is dismissed.

The observer starts off. It checks after at least six completed model turns and two minutes, with no backlog or concurrent side requests. Ignored findings expire after six further turns and increase the cooldown, up to eight minutes. Recent findings discourage repetition. Silence is normal; failures are available in `/ysk` status. Opening a finding reuses its answer without another inference.

Side requests preserve prepared history and tool declarations, use the active model and reasoning setting, and append their instruction. They use the session's policy-bound registry and runtime cache affinity, with SSE to avoid sharing a mutable WebSocket continuation. Tools are never executed. Provider prompt fields are compared against the main request before dispatch; a mismatch stops the side request. Context is never shortened or compacted to accommodate side work.

Load after extensions that transform full request context, such as Teleport. A later transformation that changes the prefix is rejected by the payload check. With a virtual model, a side question waits for a completed turn so its concrete model is known.

State stays in memory. Compaction, model/reasoning changes, and tree/session transitions clear topics and cancel side work; shutdown/reload cleans up pending requests. Privacy and approved-provider routing come from Pi's existing policy. Provider error bodies and reasoning are not displayed or logged.

The local llama.cpp and vLLM adapters honor `metadata.servingTelemetry: false` so side requests leave foreground serving progress alone.

Use `/reload` to discover the local extension. The observer remains off until explicitly enabled.

## Verification

From this directory:

```sh
PI_BTW_CHECKOUT=/path/to/pi-mono node scripts/check.mjs
```

Checks type-check the extension and affected provider streams, run deterministic session/serialization/privacy tests, and exercise the real source CLI with Node and Bun in private isolated tmux sessions. Synthetic data and the faux provider or mocked HTTP replace external calls. Fixtures disable ambient discovery, verify ephemeral state and process teardown, and are removed. Checks do not read personal sessions, configuration, or credentials or make paid model calls.

Prefix preservation alone does not establish acceptable cache capacity or foreground performance on every server.
