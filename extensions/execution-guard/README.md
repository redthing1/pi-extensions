# Execution guard

Silent accident prevention, independent of optional Safety. Recognized catastrophic destruction and reckless filesystem-root traversals are separate policy functions. Blocks report their category and rule; ordinary commands do not prompt.

Shell tools use Pi's final `bash_launch` event with destination cwd, home, and path semantics. Teleport supplies that identity through its Bash operations. Structured find/grep tools share the root-traversal rule. Managed children explicitly inherit the extension and protected reference roots.

Shallow root inspection is allowed. `du --max-depth` only limits output, so it does not make a root crawl safe. Unsupported shell syntax and arbitrary interpreter programs remain outside this static guard's guarantees.

From this directory, run the pure policy checks:

```sh
bun run scripts/check.ts
```

Run the source acceptance tests with Node, Bun, and tmux installed. No CLI build or installation is required:

```sh
PI_CHECKOUT=/path/to/pi-mono
PI_GUARD_TEST_CHECKOUT="$PI_CHECKOUT" bun "$PI_CHECKOUT/node_modules/vitest/dist/cli.js" --run --config scripts/vitest.config.ts
```

These cover the launch contract and actual Node/Bun CLI processes, managed children, and TUI model/`!`/`!!` requests. The extension's test configuration disables persistent result caching and adds its source alias without changing the checkout's test configuration. CLI fixtures use private temporary homes, agent directories, workspaces, an allowlisted environment, the faux provider, and a harmless local shell. They check ephemeral state and process shutdown, then remove their fixtures. Personal configuration, auth, extensions, and sessions are not loaded.

The real SSH acceptance case is optional. Set `PI_GUARD_TEST_SSH_CONFIG` to a disposable fixture's client config, with an explicit identity and known-hosts file, exposing alias `guard-fixture` and workspace `/workspace`. Use Teleport's pinned Docker test image, a fresh key, a loopback-only published port, and no personal mounts. Put `REMOTE_FIXTURE_OK` in `/workspace/sentinel.txt`. Both `/usr/local/bin/find` and `/usr/local/bin/rm` must contain exactly:

```sh
#!/bin/sh
printf "%s\n" "$0 $*" >> /workspace/rejected-dispatch.log
exit 98
```

The test verifies these harmless shims before launching Pi and asserts that neither receives a rejected command. Remove the task's container, network, keys, and temporary files afterward. Never point this test at a real host.
