# vLLM Router

Use authenticated vLLM endpoints as Pi model providers, with capability discovery
and live inference progress.

## Setup

In `~/.pi/agent/settings.json`:

```json
{
  "vllmRouters": [
    { "name": "local", "url": "https://vllm.example.com" }
  ]
}
```

The provider ID is `vllm-<name>`. Use `/login vllm-local` to store its API key.
Authenticated `/v1/models` discovery supplies the model catalog.

## Settings

Each router accepts:

| Setting | Purpose |
| --- | --- |
| `zdr` | Explicitly approve this endpoint for ZDR use. |
| `stats` | Inference status; defaults to `enabled: true` and `minIntervalMs: 100`. |
| `discoveryTimeoutMs` | Discovery deadline; defaults to 5000 ms. |
| `models` | Model definitions and overrides keyed by model ID. |

Model overrides support `name`, `zdr`, `reasoning`, `defaultThinkingLevel`,
`thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`, and `compat`.
They can supply models before discovery and override endpoint metadata.
Set `zdr: true` only after approving the specific endpoint's retention policy.

## Models

The endpoint supplies context capacity, modalities, and reasoning capabilities.
Reasoning controls require advertised `reasoning_effort` support and understood
`reasoning_options`. Pi exposes the supported levels and sends the selected value
as `reasoning_effort`. Explicit model or session settings override the advertised
default.

The last usable discovered catalog stays in memory across refresh failures;
restart or reload requires fresh discovery. Endpoint metadata never grants ZDR
approval. Ordinary requests leave the output limit to the server; explicitly
bounded requests can set their own limit.

Request-local counters show prefill, decode rate, time to first token, and context
size. Servers without prefill counters show elapsed time. Set
`stats.enabled: false` to hide inference status.
