# Pi Safety Extension

Safety has one user-facing surface and two internal engines:

- Reins decides whether actions are allowed, need approval, or are blocked.
- Containment enforces filesystem, network, and environment restrictions.

Pi emits one immutable finalized Bash launch for model tools, interactive
`!`/`!!`, and RPC. Safety analyzes that exact command and working directory.
It does not replace Pi's Bash tool.

Reins and Containment are independent. Either can be enabled without the
other. If Containment is selected but unavailable, Safety blocks Bash instead
of silently running it uncontained.

Darwin containment preserves the selected `DEVELOPER_DIR` and an explicit
`SDKROOT`. It permits xcrun's named cache files in macOS's per-user temporary
directory; unrelated files there remain subject to the normal filesystem policy.

Run the collection checks from the repository root as described in the
[development guide](../../README.md#development).

Use it in Pi:

```bash
pi --safety --safety-profile explore
```

Profiles are `off`, `explore`, `code`, `guarded`, `watch`, and `monitor`.
Use `watch` when you want Safety to ask before risky actions without running
commands in containment.

Inside Pi, `/safety` opens the Safety panel. Command shortcuts are still
available, including `/safety status`, `/safety profile`, `/safety approvals`,
`/safety forget`, `/safety explain`, and `/safety audit`.

In ZDR and no-session modes, Safety keeps reusable approvals in memory for the
live session only. Workspace approvals are neither loaded nor written, audit
recording is disabled, and approval prompts do not offer workspace persistence.

When a managed child process is launched, Safety—not the child launcher—owns
Safety inheritance. It passes a private, versioned, ephemeral context containing
the exact effective parent policy, reusable approvals, and delegation-scoped
path grants. The child retargets that policy to its actual workspace. Project
policy may tighten an active inherited policy, but it does not activate Safety
when the parent has turned it off. One-time command approval for the launch is
never transferred as command approval inside the child.

Safety is a lightweight best-effort guard, not a security boundary against
hostile installed extensions, privileged processes, kernel flaws, or every
filesystem race. Incomplete shell analysis asks rather than treating an action
as safe.
