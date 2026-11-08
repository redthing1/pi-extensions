# Compact Horizon

Compacts long conversations using the active model and reasoning level. Keeps a
bounded set of complete recent turns and tool flows, followed by a checkpoint
summary. The transcript entry is labeled `[horizon]`.

Checkpoint requests preserve the prepared conversation, tool definitions, and
normal cache policy. They execute no tools. Pi handles provider retries, history
transactions, and continuation.

Use `/horizon edit` while idle to correct the active checkpoint. The editor shows
its summary and supports the normal external-editor shortcut. Saving preserves
subsequent messages and records a branch-local correction without a model call.
Canceling or leaving the text unchanged preserves the existing checkpoint.
To edit an older checkpoint, navigate there with `/tree` first.

Run the [collection checks](../../README.md#development) for deterministic
compaction, checkpoint, and editing tests.
