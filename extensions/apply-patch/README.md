# Apply Patch

Adds a structured `apply_patch` tool for GPT-named models alongside Pi's built-in
`edit` and `write` tools.

Supports `create_file`, `update_file`, `delete_file`, and optional `move_path`
on updates. Operations run sequentially against the active workspace. Paths
expand `~`, accept absolute paths, and resolve relative paths against the workspace.
Updates preserve existing CRLF line endings; very large patch payloads are rejected.
