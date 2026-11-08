# Shared Contracts

Libraries imported by the extensions. This directory has no extension entry point.

| Module | Responsibility |
| --- | --- |
| `active-workspace.ts` | Workspace identity, file operations, and child attachment. |
| `child-runtime.ts` | Policy, tool, and provider contributions to child launches. |
| `managed-child.ts` | Child-process lifecycle and cleanup. |
| `tool-effects.ts` | Tool capabilities, path effects, and analyzer discovery. |
| `serving-telemetry.ts` | Inference progress and status formatting. |

Extensions own their policies and adapters. Shared contracts compose those
implementations without selecting policy for them.

Serving adapters supply request-local counters to one telemetry controller.
The controller owns timing, throttling, formatting, and cleanup. Missing counters
produce elapsed time rather than estimated progress. Side requests can set
`metadata.servingTelemetry: false` to leave foreground status alone.
