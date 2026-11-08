# Apply Patch

Add a structured `apply_patch` tool alongside Pi's `edit` and `write` tools.
The tool is enabled for GPT-named models.

## Usage

A patch can contain these operations:

- `create_file` creates a file.
- `update_file` edits a file and optionally moves it with `move_path`.
- `delete_file` removes a file.

Operations run sequentially in the active workspace. Relative paths resolve
from its working directory; absolute paths and `~` are accepted. Updates preserve
CRLF line endings. Very large patch payloads are rejected.
