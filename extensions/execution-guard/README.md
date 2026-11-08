# Execution Guard

Block recognized destructive commands and broad filesystem-root traversals.
The guard is active whenever the extension is loaded and works independently
of Safety.

## Usage

No configuration is required. Ordinary commands run without a prompt. Rejected
actions report the category and rule that blocked them.

The guard checks the final shell command and destination, including interactive
`!` and `!!` commands, Teleport execution, and managed children. Structured
`find` and `grep` tools follow the same root-traversal rule.

Shallow root inspection is allowed. An output-depth option such as
`du --max-depth` still traverses the tree and does not make a root crawl safe.

Checks are static: unsupported shell syntax and arbitrary interpreter programs
are outside the guard's guarantees.
