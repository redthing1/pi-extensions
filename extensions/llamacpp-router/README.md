# llama.cpp Router

Use llama.cpp endpoints as Pi model providers, with capability discovery and live
inference progress.

## Setup

In `~/.pi/agent/settings.json`:

```json
{
  "llamacppRouters": [
    { "name": "local", "url": "http://127.0.0.1:8080" }
  ]
}
```

The provider ID is `llamacpp-<name>`. For authenticated endpoints, use
`/login llamacpp-local` or configure `apiKey`. API keys and `headers` values
accept environment-variable names or literal values.

## Settings

Each router accepts:

| Setting | Purpose |
| --- | --- |
| `zdr` | Explicitly approve this endpoint for ZDR use. |
| `stats` | Inference status; defaults to `enabled: true` and `minIntervalMs: 100`. |
| `discoveryTimeoutMs` | Discovery deadline; defaults to 5000 ms. |
| `requestTimeoutMs` | Request deadline; omit to inherit Pi's timeout, or use `0` for none. |
| `httpIdleTimeoutMs` | Socket idle limit; omit to use Pi's transport, or use `0` for none. |
| `request` | Toggle `returnProgress`, `timingsPerToken`, and `includeUsage`; all default to true. |
| `compat` | Router-wide protocol overrides. |
| `models` | Per-model overrides keyed by model ID. |

Model overrides support `name`, `zdr`, `reasoning`, `input`, `maxTokens`,
`thinkingLevelMap`, and `compat`. Set `zdr: true` only after approving the
specific endpoint's retention policy.

## Models

Discovery reads `/v1/models` and capability metadata from `/props` and `/slots`.
At least one capability endpoint must provide a valid context window. Advertised
reasoning levels determine the available controls. Pi can restore the stored
catalog before a refresh completes.

Context and output capacities are planning metadata. Ordinary requests leave the
output limit to the server; explicitly bounded requests can set their own limit.
When available, request-local progress counters show prefill, decode rate,
time to first token, and context size. Set `stats.enabled: false` to hide them.
