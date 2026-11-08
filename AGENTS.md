# Development

- Run `PI_CHECKOUT=/path/to/pi bun run check` after code changes. Use the harness's locked tools; do not install dependencies here.
- Keep shared contracts in `extensions/shared/` and policy in its owning extension.
- Use isolated synthetic fixtures. Live model checks require explicit authorization.
