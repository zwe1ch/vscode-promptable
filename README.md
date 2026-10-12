# Promptable 🚀

**Promptable** is a lightweight VS Code extension that turns files and folders into **prompt-ready AI context** with a single action.

Right-click files or folders, copy them as structured text, and paste directly into ChatGPT, Claude, or any other LLM.

---

## Features

- **Files & Folders**
  Copy individual files, multiple selections, or entire folders.

- **Recursive Folder Support**
  Includes all files inside selected folders recursively.

- **Choose How `.gitignore` Is Handled**
  The standard copy command respects `.gitignore` rules, including nested `.gitignore` files. An additional command can intentionally ignore those rules.

- **Project-Specific `.promptableignore`**
  Permanently exclude files and directories from all copy commands, independent of `.gitignore`. See [Excluding files with `.promptableignore`](#excluding-files-with-promptableignore).

- **Git Metadata Stays Excluded**
  The `.git` directory itself is never copied, even when `.gitignore` rules are ignored.

- **Copy Git Changes**
  Copy all staged, unstaged, untracked, and merge/conflict changes reported by Git across open repositories. Files appearing in multiple change groups are included only once.

- **Binary-Safe**
  Binary files (images, PDFs, archives, executables) are detected automatically and replaced with a placeholder.

- **Multi-Selection Support**
  Works with any combination of files and folders in the Explorer.

- **Dynamic Markdown Fences**
  Uses dynamically sized backtick fences to safely handle files that already contain fenced code blocks.

- **Clear File Delimiters**
  Each file is wrapped with `START` / `END` markers for reliable LLM context.

- **Relative Paths**
  Paths are resolved relative to the workspace root.

---

## Usage

### Explorer

1. Select one or more files and/or folders
2. Right-click
3. Choose **Copy as AI Context** or **Copy as AI Context (Ignore .gitignore)**

The standard command excludes files matched by `.gitignore`. Use the second command when those files should be included; `.git` itself remains excluded.

### Editor

1. Right-click inside an open file
2. Choose **Copy as AI Context**

### Source Control

Use the **Copy All Changed Files as AI Context** button in the Git Source Control toolbar to copy only files currently reported as changed by Git. Deleted files are represented as `[Deleted file — content not available]`; unchanged workspace files are never included.

In multi-repository workspaces, changes from all open Git repositories are combined and deduplicated.

You can also run the command from the Command Palette:

```

Promptable: Copy as AI Context
Promptable: Copy as AI Context (Ignore .gitignore)
Promptable: Copy All Changed Files as AI Context

```

---

## Excluding files with `.promptableignore`

Create a `.promptableignore` in the root of your workspace folder (or, for Git repositories outside a workspace folder, the repository root) to keep files out of the copied context. It uses the usual `.gitignore` syntax: file names, directories, wildcards, comments, and negations.

Both `.promptableignore` and `.gitignore` files can also be placed in subdirectories. A nested file only applies to its own directory and below, and its patterns are interpreted relative to that directory, exactly like Git does (a pattern with a leading or inner `/` is anchored there, a plain `foo` matches at any depth below it). Rules of parent directories are inherited, and rules in deeper files take precedence over rules in parent files of the same type, so a nested `!important.log` can re-include a file that a central `*.log` excludes. As in Git, a file can never be re-included while one of its parent directories is excluded.

```text
project/
├── .promptableignore          # *.log
├── sub-project-1/
│   ├── .promptableignore      # foo          -> only sub-project-1/foo is excluded
│   └── foo
└── sub-project-2/
    ├── .promptableignore      # !important.log  -> re-includes it despite the central *.log
    └── important.log
```

```text
# Never copy these
package-lock.json
.env
*.log
dist/
!important.log
```

- Applies to **all three commands**, including **Copy as AI Context (Ignore .gitignore)** and **Copy All Changed Files as AI Context**, for directly selected files, folders, multi-selections, and deleted files in the Git change list.
- Case sensitivity follows the effective `core.ignorecase` of the Git repository that contains the file (Git's default is case-sensitive when the setting is not set), so nested and sibling repositories can differ. For files outside any repository known to the Git extension, or if the `git` executable cannot be run, the platform default is used: case-insensitive on Windows and macOS, case-sensitive elsewhere.
- Works independently of `.gitignore`: a negation in one file type never re-includes files excluded by the other, and the same hierarchy rules apply to nested `.gitignore` files. Global Git ignore configuration (`core.excludesFile`, `.git/info/exclude`) is not evaluated.
- In multi-root workspaces, each folder uses its own `.promptableignore`, and copied paths are prefixed with the workspace folder name so they stay unique.
- Files outside the workspace use the `.promptableignore` of their Git repository root when Git knows that repository.
- A `.promptableignore` file itself is never copied.
- It may itself be listed in `.gitignore`; Promptable reads it directly from the root regardless of Git ignore rules.
- Without a `.promptableignore`, nothing changes. If it exists but cannot be read, the copy is aborted with an error.
- If every file is excluded, the clipboard is left untouched.

---

## Output Example

`````text
--- START OF FILE: src/utils.ts ---
````ts
export const add = (a: number, b: number) => a + b;
````
--- END OF FILE: src/utils.ts ---

--- START OF FILE: public/favicon-16x16.png ---
[Binary file — content not included]
--- END OF FILE: public/favicon-16x16.png ---
`````

---

## Installation

1. Download the `.vsix` file
2. Open VS Code
3. Go to the Extensions view (`Ctrl+Shift+X`)
4. Click the `...` menu
5. Select **Install from VSIX...**

---

## Why Promptable?

Promptable focuses on **deterministic, transparent output**.

No AI calls, no hidden processing — just clean, reliable context you fully control.

Perfect for:

- ChatGPT / Claude prompts
- Code reviews
- Architecture discussions
- Bug reports
- Documentation generation
