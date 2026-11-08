# vLLM Router Extension

Registers authenticated vLLM OpenAI-compatible endpoints from `~/.pi/agent/settings.json`.
It discovers model capabilities from the endpoint and translates them into Pi's native
model contract. Its thin request adapter leaves output length to vLLM and adds request-local
performance telemetry; message, reasoning, and tool-call parsing remain native Pi behavior.

## Settings

```json
{
  "vllmRouters": [
    {
      "name": "local",
      "url": "https://vllm.example.com",
      "zdr": true,
      "stats": {
        "enabled": true,
        "minIntervalMs": 100
      },
      "discoveryTimeoutMs": 5000
    }
  ]
}
```

The provider id is `vllm-<name>`. Use `/login vllm-<name>` to store its API key.
Configured models make the provider available immediately after login; authenticated
`/v1/models` discovery refreshes the live catalog without guessing model capabilities.
Each router remembers its last usable discovered catalog in memory for offline or
failed refreshes. A successful discovery replaces it; local overrides still apply.
Restarting or reloading the extension requires fresh discovery.

## Capability discovery

The endpoint owns model truth. The adapter recognizes conventional public fields on each
`/v1/models` entry:

- `name`
- `max_model_len` (or `context_length`)
- `max_completion_tokens`
- `architecture.input_modalities`
- `supported_parameters`, including `reasoning_effort`
- `reasoning_options`, containing the exact accepted values
- `default_parameters.reasoning_effort`

`max_completion_tokens` is capacity metadata for planning; it is not a request
default. Ordinary requests omit both OpenAI output-limit fields, allowing vLLM
to generate until a model stop condition or the remaining context-window boundary.
A caller may still set an explicit per-request limit for bounded operations.

Reasoning controls are exposed only when both `supported_parameters` advertises
`reasoning_effort` and `reasoning_options` contains at least one understood active level.
Pi sends the selected advertised value as the standard top-level `reasoning_effort` field.
The server remains responsible for translating that semantic control into model-specific
template arguments. No model names, families, architectures, or tokenizer templates are
used as capability heuristics.

Unsupported Pi levels are omitted from the selector. An explicit user or session setting
wins over `default_parameters.reasoning_effort`; otherwise the advertised default wins,
followed by Pi's own fallback. ZDR approval is intentionally never accepted from remote
metadata and remains local policy.

The optional `models` object is an operator override and bootstrap escape hatch. Its fields
override advertised metadata per model: `name`, `zdr`, `reasoning`,
`defaultThinkingLevel`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`, and
`compat`. A manually asserted reasoning model uses standard top-level `reasoning_effort`
unless `compat` explicitly selects another protocol.

## Live performance telemetry

Telemetry is enabled by default and can be disabled per router with
`"stats": { "enabled": false }`; disabled routers skip only the telemetry relay.
The adapter opts into the small `prefill_progress` vLLM extension when the server
supports it. Exact completed-chunk counters then render as, for example,
`vllm pre 60% 16.4k/27.2k 5.4k/s`. The rate is the latest uncached-token delta
divided by the client-observed interval between progress events, so it moves as
deep-context prefill slows. An unpatched server simply emits no metadata and the
same UI falls back to truthful elapsed time such as `vllm pre 5.6s`; the client
never estimates a percentage.

Once the first generated token arrives, vLLM's continuous usage data supplies exact
prompt and output-token counts. The indicator switches to a compact decode view such
as `vllm dec 128 @94/s · ttft 5.6s · ctx 32k`. The completed prompt is labeled as
time-to-first-token and context, not left on screen as apparently frozen prefill progress.
Decode rate is measured client-side from exact continuously reported completion-token
counts.

The implementation composes Pi's payload and metadata hooks, requests vLLM continuous
streaming usage plus opt-in progress, and relays Pi's native assistant events unchanged.
It does not poll global metrics, duplicate the OpenAI parser, log request content, or add another UI panel.
Lifecycle, formatting, and telemetry defaults come from the shared
`../shared/serving-telemetry.ts` implementation used by all serving adapters.
