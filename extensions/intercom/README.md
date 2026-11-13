# Intercom

Exchange messages with independent local agent sessions through
[agent-intercom](https://github.com/redthing1/agent-intercom).

Install `intercom` on `PATH`, then restart Pi. Set `INTERCOM_BIN` to select
an explicit executable. Use `intercom_list` to find peers and `intercom_send` to
message them. `/intercom` shows your identity; `/intercom on` or `off` controls
messaging for the session.

Messages arrive between turns and wake an idle agent. Escape or a model error
pauses automatic delivery until your next prompt or `/intercom on`. Peers remain
independent; their messages do not grant user approval. With Teleport, messaging
stays local and remains available while the workspace is disconnected.
