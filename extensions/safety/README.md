# Safety

Control action approvals and command containment for local and Teleport workspaces.
Safety starts disabled.

## Usage

```sh
pi --safety --safety-profile explore
```

`/safety` opens the control panel. Choose a profile there or with
`/safety profile <name>`. Available profiles are `off`, `explore`, `code`,
`guarded`, `watch`, and `monitor`. Use `watch` for approval prompts without
command containment.

| Command | Action |
| --- | --- |
| `/safety status` | Show the effective policy. |
| `/safety explain` | Explain the current configuration. |
| `/safety approvals` | List reusable approvals. |
| `/safety forget` | Forget an approval. |
| `/safety audit` | Show audit status. |

## Policy

Reins handles allow, approval, and block decisions. Containment restricts command
filesystem, network, and environment access. Either can be enabled independently;
requested containment that is unavailable blocks execution.

User configuration lives in `safety/config.json` under the Pi agent directory.
Project `.pi/safety.json` rules can tighten the policy. Managed children inherit
the effective parent policy and reusable grants, but never a one-time launch
approval as unrestricted command approval.

Client ZDR keeps reusable approvals in memory, disables workspace approval
persistence, and turns off audit recording. Safety is a best-effort guard;
installed extensions still run with the Pi process's permissions.
