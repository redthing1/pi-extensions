# Teleport

Use Pi's workspace tools against an SSH endpoint while the conversation,
provider credentials, and orchestration stay on the client.

```sh
pi --teleport host:/path/to/project
```

The target is `host[:path]`; omit the path to start in the remote login directory.
OpenSSH handles authentication using your local SSH setup. The remote endpoint
needs Node.js or Bun to run the worker. Teleport supplies the worker from this checkout.

`/teleport` shows connection status and available actions. `/teleport disconnect`
keeps the client conversation; `/teleport reconnect` reconnects to the same target
without replaying commands. Workspace tools fail while disconnected and never
fall back to the client's filesystem. Resume a bound conversation with the matching
`--teleport` target.

Remote operations receive their requested arguments, including commands and file
contents. The endpoint can retain anything it receives. Teleport does not
automatically upload the local conversation, credentials, or personal configuration.
Project resources are read from the remote workspace through its resource provider.
Client ZDR uses the harness's ephemeral-state rules; it does not make a retention
claim about the remote endpoint.

Safety, Execution Guard, Subagents, and background work compose through the shared
workspace and child-runtime contracts. Policy stays with its owning extension.
