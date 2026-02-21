# Electrobun Merge Policy

This branch uses `bun.lock` for local dependency workflows.

When merging from upstream `main`:

1. Merge `main` normally.
2. Always restore `package-lock.json` from upstream `main`.
3. Keep `bun.lock` as the local canonical lockfile.

Command example:

```bash
git fetch origin main
git merge origin/main
git restore --source=origin/main -- package-lock.json
```
