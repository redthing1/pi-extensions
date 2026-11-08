# llama.cpp Router Extension

Registers llama.cpp server routers from `~/.pi/agent/settings.json`.

The extension is generic: server URLs, API keys, and extra headers are read only from Pi runtime configuration, auth storage, or environment variables.

## Settings

```json
{
  "llamacppRouters": [
    {
      "name": "local",
      "url": "http://127.0.0.1:8080",
      "zdr": true,
      "apiKey": "OPTIONAL_ENV_VAR_OR_LITERAL",
      "headers": {
        "X-Example": "OPTIONAL_ENV_VAR_OR_LITERAL"
      },
      "stats": {
        "enabled": true,
        "minIntervalMs": 100
      },
      "request": {
        "returnProgress": true,
        "timingsPerToken": true,
        "includeUsage": true
      },
      "discoveryTimeoutMs": 5000,
      "requestTimeoutMs": 0,
      "httpIdleTimeoutMs": 0
    }
  ]
}
```

The provider id is `llamacpp-<name>`.

Set `zdr` on a router only after reviewing that specific server endpoint. It marks that router's discovered models as eligible for `pi --zdr`.

`discoveryTimeoutMs` bounds live model/server discovery. Ordinary startup restores
the last successful catalog without probing the server, then refreshes catalogs in
the background. An explicitly selected provider waits only for that router to
become ready. `requestTimeoutMs` is optional: omit it to inherit Pi's normal
request timeout, set a positive value for a router-specific absolute deadline, or
set it to `0` to disable the router's absolute deadline for long local prefills.
Cancellation still works normally.

`httpIdleTimeoutMs` is optional: omit it to use Pi's normal fetch transport, set
a positive value for this router's socket idle limit, or set it to `0` to allow
silent local prefills indefinitely. It applies only to this router and does not
change timeout behavior for other providers.

## Streaming Stats

When supported by the llama.cpp server, the extension requests:

- `return_progress`
- `timings_per_token`
- `stream_options.include_usage`

Pi assistant message events remain standard. Exact prefill/decode/cache details are
normalized into the shared serving-telemetry contract and displayed in the working
spinner while llama.cpp is processing. When `prompt_progress` is present this includes
moving processed/total counts and a real percentage. The status returns to Pi's default
working message when the stream ends.

When the live server advertises thinking capability, its models are registered
as reasoning-capable. A llama.cpp server with structured
`chat_template_caps.reasoning_effort_levels` metadata also gets an exact Pi
`thinkingLevelMap`, so unsupported levels are removed from Pi's selector and
supported levels are sent through the generic `chat_template_kwargs` interface.
The request controls are `enable_thinking`, `preserve_thinking`, and
`reasoning_effort`. Older servers without the structured level list retain
their explicit capability behavior but cannot safely advertise model-specific
effort levels. Explicit router and model compatibility settings take
precedence. Server-side `reasoning_format` remains responsible for extracting
generated reasoning.

Discovery requires `/v1/models`. `/props` and `/slots` are capability endpoints:
`404 Not Found` and `501 Not Implemented` disable only that capability. At least
one of them must report a valid context window.

The context window and optional local `maxTokens` override are planning metadata,
not ordinary request defaults. Normal inference omits both OpenAI output-limit
fields and leaves stopping to llama.cpp and the model. Explicitly bounded internal
operations or API callers may still provide a per-request limit.

## Code Layout

- `index.ts` wires the extension lifecycle and provider registration.
- `provider.ts` registers cached dynamic providers without startup network access.
- `config.ts`, `models.ts`, and `discovery.ts` load Pi config and discover live llama.cpp model capabilities.
- `stream.ts` owns request execution and the high-level SSE loop.
- `llama-stats.ts` parses llama.cpp progress/timing metadata and applies the prefill-over-decode precedence rule.
- `streaming-output.ts` turns OpenAI-style streaming deltas into Pi assistant message events.
- `usage.ts` handles usage parsing and fallback usage derived from llama.cpp timings.
- `../shared/serving-telemetry.ts` is the single source of truth for settings,
  lifecycle, throttling, rates, and spinner formatting across serving engines.
