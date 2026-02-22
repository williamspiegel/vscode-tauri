# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

## Precommit Check

- Before handing off commit-ready changes, run `npm run -s precommit` from the repository root.
- If relevant files are both staged and unstaged (`MM` in `git status`), stage updates first before running precommit to avoid hygiene hook buffer mismatches.
