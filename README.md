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

Includes [Safety](extensions/safety/), [Execution Guard](extensions/execution-guard/),
[Teleport](extensions/teleport/), [Subagents](extensions/subagents/),
[Goal](extensions/goal/), [background work](extensions/background-work/),
[Ask User](extensions/ask-user/), [Agent Search](extensions/agent-search/),
[llama.cpp](extensions/llamacpp-router/) and [vLLM](extensions/vllm-router/) adapters,
[compaction](extensions/compact-horizon/), [scheduling](extensions/schedule/),
[side questions](extensions/you-should-know/), and the rt1 terminal presentation.

## Development

Use an existing harness checkout with its dependencies hydrated:

```sh
PI_CHECKOUT=/path/to/pi bun run check
```
