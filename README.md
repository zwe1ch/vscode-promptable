# Promptable 🚀

**Promptable** is a lightweight VS Code extension that turns files and folders into **prompt-ready AI context** with a single action.

Right-click files or folders, copy them as structured text, and paste directly into ChatGPT, Claude, or any other LLM.

---

## Features

- **Files & Folders**
  Copy individual files, multiple selections, or entire folders.

- **Recursive Folder Support**
  Includes all files inside selected folders recursively.

- **.gitignore Aware**
  Automatically respects `.gitignore` rules, including nested `.gitignore` files.

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
3. Choose **Copy as AI Context**

### Editor

1. Right-click inside an open file
2. Choose **Copy as AI Context**

You can also run the command from the Command Palette:

```

Promptable: Copy as AI Context

```

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
