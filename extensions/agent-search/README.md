# Agent Search

Registers `web_search` and `web_fetch` as a thin client for an AgentSearch Bridge.

Search is disabled by default. Enable it for one Pi invocation with:

```sh
pi --search
```

In an existing session, `/websearch` opens a small Search & fetch toggle.
`/websearch on` and `/websearch off` change the same setting directly. Opening
the panel does not enable search, load credentials, or contact the service.

Changes apply while the agent is idle and no search request or search-enabled
child agent is outstanding. Both tools and their prompt guidance are removed
when disabled; stale tool calls and new child launches are rejected. Existing
conversation messages and search results are preserved. Changing the tool set
may reduce prompt-cache reuse on the next model request.

The toggle is held only in memory for the current session. New, resumed, forked,
and reloaded sessions use the startup defaults again; transcript contents do not
restore consent. The panel never writes settings. `--search` therefore enables
search again after `/reload`, even if it was manually turned off beforehand.

To enable it for every invocation, use Pi settings:

```json
{
  "agentSearch": {
    "alwaysEnabled": true
  }
}
```

Before first enablement, the extension registers only its flag, command, and
lifecycle handlers. Tools, effect analyzers, and the child-agent provider are
registered on first enablement. Later disabling leaves the definitions registered
but hidden and guarded, with no search capability offered to child agents.

The extension reads only the named `agent-search` entry from Pi's ignored, mode-`0600` central `tokens.json` store:

```json
{
  "agent-search": {
    "token": "bridge bearer token",
    "baseUrl": "https://search.example.com",
    "allowHttp": false
  }
}
```

A different entry may be selected with the `agentSearch.token` setting. HTTPS is required by default; allow HTTP only over an explicitly trusted encrypted private network. The extension has no environment-variable or per-extension token-file fallback.

Absent settings register no tools until explicitly enabled. Invalid settings report a startup error. Credentials are loaded and validated only when search is enabled. Service failures are reported only when a tool is called and do not affect Pi startup.

Missing or invalid configuration disables Agent Search and reports one concise
diagnostic. Expected configuration failures do not produce extension stack traces.

Safety policy belongs to the Safety extension; this extension only validates configuration, calls the bridge, and renders bounded results.

The bridge receives search/fetch arguments, not the conversation. Queries and
URLs can themselves contain sensitive information and may reach public services;
enabling search is separate from the model provider's ZDR approval.

## Verification

Run `PI_SEARCH_CHECKOUT=/path/to/pi-mono node scripts/check.mjs` for strict
source checks and isolated faux-provider tests. No real credentials are used.

Set `PI_SEARCH_DOCKER_IMAGE` to the full SHA-256 ID of an already-built local
Teleport test image to include Node and Bun TUI acceptance. These checks reuse
`test/background-work/scripts/container.mjs` and the Teleport test image
recipe. They use the real Teleport extension, a local synthetic search bridge,
client ZDR, private tmux, and fresh SSH keys. Container networking is disabled;
there are no host mounts or published ports. Fixtures are removed afterward.
