# Compact Horizon

Keep long conversations within the model's context window using checkpoint
summaries and a bounded set of complete recent turns.

## Usage

Compaction runs automatically with the active model and reasoning level.
Checkpoint requests preserve the prepared context, tool definitions, and cache
policy, and execute no tools. Checkpoints appear as `[horizon]` entries.

Use `/horizon edit` while idle to correct the active summary. The editor supports
the normal external-editor shortcut. Saving records a branch-local correction
and preserves subsequent messages without a model call. Canceling or leaving the
text unchanged preserves the existing checkpoint.

To edit an older checkpoint, navigate there with `/tree` first.
