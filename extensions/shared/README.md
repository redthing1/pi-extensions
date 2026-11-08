# Shared extension contracts

This directory contains imported libraries, with no extension entry point:

- `active-workspace.ts` defines workspace discovery and operations.
- `child-runtime.ts` composes policy, tool, and provider contributions for children.
- `managed-child.ts` owns managed child-process lifecycle.
- `tool-effects.ts` defines tool effects and analyzer discovery.
- `serving-telemetry.ts` owns live inference status across serving adapters.

## Serving telemetry

`serving-telemetry.ts` is the single Pi-side source of truth for live inference status.
It is a library imported by serving-provider extensions, not an independently loaded
extension; this directory intentionally has no `index.ts`.

The shared module owns:

- telemetry settings and defaults;
- the normalized prefill/decode update contract;
- request lifecycle and stale-cleanup protection;
- client-derived decode timing;
- update throttling; and
- all compact status formatting.

Engine adapters own only extraction of trustworthy request-local facts:

- vLLM maps continuous usage events into cumulative prompt/output counts;
- llama.cpp maps `prompt_progress` and `timings` into the same contract; and
- future engines should add an adapter rather than another controller or formatter.

An adapter must not estimate token progress, parse tools when Pi already does, or
attribute server-global metrics to a request. If an engine provides no processed-token
counter during prefill, report no `promptProcessed`; the shared fallback is elapsed
prefill time. Once decode begins, completed prompt information is labeled `ttft` and
`ctx`, never left on screen as apparently frozen prefill progress.

Side inferences may pass `metadata.servingTelemetry: false` to the local provider
streams. They retain normal serialization and usage reporting but do not start or
end the foreground working indicator. This flag stays local to the adapters.
