# rt1 Pi extensions

An opinionated extension set for [rt1 Pi](https://github.com/redthing1/pi).

## Setup

Add it to your version-controlled Pi agent directory:

```sh
git -C ~/.pi/agent submodule add https://github.com/redthing1/pi-extensions.git vendor/pi-extensions
```

In `~/.pi/agent/settings.json`:

```json
{
  "packages": ["./vendor/pi-extensions"]
}
```

Restart Pi. Configure individual features in your agent directory.

## Extensions

| Area | Extensions |
| --- | --- |
| Workspace | [Teleport](extensions/teleport/), [Subagents](extensions/subagents/), [Intercom](extensions/intercom/) |
| Tools | [Apply Patch](extensions/apply-patch/), [Ask User](extensions/ask-user/), [Agent Search](extensions/agent-search/) |
| Workflows | [Goal](extensions/goal/), [Background Work](extensions/background-work/), [Schedule](extensions/schedule/) |
| Context | [Compact Horizon](extensions/compact-horizon/), [BTW & You Should Know](extensions/you-should-know/) |
| Safety | [Safety](extensions/safety/), [Execution Guard](extensions/execution-guard/), [Permission Gate](extensions/permission-gate.ts) |
| Providers | [llama.cpp](extensions/llamacpp-router/), [vLLM](extensions/vllm-router/) |
| Terminal | [rt1 Header](extensions/startup-banner.ts), [Completion Notifications](extensions/completion-notification.ts) |

## Development

Use an existing harness checkout with its dependencies hydrated:

```sh
PI_CHECKOUT=/path/to/pi bun run check
```
