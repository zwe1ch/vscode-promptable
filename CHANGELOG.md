# Changelog

All notable changes to Promptable are documented in this file.

## Unreleased

### Added

- Added project-specific `.promptableignore` support. It uses `.gitignore` syntax, lives in the workspace folder root (or the Git repository root for files outside a workspace), and is applied by all copy commands, independently of `.gitignore`. The `.promptableignore` itself is never copied.

- Nested `.gitignore` and `.promptableignore` files are now evaluated hierarchically, following Git semantics: patterns are relative to the directory of their ignore file, parent rules are inherited, rules in deeper files take precedence over parent rules of the same type, and files in excluded directories cannot be re-included. Sibling directories are not affected by each other's rules.

### Fixed

- Ignore patterns of `.gitignore` and `.promptableignore` now honor `core.ignorecase` of the Git repository containing each file instead of always matching case-insensitively. Without a known repository (or without a usable `git` executable), the platform default applies: case-insensitive on Windows and macOS, case-sensitive elsewhere.
- Files outside the workspace now respect the `.promptableignore` of their known Git repository, and a selected `.promptableignore` is never copied.
- In multi-root workspaces, copied files are now prefixed with their workspace folder name so identically named files from different folders have unique paths.

## 1.2.0 - 2026-08-07

### Added

- Added `Promptable: Copy All Changed Files as AI Context` to copy all changed files reported by open Git repositories from the Source Control view.

## 1.1.0 - 2026-08-07

### Added

- Added `Promptable: Copy as AI Context (Ignore .gitignore)` for intentionally copying files excluded by `.gitignore`, while continuing to exclude `.git` itself.
