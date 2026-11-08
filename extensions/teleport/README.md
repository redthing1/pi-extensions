# Teleport

Work in an SSH workspace while Pi's conversation, provider credentials, and
orchestration stay on the client.

## Usage

```sh
pi --teleport host:/path/to/project
```

The target is `host[:path]`. Omit the path to use the remote login directory.
OpenSSH uses your local authentication setup; the endpoint needs Node.js or Bun.
Teleport supplies its worker from this checkout.

| Command | Action |
| --- | --- |
| `/teleport` | Show connection status and available actions. |
| `/teleport disconnect` | Disconnect while keeping the client conversation. |
| `/teleport reconnect` | Reconnect to the same workspace without replaying commands. |

Workspace tools fail while disconnected and never fall back to the client's
filesystem. Resume a bound conversation with the matching `--teleport` target.

## Data

The endpoint receives requested operation arguments, commands, and file contents,
and may retain them. Teleport does not automatically upload the local conversation,
credentials, or personal configuration. Project resources come from the remote
workspace. Client ZDR controls client state, without making a retention claim
about the endpoint.
