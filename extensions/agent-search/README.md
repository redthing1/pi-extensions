# Agent Search

Search the web and fetch pages through an AgentSearch Bridge.

## Setup

Add the bridge credential to `~/.pi/agent/tokens.json` and restrict the file to
mode `0600`:

```json
{
  "agent-search": {
    "token": "replace-with-your-bridge-token-at-least-32-bytes",
    "baseUrl": "https://search.example.com"
  }
}
```

The token must contain at least 32 bytes. The URL must be an origin, without a
path, query, or credentials. HTTPS is required except on loopback; set
`allowHttp: true` only when the connection is otherwise protected.

## Usage

Start with `pi --search`, or use `/websearch on` in an existing session.
`/websearch` opens the toggle; `/websearch off` disables search and fetch.
The model receives `web_search` and `web_fetch` only while enabled.

Changes require an idle agent with no outstanding search work or search-enabled
children. The toggle resets on session startup and reload. To enable search by
default, set `agentSearch.alwaysEnabled: true` in Pi settings. Set
`agentSearch.token` to select a different named entry in `tokens.json`.

Credentials are read when search is enabled. The bridge receives search queries
and requested URLs; these can contain sensitive information. Model-provider ZDR
approval does not cover the bridge or downstream search services.
