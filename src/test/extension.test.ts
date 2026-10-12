import * as assert from "assert";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";

import { CopyChangedResult, copyChangedFiles, copyTargets } from "../extension";
import { GitChange, GitExtension, GitRepository, GitStatus } from "../git";

const clipboardSentinel = "promptable-test-clipboard-sentinel";

let workspaceRoot: string;
let testDirectoryIndex = 0;

async function createTempWorkspace(): Promise<string> {
  const directory = path.join(workspaceRoot, `case-${testDirectoryIndex++}`);

  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function resetClipboard(): Promise<void> {
  await vscode.env.clipboard.writeText(clipboardSentinel);
  assert.strictEqual(await vscode.env.clipboard.readText(), clipboardSentinel, "Could not reset the test clipboard");
}

async function executeCopy(command: string, mainUri: vscode.Uri, allUris?: vscode.Uri[]): Promise<string> {
  await resetClipboard();
  await vscode.commands.executeCommand(command, mainUri, allUris);
  return vscode.env.clipboard.readText();
}

async function withRootFiles(files: Record<string, string>, run: () => Promise<void>): Promise<void> {
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(workspaceRoot, name), content);
    }

    await run();
  } finally {
    for (const name of Object.keys(files)) {
      await fs.rm(path.join(workspaceRoot, name), { recursive: true, force: true });
    }
  }
}

async function executeTargetsCopy(targets: vscode.Uri[], respectGitignore: boolean, extension?: GitExtension): Promise<string> {
  await resetClipboard();
  await copyTargets(targets, respectGitignore, async () => extension);
  return vscode.env.clipboard.readText();
}

function gitChange(filePath: string, status: GitStatus): GitChange {
  return { uri: vscode.Uri.file(filePath), status };
}

function gitRepository(root: string, changes: Partial<GitRepository["state"]> = {}): GitRepository {
  return {
    rootUri: vscode.Uri.file(root),
    state: {
      mergeChanges: [],
      indexChanges: [],
      workingTreeChanges: [],
      ...changes
    }
  };
}

function gitExtension(repositories: GitRepository[], enabled = true): GitExtension {
  return {
    enabled,
    getAPI: () => ({ repositories })
  };
}

async function executeChangedCopy(extension: GitExtension | undefined): Promise<{
  clipboard: string;
  result: CopyChangedResult;
}> {
  await resetClipboard();
  const result = await copyChangedFiles(async () => extension);
  const clipboard = await vscode.env.clipboard.readText();

  return { clipboard, result };
}

suite("promptable Integration Test Suite", () => {
  suiteSetup(() => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    assert.ok(workspaceFolder, "Test workspace was not opened");
    workspaceRoot = workspaceFolder.uri.fsPath;
  });

  suiteTeardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test("Copies a single text file from disk", async () => {
    const filePath = path.join(await createTempWorkspace(), "test.md");

    await fs.writeFile(filePath, "# Hello\n\nSome text.");

    const clipboard = await executeCopy("promptable.copy", vscode.Uri.file(filePath));

    assert.ok(clipboard.includes("--- START OF FILE:"), "Missing START marker");
    assert.ok(clipboard.includes("# Hello"), "File content missing");
  });

  test("Replaces binary file content with placeholder", async () => {
    const filePath = path.join(await createTempWorkspace(), "image.png");

    await fs.writeFile(filePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const clipboard = await executeCopy("promptable.copy", vscode.Uri.file(filePath));

    assert.ok(clipboard.includes("[Binary file — content not included]"), "Binary placeholder missing");
  });

  test("Copies multiple selected files", async () => {
    const root = await createTempWorkspace();
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");

    await fs.writeFile(a, "File A");
    await fs.writeFile(b, "File B");

    const uris = [vscode.Uri.file(a), vscode.Uri.file(b)];
    const clipboard = await executeCopy("promptable.copy", uris[0], uris);

    assert.ok(clipboard.includes("File A"), "File A missing");
    assert.ok(clipboard.includes("File B"), "File B missing");
  });

  test("Recursively copies all files from a directory", async () => {
    const root = await createTempWorkspace();
    const dirA = path.join(root, "dirA");
    const dirB = path.join(dirA, "dirB");

    await fs.mkdir(dirB, { recursive: true });

    const file1 = path.join(root, "root.txt");
    const file2 = path.join(dirA, "a.txt");
    const file3 = path.join(dirB, "b.txt");

    await fs.writeFile(file1, "Root file");
    await fs.writeFile(file2, "Nested file A");
    await fs.writeFile(file3, "Nested file B");

    const clipboard = await executeCopy("promptable.copy", vscode.Uri.file(root));

    assert.ok(clipboard.includes("Root file"), "Root file missing");
    assert.ok(clipboard.includes("Nested file A"), "Nested file A missing");
    assert.ok(clipboard.includes("Nested file B"), "Nested file B missing");
  });

  test("Uses dynamic fences when file contains long backtick sequences", async () => {
    const filePath = path.join(await createTempWorkspace(), "README.md");
    const content = `Here is a fenced block:\n\n\`\`\`\`\ncode inside\n\`\`\`\`\n\nAnd even longer:\n\n\`\`\`\`\`\nnested code\n\`\`\`\`\`\n`;

    await fs.writeFile(filePath, content);

    const clipboard = await executeCopy("promptable.copy", vscode.Uri.file(filePath));

    assert.ok(clipboard.includes("``````"), "Dynamic fence with sufficient length was not used");
  });

  test("Standard command excludes a directly selected ignored file", async () => {
    const root = await createTempWorkspace();
    const ignoredFile = path.join(root, "ignored.txt");

    await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(ignoredFile, "DIRECT_IGNORED_CONTENT");

    const clipboard = await executeCopy("promptable.copy", vscode.Uri.file(ignoredFile));

    assert.strictEqual(clipboard, clipboardSentinel, "Ignored file changed the clipboard");
  });

  test("Ignore command copies a directly selected ignored file", async () => {
    const root = await createTempWorkspace();
    const ignoredFile = path.join(root, "ignored.txt");

    await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(ignoredFile, "DIRECT_IGNORED_CONTENT");

    const clipboard = await executeCopy("promptable.copyIgnoringGitignore", vscode.Uri.file(ignoredFile));

    assert.ok(clipboard.includes("DIRECT_IGNORED_CONTENT"), "Ignored file content missing");
  });

  test("Ignore command includes ignored files recursively", async () => {
    const root = await createTempWorkspace();
    const nestedDirectory = path.join(root, "nested");

    await fs.mkdir(nestedDirectory);
    await fs.writeFile(path.join(root, ".gitignore"), "nested/ignored.txt\n");
    await fs.writeFile(path.join(root, "visible.txt"), "RECURSIVE_VISIBLE_CONTENT");
    await fs.writeFile(path.join(nestedDirectory, "ignored.txt"), "RECURSIVE_IGNORED_CONTENT");

    const uri = vscode.Uri.file(root);
    const standardClipboard = await executeCopy("promptable.copy", uri);
    const ignoreClipboard = await executeCopy("promptable.copyIgnoringGitignore", uri);

    assert.ok(standardClipboard.includes("RECURSIVE_VISIBLE_CONTENT"), "Visible file missing from standard command");
    assert.ok(!standardClipboard.includes("RECURSIVE_IGNORED_CONTENT"), "Standard command copied ignored nested file");
    assert.ok(ignoreClipboard.includes("RECURSIVE_IGNORED_CONTENT"), "Ignore command missed ignored nested file");
  });

  test("Nested .gitignore rules are only applied by the standard command", async () => {
    const root = await createTempWorkspace();
    const nestedDirectory = path.join(root, "nested");

    await fs.mkdir(nestedDirectory);
    await fs.writeFile(path.join(nestedDirectory, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(path.join(nestedDirectory, "ignored.txt"), "NESTED_GITIGNORE_CONTENT");
    await fs.writeFile(path.join(root, "visible.txt"), "NESTED_VISIBLE_CONTENT");

    const uri = vscode.Uri.file(root);
    const standardClipboard = await executeCopy("promptable.copy", uri);
    const ignoreClipboard = await executeCopy("promptable.copyIgnoringGitignore", uri);

    assert.ok(standardClipboard.includes("NESTED_VISIBLE_CONTENT"), "Visible file missing from standard command");
    assert.ok(!standardClipboard.includes("NESTED_GITIGNORE_CONTENT"), "Nested rule was not applied");
    assert.ok(ignoreClipboard.includes("NESTED_GITIGNORE_CONTENT"), "Ignore command applied nested rule");
  });

  test("Ignore command supports multi-select combinations of files and folders", async () => {
    const root = await createTempWorkspace();
    const folder = path.join(root, "folder");
    const ignoredFile = path.join(root, "ignored.txt");

    await fs.mkdir(folder);
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(ignoredFile, "MULTI_IGNORED_CONTENT");
    await fs.writeFile(path.join(folder, "nested.txt"), "MULTI_FOLDER_CONTENT");

    const uris = [vscode.Uri.file(ignoredFile), vscode.Uri.file(folder)];
    const clipboard = await executeCopy("promptable.copyIgnoringGitignore", uris[0], uris);

    assert.ok(clipboard.includes("MULTI_IGNORED_CONTENT"), "Selected ignored file missing");
    assert.ok(clipboard.includes("MULTI_FOLDER_CONTENT"), "Selected folder content missing");
  });

  test("Ignore command never copies .git directories", async () => {
    const root = await createTempWorkspace();
    const gitDirectory = path.join(root, ".git");

    await fs.mkdir(gitDirectory);
    await fs.writeFile(path.join(root, "visible.txt"), "GIT_VISIBLE_CONTENT");
    await fs.writeFile(path.join(gitDirectory, "config"), "GIT_SECRET_CONTENT");

    const folderClipboard = await executeCopy("promptable.copyIgnoringGitignore", vscode.Uri.file(root));
    const directClipboard = await executeCopy("promptable.copyIgnoringGitignore", vscode.Uri.file(gitDirectory));

    assert.ok(folderClipboard.includes("GIT_VISIBLE_CONTENT"), "Visible file missing");
    assert.ok(!folderClipboard.includes("GIT_SECRET_CONTENT"), ".git content was copied recursively");
    assert.strictEqual(directClipboard, clipboardSentinel, "Directly selected .git directory changed the clipboard");
  });

  test("Both commands produce identical output for non-ignored files", async () => {
    const root = await createTempWorkspace();
    const textContent = "PARITY_TEXT\n`````\ninside\n`````";

    await fs.writeFile(path.join(root, "content.md"), textContent);
    await fs.writeFile(path.join(root, "binary.bin"), new Uint8Array([0x41, 0x00, 0x42]));

    const uri = vscode.Uri.file(root);
    const standardClipboard = await executeCopy("promptable.copy", uri);
    const ignoreClipboard = await executeCopy("promptable.copyIgnoringGitignore", uri);

    assert.strictEqual(ignoreClipboard, standardClipboard, "Commands produced different output");
    assert.ok(ignoreClipboard.includes("--- START OF FILE:"), "START marker missing");
    assert.ok(ignoreClipboard.includes("--- END OF FILE:"), "END marker missing");
    assert.ok(ignoreClipboard.includes("[Binary file — content not included]"), "Binary placeholder missing");
    assert.ok(ignoreClipboard.includes("``````"), "Dynamic fence missing");
  });

  test("Changed-files command copies a modified file and excludes unchanged files", async () => {
    const root = await createTempWorkspace();
    const modified = path.join(root, "modified.txt");
    const unchanged = path.join(root, "unchanged.txt");

    await fs.writeFile(modified, "GIT_MODIFIED_CONTENT");
    await fs.writeFile(unchanged, "GIT_UNCHANGED_CONTENT");

    const repository = gitRepository(root, {
      workingTreeChanges: [gitChange(modified, GitStatus.MODIFIED)]
    });
    const { clipboard, result } = await executeChangedCopy(gitExtension([repository]));

    assert.strictEqual(result, "copied");
    assert.ok(clipboard.includes("GIT_MODIFIED_CONTENT"), "Modified file missing");
    assert.ok(!clipboard.includes("GIT_UNCHANGED_CONTENT"), "Unchanged file was copied");
  });

  test("Changed-files command copies a staged file", async () => {
    const root = await createTempWorkspace();
    const staged = path.join(root, "staged.txt");

    await fs.writeFile(staged, "GIT_STAGED_CONTENT");

    const repository = gitRepository(root, {
      indexChanges: [gitChange(staged, GitStatus.INDEX_MODIFIED)]
    });
    const { clipboard } = await executeChangedCopy(gitExtension([repository]));

    assert.ok(clipboard.includes("GIT_STAGED_CONTENT"), "Staged file missing");
  });

  test("Changed-files command copies an untracked file without applying .gitignore", async () => {
    const root = await createTempWorkspace();
    const untracked = path.join(root, "untracked.txt");

    await fs.writeFile(path.join(root, ".gitignore"), "untracked.txt\n");
    await fs.writeFile(untracked, "GIT_UNTRACKED_CONTENT");

    const repository = gitRepository(root, {
      untrackedChanges: [gitChange(untracked, GitStatus.UNTRACKED)]
    });
    const { clipboard } = await executeChangedCopy(gitExtension([repository]));

    assert.ok(clipboard.includes("GIT_UNTRACKED_CONTENT"), "Untracked ignored file missing");
  });

  test("Changed-files command combines merge, index, and working-tree groups", async () => {
    const root = await createTempWorkspace();
    const merge = path.join(root, "merge.txt");
    const staged = path.join(root, "index.txt");
    const working = path.join(root, "working.txt");

    await fs.writeFile(merge, "GIT_MERGE_CONTENT");
    await fs.writeFile(staged, "GIT_INDEX_CONTENT");
    await fs.writeFile(working, "GIT_WORKING_CONTENT");

    const repository = gitRepository(root, {
      mergeChanges: [gitChange(merge, GitStatus.BOTH_MODIFIED)],
      indexChanges: [gitChange(staged, GitStatus.INDEX_ADDED)],
      workingTreeChanges: [gitChange(working, GitStatus.MODIFIED)]
    });
    const { clipboard } = await executeChangedCopy(gitExtension([repository]));

    assert.ok(clipboard.includes("GIT_MERGE_CONTENT"), "Merge change missing");
    assert.ok(clipboard.includes("GIT_INDEX_CONTENT"), "Index change missing");
    assert.ok(clipboard.includes("GIT_WORKING_CONTENT"), "Working-tree change missing");
  });

  test("Changed-files command deduplicates files across Git change groups", async () => {
    const root = await createTempWorkspace();
    const duplicate = path.join(root, "duplicate.txt");

    await fs.writeFile(duplicate, "GIT_DUPLICATE_CONTENT");

    const repository = gitRepository(root, {
      indexChanges: [gitChange(duplicate, GitStatus.INDEX_MODIFIED)],
      workingTreeChanges: [gitChange(duplicate, GitStatus.MODIFIED)]
    });
    const { clipboard } = await executeChangedCopy(gitExtension([repository]));
    const occurrences = clipboard.split("GIT_DUPLICATE_CONTENT").length - 1;

    assert.strictEqual(occurrences, 1, "Duplicate file was copied more than once");
  });

  test("Changed-files command uses a placeholder for deleted files", async () => {
    const root = await createTempWorkspace();
    const deleted = path.join(root, "deleted.txt");
    const repository = gitRepository(root, {
      workingTreeChanges: [gitChange(deleted, GitStatus.DELETED)]
    });
    const { clipboard, result } = await executeChangedCopy(gitExtension([repository]));

    assert.strictEqual(result, "copied");
    assert.ok(clipboard.includes("deleted.txt"), "Deleted file marker missing");
    assert.ok(clipboard.includes("[Deleted file — content not available]"), "Deleted placeholder missing");
  });

  test("Changed-files command reads a recreated file that also has a deleted status", async () => {
    const root = await createTempWorkspace();
    const recreated = path.join(root, "recreated.txt");

    await fs.writeFile(recreated, "GIT_RECREATED_CONTENT");

    const repository = gitRepository(root, {
      indexChanges: [gitChange(recreated, GitStatus.INDEX_DELETED)],
      untrackedChanges: [gitChange(recreated, GitStatus.UNTRACKED)]
    });
    const { clipboard } = await executeChangedCopy(gitExtension([repository]));

    assert.ok(clipboard.includes("GIT_RECREATED_CONTENT"), "Recreated file content missing");
    assert.ok(!clipboard.includes("[Deleted file — content not available]"), "Recreated file used deleted placeholder");
  });

  test("Changed-files command leaves the clipboard unchanged when there are no changes", async () => {
    const root = await createTempWorkspace();
    const { clipboard, result } = await executeChangedCopy(gitExtension([gitRepository(root)]));

    assert.strictEqual(result, "noChanges");
    assert.strictEqual(clipboard, clipboardSentinel);
  });

  test("Changed-files command handles unavailable Git and missing repositories", async () => {
    const missing = await executeChangedCopy(undefined);
    const disabled = await executeChangedCopy(gitExtension([], false));
    const noRepositories = await executeChangedCopy(gitExtension([]));

    await resetClipboard();
    const activationFailure = await copyChangedFiles(async () => {
      throw new Error("activation failed");
    });

    assert.strictEqual(missing.result, "gitUnavailable");
    assert.strictEqual(disabled.result, "gitUnavailable");
    assert.strictEqual(noRepositories.result, "noRepositories");
    assert.strictEqual(activationFailure, "gitUnavailable");
    assert.strictEqual(await vscode.env.clipboard.readText(), clipboardSentinel);
  });

  test("Changed-files command combines changes from multiple repositories", async () => {
    const root = await createTempWorkspace();
    const repositoryAPath = path.join(root, "repo-a");
    const repositoryBPath = path.join(root, "repo-b");
    const fileA = path.join(repositoryAPath, "a.txt");
    const fileB = path.join(repositoryBPath, "b.txt");

    await fs.mkdir(repositoryAPath);
    await fs.mkdir(repositoryBPath);
    await fs.writeFile(fileA, "GIT_REPOSITORY_A_CONTENT");
    await fs.writeFile(fileB, "GIT_REPOSITORY_B_CONTENT");

    const repositoryA = gitRepository(repositoryAPath, {
      workingTreeChanges: [gitChange(fileA, GitStatus.MODIFIED)]
    });
    const repositoryB = gitRepository(repositoryBPath, {
      indexChanges: [gitChange(fileB, GitStatus.INDEX_ADDED)]
    });
    const { clipboard } = await executeChangedCopy(gitExtension([repositoryA, repositoryB]));

    assert.ok(clipboard.includes("GIT_REPOSITORY_A_CONTENT"), "First repository change missing");
    assert.ok(clipboard.includes("GIT_REPOSITORY_B_CONTENT"), "Second repository change missing");
    assert.ok(clipboard.includes(path.relative(workspaceRoot, fileA)), "First workspace-relative path missing");
    assert.ok(clipboard.includes(path.relative(workspaceRoot, fileB)), "Second workspace-relative path missing");
  });

  suite(".promptableignore", () => {
    const copyCommands = ["promptable.copy", "promptable.copyIgnoringGitignore"];

    test("Excludes package-lock.json in all three commands and still copies other files", async () => {
      const root = await createTempWorkspace();
      const lock = path.join(root, "package-lock.json");
      const keep = path.join(root, "keep.txt");

      await fs.writeFile(lock, "PI_LOCK_CONTENT");
      await fs.writeFile(keep, "PI_KEEP_CONTENT");

      await withRootFiles({ ".promptableignore": "package-lock.json\n" }, async () => {
        for (const command of copyCommands) {
          const clipboard = await executeCopy(command, vscode.Uri.file(root));

          assert.ok(clipboard.includes("PI_KEEP_CONTENT"), `${command}: other file missing`);
          assert.ok(!clipboard.includes("PI_LOCK_CONTENT"), `${command}: package-lock.json was copied`);
        }

        const repository = gitRepository(workspaceRoot, {
          workingTreeChanges: [gitChange(lock, GitStatus.MODIFIED), gitChange(keep, GitStatus.MODIFIED)]
        });
        const { clipboard, result } = await executeChangedCopy(gitExtension([repository]));

        assert.strictEqual(result, "copied");
        assert.ok(clipboard.includes("PI_KEEP_CONTENT"), "changed: other file missing");
        assert.ok(!clipboard.includes("PI_LOCK_CONTENT"), "changed: package-lock.json was copied");
      });
    });

    test("Stays effective when .promptableignore itself is listed in .gitignore", async () => {
      const root = await createTempWorkspace();
      const lock = path.join(root, "package-lock.json");
      const keep = path.join(root, "keep.txt");

      await fs.writeFile(lock, "PI_GITIGNORED_RULES_LOCK");
      await fs.writeFile(keep, "PI_GITIGNORED_RULES_KEEP");

      await withRootFiles({ ".gitignore": ".promptableignore\n", ".promptableignore": "package-lock.json\n" }, async () => {
        for (const command of copyCommands) {
          const clipboard = await executeCopy(command, vscode.Uri.file(root));

          assert.ok(clipboard.includes("PI_GITIGNORED_RULES_KEEP"), `${command}: other file missing`);
          assert.ok(!clipboard.includes("PI_GITIGNORED_RULES_LOCK"), `${command}: rules were not applied`);
        }

        const repository = gitRepository(workspaceRoot, {
          workingTreeChanges: [gitChange(lock, GitStatus.MODIFIED), gitChange(keep, GitStatus.MODIFIED)]
        });
        const { clipboard } = await executeChangedCopy(gitExtension([repository]));

        assert.ok(clipboard.includes("PI_GITIGNORED_RULES_KEEP"), "changed: other file missing");
        assert.ok(!clipboard.includes("PI_GITIGNORED_RULES_LOCK"), "changed: rules were not applied");
      });
    });

    test("Never copies .promptableignore itself", async () => {
      const root = await createTempWorkspace();
      const visible = path.join(root, "visible.txt");
      const ruleFile = path.join(workspaceRoot, ".promptableignore");

      await fs.writeFile(visible, "PI_SELF_VISIBLE");

      await withRootFiles({ ".promptableignore": "# PI_SELF_RULES_MARKER\nunrelated.txt\n" }, async () => {
        for (const command of copyCommands) {
          const direct = await executeCopy(command, vscode.Uri.file(ruleFile));
          const recursive = await executeCopy(command, vscode.Uri.file(workspaceRoot));
          const multi = await executeCopy(command, vscode.Uri.file(ruleFile), [vscode.Uri.file(ruleFile), vscode.Uri.file(visible)]);

          assert.strictEqual(direct, clipboardSentinel, `${command}: direct selection changed the clipboard`);
          assert.ok(!recursive.includes("PI_SELF_RULES_MARKER"), `${command}: copied recursively`);
          assert.ok(recursive.includes("PI_SELF_VISIBLE"), `${command}: visible file missing recursively`);
          assert.ok(!multi.includes("PI_SELF_RULES_MARKER"), `${command}: copied via multi-selection`);
          assert.ok(multi.includes("PI_SELF_VISIBLE"), `${command}: visible file missing in multi-selection`);
        }

        const repository = gitRepository(workspaceRoot, {
          workingTreeChanges: [gitChange(ruleFile, GitStatus.MODIFIED), gitChange(visible, GitStatus.MODIFIED)],
          untrackedChanges: [gitChange(ruleFile, GitStatus.UNTRACKED)]
        });
        const { clipboard } = await executeChangedCopy(gitExtension([repository]));

        assert.ok(!clipboard.includes("PI_SELF_RULES_MARKER"), "changed: rule file was copied");
        assert.ok(clipboard.includes("PI_SELF_VISIBLE"), "changed: visible file missing");
      });
    });

    test("Respects rules for direct selection, recursive folders, and multi-selection", async () => {
      const root = await createTempWorkspace();
      const ignored = path.join(root, "ignored.txt");
      const kept = path.join(root, "kept.txt");
      const folder = path.join(root, "folder");

      await fs.mkdir(folder);
      await fs.writeFile(ignored, "PI_SEL_IGNORED");
      await fs.writeFile(kept, "PI_SEL_KEPT");
      await fs.writeFile(path.join(folder, "ignored.txt"), "PI_SEL_NESTED_IGNORED");
      await fs.writeFile(path.join(folder, "nested.txt"), "PI_SEL_NESTED_KEPT");

      await withRootFiles({ ".promptableignore": "ignored.txt\n" }, async () => {
        for (const command of copyCommands) {
          const direct = await executeCopy(command, vscode.Uri.file(ignored));
          const recursive = await executeCopy(command, vscode.Uri.file(root));
          const multi = await executeCopy(command, vscode.Uri.file(ignored), [vscode.Uri.file(ignored), vscode.Uri.file(kept), vscode.Uri.file(folder)]);

          assert.strictEqual(direct, clipboardSentinel, `${command}: direct selection was copied`);

          for (const clipboard of [recursive, multi]) {
            assert.ok(clipboard.includes("PI_SEL_KEPT"), `${command}: kept file missing`);
            assert.ok(clipboard.includes("PI_SEL_NESTED_KEPT"), `${command}: nested kept file missing`);
            assert.ok(!clipboard.includes("PI_SEL_IGNORED"), `${command}: ignored file was copied`);
            assert.ok(!clipboard.includes("PI_SEL_NESTED_IGNORED"), `${command}: nested ignored file was copied`);
          }
        }
      });
    });

    test("Supports wildcards, directory patterns, comments, and negations", async () => {
      const root = await createTempWorkspace();
      const dist = path.join(root, "dist", "deep");

      await fs.mkdir(dist, { recursive: true });
      await fs.writeFile(path.join(root, "debug.log"), "PI_PAT_LOG");
      await fs.writeFile(path.join(root, "keep.log"), "PI_PAT_KEEP_LOG");
      await fs.writeFile(path.join(root, ".env"), "PI_PAT_ENV");
      await fs.writeFile(path.join(dist, "bundle.js"), "PI_PAT_DIST_BUNDLE");
      await fs.writeFile(path.join(root, "dist.txt"), "PI_PAT_DIST_NAMED_FILE");
      await fs.writeFile(path.join(root, "main.ts"), "PI_PAT_MAIN");

      await withRootFiles({ ".promptableignore": "# comment PI_PAT_COMMENT\n*.log\n!keep.log\n.env\ndist/\n" }, async () => {
        for (const command of copyCommands) {
          const clipboard = await executeCopy(command, vscode.Uri.file(root));

          assert.ok(clipboard.includes("PI_PAT_MAIN"), `${command}: main.ts missing`);
          assert.ok(clipboard.includes("PI_PAT_KEEP_LOG"), `${command}: negated file missing`);
          assert.ok(clipboard.includes("PI_PAT_DIST_NAMED_FILE"), `${command}: file named like the ignored directory missing`);
          assert.ok(!clipboard.includes("PI_PAT_LOG"), `${command}: wildcard file was copied`);
          assert.ok(!clipboard.includes("PI_PAT_ENV"), `${command}: .env was copied`);
          assert.ok(!clipboard.includes("PI_PAT_DIST_BUNDLE"), `${command}: directory pattern was not applied`);
          assert.ok(!clipboard.includes("PI_PAT_COMMENT"), `${command}: comment was treated as content`);
        }
      });
    });

    test("Keeps the previous behavior without a .promptableignore", async () => {
      const root = await createTempWorkspace();
      const lock = path.join(root, "package-lock.json");

      await fs.writeFile(lock, "PI_NONE_LOCK");
      await fs.writeFile(path.join(root, "keep.txt"), "PI_NONE_KEEP");

      for (const command of copyCommands) {
        const clipboard = await executeCopy(command, vscode.Uri.file(root));

        assert.ok(clipboard.includes("PI_NONE_LOCK"), `${command}: package-lock.json missing`);
        assert.ok(clipboard.includes("PI_NONE_KEEP"), `${command}: other file missing`);
      }

      const repository = gitRepository(workspaceRoot, {
        workingTreeChanges: [gitChange(lock, GitStatus.MODIFIED)]
      });
      const { clipboard } = await executeChangedCopy(gitExtension([repository]));

      assert.ok(clipboard.includes("PI_NONE_LOCK"), "changed: package-lock.json missing");
    });

    test("Leaves the clipboard unchanged when every file is excluded", async () => {
      const root = await createTempWorkspace();
      const lock = path.join(root, "package-lock.json");

      await fs.writeFile(lock, "PI_ALL_EXCLUDED");

      await withRootFiles({ ".promptableignore": "package-lock.json\n" }, async () => {
        for (const command of copyCommands) {
          const clipboard = await executeCopy(command, vscode.Uri.file(lock));

          assert.strictEqual(clipboard, clipboardSentinel, `${command}: clipboard changed`);
        }

        const repository = gitRepository(workspaceRoot, {
          workingTreeChanges: [gitChange(lock, GitStatus.MODIFIED), gitChange(path.join(root, "package-lock.json"), GitStatus.DELETED), gitChange(path.join(workspaceRoot, ".promptableignore"), GitStatus.MODIFIED)]
        });
        const { clipboard, result } = await executeChangedCopy(gitExtension([repository]));

        assert.strictEqual(result, "noChanges");
        assert.strictEqual(clipboard, clipboardSentinel);
      });
    });

    test("Excludes deleted and already versioned files from the changed-files list", async () => {
      const root = await createTempWorkspace();
      const deletedLock = path.join(root, "package-lock.json");
      const deletedOther = path.join(root, "removed.txt");
      const staged = path.join(root, "staged.log");

      await fs.writeFile(staged, "PI_VERSIONED_STAGED_LOG");

      await withRootFiles({ ".promptableignore": "package-lock.json\n*.log\n" }, async () => {
        const repository = gitRepository(workspaceRoot, {
          indexChanges: [gitChange(staged, GitStatus.INDEX_MODIFIED)],
          workingTreeChanges: [gitChange(deletedLock, GitStatus.DELETED), gitChange(deletedOther, GitStatus.DELETED)]
        });
        const { clipboard, result } = await executeChangedCopy(gitExtension([repository]));

        assert.strictEqual(result, "copied");
        assert.ok(clipboard.includes("removed.txt"), "Non-excluded deleted file missing");
        assert.ok(!clipboard.includes("package-lock.json"), "Excluded deleted file was listed");
        assert.ok(!clipboard.includes("PI_VERSIONED_STAGED_LOG"), "Excluded staged file was copied");
      });
    });

    test("Applies each root's own rules and falls back to the repository root outside the workspace", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "promptable-outside-"));

      try {
        const repoA = path.join(outside, "repo-a");
        const repoB = path.join(outside, "repo-b");
        const files = [path.join(repoA, "a-secret.txt"), path.join(repoA, "shared.txt"), path.join(repoB, "b-secret.txt"), path.join(repoB, "shared.txt")];

        await fs.mkdir(repoA);
        await fs.mkdir(repoB);
        await fs.writeFile(path.join(repoA, ".promptableignore"), "a-secret.txt\n");
        await fs.writeFile(path.join(repoB, ".promptableignore"), "b-secret.txt\nshared.txt\n");

        for (const file of files) {
          await fs.writeFile(file, `PI_ROOTS_${path.basename(path.dirname(file))}_${path.basename(file)}`);
        }

        const repositories = [
          gitRepository(repoA, { workingTreeChanges: [gitChange(files[0], GitStatus.MODIFIED), gitChange(files[1], GitStatus.MODIFIED), gitChange(path.join(repoA, "b-secret.txt"), GitStatus.DELETED)] }),
          gitRepository(repoB, { workingTreeChanges: [gitChange(files[2], GitStatus.MODIFIED), gitChange(files[3], GitStatus.MODIFIED)] })
        ];
        const { clipboard } = await executeChangedCopy(gitExtension(repositories));

        assert.ok(!clipboard.includes("PI_ROOTS_repo-a_a-secret.txt"), "repo-a rule was not applied");
        assert.ok(clipboard.includes("PI_ROOTS_repo-a_shared.txt"), "repo-b rule leaked into repo-a");
        assert.ok(!clipboard.includes("PI_ROOTS_repo-b_b-secret.txt"), "repo-b rule was not applied");
        assert.ok(!clipboard.includes("PI_ROOTS_repo-b_shared.txt"), "repo-b shared.txt rule was not applied");
        assert.ok(clipboard.includes("b-secret.txt"), "repo-a deleted b-secret.txt should not be filtered by repo-b rules");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    test("Keeps .promptableignore and .gitignore independent of each other", async () => {
      const root = await createTempWorkspace();

      await fs.writeFile(path.join(root, "git-only.txt"), "PI_IND_GIT_ONLY");
      await fs.writeFile(path.join(root, "both.txt"), "PI_IND_BOTH");
      await fs.writeFile(path.join(root, "pi-only.txt"), "PI_IND_PI_ONLY");
      await fs.writeFile(path.join(root, "open.txt"), "PI_IND_OPEN");

      await withRootFiles({ ".gitignore": "git-only.txt\nboth.txt\n!pi-only.txt\n", ".promptableignore": "pi-only.txt\nboth.txt\n!git-only.txt\n" }, async () => {
        const standard = await executeCopy("promptable.copy", vscode.Uri.file(root));
        const ignoringGit = await executeCopy("promptable.copyIgnoringGitignore", vscode.Uri.file(root));

        assert.ok(standard.includes("PI_IND_OPEN"), "standard: open file missing");
        assert.ok(!standard.includes("PI_IND_GIT_ONLY"), "standard: negation in .promptableignore re-included a .gitignore file");
        assert.ok(!standard.includes("PI_IND_BOTH"), "standard: file excluded by both was copied");
        assert.ok(!standard.includes("PI_IND_PI_ONLY"), "standard: negation in .gitignore re-included a .promptableignore file");
        assert.ok(ignoringGit.includes("PI_IND_GIT_ONLY"), "ignore command: .gitignore file missing");
        assert.ok(!ignoringGit.includes("PI_IND_BOTH"), "ignore command: .promptableignore file was copied");
        assert.ok(!ignoringGit.includes("PI_IND_PI_ONLY"), "ignore command: .promptableignore file was copied");
      });
    });

    test("Aborts with an error and leaves the clipboard unchanged when .promptableignore is unreadable", async () => {
      const root = await createTempWorkspace();
      const keep = path.join(root, "keep.txt");

      await fs.writeFile(keep, "PI_UNREADABLE_KEEP");
      await fs.mkdir(path.join(workspaceRoot, ".promptableignore"));

      try {
        for (const command of copyCommands) {
          const clipboard = await executeCopy(command, vscode.Uri.file(keep));

          assert.strictEqual(clipboard, clipboardSentinel, `${command}: clipboard changed`);
        }

        const repository = gitRepository(workspaceRoot, {
          workingTreeChanges: [gitChange(keep, GitStatus.MODIFIED)]
        });
        const { clipboard, result } = await executeChangedCopy(gitExtension([repository]));

        assert.strictEqual(result, "error");
        assert.strictEqual(clipboard, clipboardSentinel);
      } finally {
        await fs.rm(path.join(workspaceRoot, ".promptableignore"), { recursive: true, force: true });
      }
    });
  });

  test("Keeps the single-root output path format unchanged", async () => {
    const filePath = path.join(await createTempWorkspace(), "format.txt");

    await fs.writeFile(filePath, "FORMAT_CONTENT");

    const clipboard = await executeCopy("promptable.copy", vscode.Uri.file(filePath));

    assert.ok(clipboard.startsWith(`--- START OF FILE: ${path.relative(workspaceRoot, filePath)} ---`), "Single-root path format changed");
  });

  suite(".promptableignore outside the workspace", () => {
    let outside: string;

    setup(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), "promptable-outside-"));
    });

    teardown(async () => {
      await fs.rm(outside, { recursive: true, force: true });
    });

    test("Never copies an externally selected .promptableignore", async () => {
      const ruleFile = path.join(outside, ".promptableignore");
      const other = path.join(outside, "other.txt");

      await fs.writeFile(ruleFile, "# EXT_RULES_MARKER\nsecret.txt\n");
      await fs.writeFile(other, "EXT_OTHER");

      for (const respectGitignore of [true, false]) {
        const withoutRepository = await executeTargetsCopy([vscode.Uri.file(ruleFile)], respectGitignore);
        const folder = await executeTargetsCopy([vscode.Uri.file(outside)], respectGitignore);
        const multi = await executeTargetsCopy([vscode.Uri.file(ruleFile), vscode.Uri.file(other)], respectGitignore);

        assert.strictEqual(withoutRepository, clipboardSentinel, "Direct selection changed the clipboard");
        assert.ok(!folder.includes("EXT_RULES_MARKER"), "Rule file was copied recursively");
        assert.ok(!multi.includes("EXT_RULES_MARKER"), "Rule file was copied via multi-selection");
        assert.ok(folder.includes("EXT_OTHER") && multi.includes("EXT_OTHER"), "Other file missing");
      }

      for (const command of ["promptable.copy", "promptable.copyIgnoringGitignore"]) {
        const clipboard = await executeCopy(command, vscode.Uri.file(ruleFile));

        assert.strictEqual(clipboard, clipboardSentinel, `${command}: external rule file was copied`);
      }
    });

    test("Applies the rules of a known external Git repository to both copy modes", async () => {
      const repoPath = path.join(outside, "repo");
      const nestedPath = path.join(repoPath, "nested");

      await fs.mkdir(nestedPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, ".promptableignore"), "package-lock.json\n*.log\nnested/ignored-here.txt\n");
      await fs.writeFile(path.join(repoPath, "package-lock.json"), "EXT_REPO_LOCK");
      await fs.writeFile(path.join(repoPath, "debug.log"), "EXT_REPO_LOG");
      await fs.writeFile(path.join(repoPath, "keep.txt"), "EXT_REPO_KEEP");
      await fs.writeFile(path.join(nestedPath, "ignored-here.txt"), "EXT_REPO_NESTED_IGNORED");
      await fs.writeFile(path.join(nestedPath, "nested.txt"), "EXT_REPO_NESTED_KEEP");

      const extension = gitExtension([gitRepository(repoPath)]);

      for (const respectGitignore of [true, false]) {
        const folder = await executeTargetsCopy([vscode.Uri.file(repoPath)], respectGitignore, extension);
        const direct = await executeTargetsCopy([vscode.Uri.file(path.join(repoPath, "package-lock.json"))], respectGitignore, extension);
        const multi = await executeTargetsCopy([vscode.Uri.file(path.join(repoPath, "debug.log")), vscode.Uri.file(path.join(repoPath, "keep.txt"))], respectGitignore, extension);

        assert.ok(folder.includes("EXT_REPO_KEEP") && folder.includes("EXT_REPO_NESTED_KEEP"), "Non-excluded files missing");
        assert.ok(!folder.includes("EXT_REPO_LOCK") && !folder.includes("EXT_REPO_LOG") && !folder.includes("EXT_REPO_NESTED_IGNORED"), "Repository rules were not applied recursively");
        assert.strictEqual(direct, clipboardSentinel, "Directly selected excluded file was copied");
        assert.ok(multi.includes("EXT_REPO_KEEP") && !multi.includes("EXT_REPO_LOG"), "Repository rules were not applied to a multi-selection");
      }
    });

    test("Uses the rules of the deepest matching repository", async () => {
      const outer = path.join(outside, "outer");
      const inner = path.join(outer, "inner");

      await fs.mkdir(inner, { recursive: true });
      await fs.writeFile(path.join(outer, ".promptableignore"), "shared.txt\n");
      await fs.writeFile(path.join(inner, ".promptableignore"), "other.txt\n");
      await fs.writeFile(path.join(inner, "shared.txt"), "EXT_DEEP_SHARED");
      await fs.writeFile(path.join(inner, "other.txt"), "EXT_DEEP_OTHER");

      const extension = gitExtension([gitRepository(outer), gitRepository(inner)]);
      const clipboard = await executeTargetsCopy([vscode.Uri.file(inner)], true, extension);

      assert.ok(clipboard.includes("EXT_DEEP_SHARED"), "Outer repository rules were applied to the inner repository");
      assert.ok(!clipboard.includes("EXT_DEEP_OTHER"), "Inner repository rules were not applied");
    });

    test("Keeps copying ordinary external files without a reliable project root", async () => {
      const file = path.join(outside, "plain.txt");

      await fs.writeFile(file, "EXT_PLAIN");
      await fs.writeFile(path.join(outside, "package-lock.json"), "EXT_PLAIN_LOCK");

      const noRepository = await executeTargetsCopy([vscode.Uri.file(outside)], true, gitExtension([]));
      const unrelatedRepository = await executeTargetsCopy([vscode.Uri.file(file)], true, gitExtension([gitRepository(path.join(outside, "elsewhere"))]));

      await resetClipboard();
      await copyTargets([vscode.Uri.file(file)], true, async () => {
        throw new Error("activation failed");
      });

      const failingGit = await vscode.env.clipboard.readText();

      assert.ok(noRepository.includes("EXT_PLAIN") && noRepository.includes("EXT_PLAIN_LOCK"), "Files without a project root were filtered");
      assert.ok(unrelatedRepository.includes("EXT_PLAIN"), "Unrelated repository changed the result");
      assert.ok(failingGit.includes("EXT_PLAIN"), "Unavailable Git prevented copying");
    });
  });

  suite("hierarchical ignore files", () => {
    // Lists the copied files relative to `directory`. Ignore files named .gitignore are dropped so that
    // expectations only describe the payload files.
    function copiedFiles(clipboard: string, directory: string): string[] {
      const prefix = `${path.relative(workspaceRoot, directory).split(path.sep).join("/")}/`;

      return [...clipboard.matchAll(/^--- START OF FILE: (.*) ---$/gm)]
        .map((match) => match[1].split(path.sep).join("/"))
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length))
        .filter((file) => path.posix.basename(file) !== ".gitignore")
        .sort();
    }

    async function writeTree(directory: string, files: Record<string, string>): Promise<void> {
      for (const [name, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
        await fs.writeFile(path.join(directory, name), content);
      }
    }

    async function copyWithAllCommands(directory: string, files: string[]): Promise<{ standard: string[]; ignoring: string[]; changed: string[] }> {
      const uri = vscode.Uri.file(directory);
      const standard = copiedFiles(await executeCopy("promptable.copy", uri), directory);
      const ignoring = copiedFiles(await executeCopy("promptable.copyIgnoringGitignore", uri), directory);
      const repository = gitRepository(workspaceRoot, {
        workingTreeChanges: files.map((file) => gitChange(path.join(directory, file), GitStatus.MODIFIED))
      });
      const changed = copiedFiles((await executeChangedCopy(gitExtension([repository]))).clipboard, directory);

      return { standard, ignoring, changed };
    }

    test("Local rules do not affect sibling directories", async () => {
      const root = await createTempWorkspace();
      const files = {
        "sub-project-1/.promptableignore": "foo\n",
        "sub-project-1/.gitignore": "",
        "sub-project-1/foo": "H_SIBLING_1",
        "sub-project-1/bar": "H_SIBLING_BAR",
        "sub-project-2/.promptableignore": "unrelated\n",
        "sub-project-2/foo": "H_SIBLING_2",
        "sub-project-3/.gitignore": "unrelated\n",
        "sub-project-3/foo": "H_SIBLING_3"
      };

      await writeTree(root, files);

      const expected = ["sub-project-1/bar", "sub-project-2/foo", "sub-project-3/foo"];
      const { standard, ignoring, changed } = await copyWithAllCommands(root, Object.keys(files));

      assert.deepStrictEqual(standard, expected);
      assert.deepStrictEqual(ignoring, expected);
      assert.deepStrictEqual(changed, expected);
    });

    test("Central rules apply in deeply nested directories", async () => {
      const root = await createTempWorkspace();
      const files = {
        "a/b/c/d/x.log": "H_CENTRAL_LOG",
        "a/b/c/d/y.tmp": "H_CENTRAL_TMP",
        "a/b/c/d/z.txt": "H_CENTRAL_TXT",
        "top.log": "H_CENTRAL_TOP_LOG"
      };

      await writeTree(root, files);

      await withRootFiles({ ".promptableignore": "*.log\n", ".gitignore": "*.tmp\n" }, async () => {
        const { standard, ignoring, changed } = await copyWithAllCommands(root, Object.keys(files));

        assert.deepStrictEqual(standard, ["a/b/c/d/z.txt"]);
        assert.deepStrictEqual(ignoring, ["a/b/c/d/y.tmp", "a/b/c/d/z.txt"]);
        assert.deepStrictEqual(changed, ["a/b/c/d/y.tmp", "a/b/c/d/z.txt"]);
      });
    });

    test("Local negations override parent rules of the same type within their scope", async () => {
      const root = await createTempWorkspace();
      const files = {
        "app/.promptableignore": "!important.log\n",
        "app/.gitignore": "!keep.tmp\n",
        "app/important.log": "H_NEG_APP_IMPORTANT",
        "app/other.log": "H_NEG_APP_OTHER",
        "app/deep/important.log": "H_NEG_APP_DEEP",
        "app/keep.tmp": "H_NEG_APP_KEEP",
        "app/x.tmp": "H_NEG_APP_X",
        "app/readme.txt": "H_NEG_APP_README",
        "lib/important.log": "H_NEG_LIB_IMPORTANT",
        "lib/keep.tmp": "H_NEG_LIB_KEEP",
        "lib/readme.txt": "H_NEG_LIB_README"
      };

      await writeTree(root, files);

      await withRootFiles({ ".promptableignore": "*.log\n", ".gitignore": "*.tmp\n" }, async () => {
        const { standard, ignoring, changed } = await copyWithAllCommands(root, Object.keys(files));
        const allButLogs = ["app/deep/important.log", "app/important.log", "app/keep.tmp", "app/readme.txt", "app/x.tmp", "lib/keep.tmp", "lib/readme.txt"];

        assert.deepStrictEqual(standard, ["app/deep/important.log", "app/important.log", "app/keep.tmp", "app/readme.txt", "lib/readme.txt"]);
        assert.deepStrictEqual(ignoring, allButLogs);
        assert.deepStrictEqual(changed, allButLogs);
      });
    });

    test("Negations cannot re-include files inside an excluded parent directory", async () => {
      const root = await createTempWorkspace();
      const files = {
        ".promptableignore": "dist/\n!dist/keep.txt\n",
        ".gitignore": "cache/\n!cache/keep.txt\n",
        "dist/.promptableignore": "!keep.txt\n!*\n",
        "dist/keep.txt": "H_PARENT_DIST_KEEP",
        "dist/other.txt": "H_PARENT_DIST_OTHER",
        "cache/.gitignore": "!keep.txt\n!*\n",
        "cache/keep.txt": "H_PARENT_CACHE_KEEP",
        "cache/other.txt": "H_PARENT_CACHE_OTHER",
        "src/a.txt": "H_PARENT_SRC"
      };

      await writeTree(root, files);

      const { standard, ignoring, changed } = await copyWithAllCommands(root, Object.keys(files));
      const withCache = ["cache/keep.txt", "cache/other.txt", "src/a.txt"];

      assert.deepStrictEqual(standard, ["src/a.txt"]);
      assert.deepStrictEqual(ignoring, withCache);
      assert.deepStrictEqual(changed, withCache);
    });

    test("Distinguishes anchored and unanchored patterns relative to their ignore file", async () => {
      const root = await createTempWorkspace();
      const files = {
        "sub/.promptableignore": "/only.txt\nname.txt\ndocs/*.md\n**/gen/out.js\n",
        "sub/only.txt": "H_ANCHOR_ONLY",
        "sub/deep/only.txt": "H_ANCHOR_DEEP_ONLY",
        "sub/name.txt": "H_ANCHOR_NAME",
        "sub/deep/name.txt": "H_ANCHOR_DEEP_NAME",
        "sub/docs/a.md": "H_ANCHOR_DOC",
        "sub/docs/x/a.md": "H_ANCHOR_DOC_NESTED",
        "sub/x/docs/a.md": "H_ANCHOR_OTHER_DOC",
        "sub/gen/out.js": "H_ANCHOR_GEN",
        "sub/a/gen/out.js": "H_ANCHOR_GEN_NESTED",
        "other/only.txt": "H_ANCHOR_SIBLING_ONLY",
        "other/name.txt": "H_ANCHOR_SIBLING_NAME"
      };

      await writeTree(root, files);

      const { standard, ignoring, changed } = await copyWithAllCommands(root, Object.keys(files));
      const expected = ["other/name.txt", "other/only.txt", "sub/deep/only.txt", "sub/docs/x/a.md", "sub/x/docs/a.md"];

      assert.deepStrictEqual(standard, expected);
      assert.deepStrictEqual(ignoring, expected);
      assert.deepStrictEqual(changed, expected);
    });

    test("Nested .gitignore and .promptableignore files work independently of each other", async () => {
      const root = await createTempWorkspace();
      const files = {
        ".promptableignore": "x.txt\n",
        ".gitignore": "y.txt\n",
        "sub/.gitignore": "!x.txt\n",
        "sub/.promptableignore": "!y.txt\n",
        "sub/x.txt": "H_INDEP_X",
        "sub/y.txt": "H_INDEP_Y",
        "z.txt": "H_INDEP_Z"
      };

      await writeTree(root, files);

      const { standard, ignoring, changed } = await copyWithAllCommands(root, Object.keys(files));

      assert.deepStrictEqual(standard, ["z.txt"]);
      assert.deepStrictEqual(ignoring, ["sub/y.txt", "z.txt"]);
      assert.deepStrictEqual(changed, ["sub/y.txt", "z.txt"]);
    });

    test("Nested .promptableignore files work even when listed in .gitignore", async () => {
      const root = await createTempWorkspace();
      const files = {
        ".gitignore": ".promptableignore\n",
        "sub/.promptableignore": "foo\n",
        "sub/foo": "H_NESTED_GITIGNORED_FOO",
        "sub/bar": "H_NESTED_GITIGNORED_BAR",
        "other/foo": "H_NESTED_GITIGNORED_OTHER"
      };

      await writeTree(root, files);

      const { standard, ignoring, changed } = await copyWithAllCommands(root, Object.keys(files));
      const expected = ["other/foo", "sub/bar"];

      assert.deepStrictEqual(standard, expected);
      assert.deepStrictEqual(ignoring, expected);
      assert.deepStrictEqual(changed, expected);
    });

    test("Applies nested rules to direct selection, multi-selection, and deleted files", async () => {
      const root = await createTempWorkspace();
      const first = path.join(root, "sub-project-1", "foo");
      const second = path.join(root, "sub-project-2", "foo");

      await writeTree(root, {
        "sub-project-1/.promptableignore": "foo\n",
        "sub-project-1/foo": "H_SEL_FIRST",
        "sub-project-2/foo": "H_SEL_SECOND"
      });

      for (const command of ["promptable.copy", "promptable.copyIgnoringGitignore"]) {
        const direct = await executeCopy(command, vscode.Uri.file(first));
        const multi = await executeCopy(command, vscode.Uri.file(first), [vscode.Uri.file(first), vscode.Uri.file(second)]);

        assert.strictEqual(direct, clipboardSentinel, `${command}: excluded direct selection was copied`);
        assert.ok(!multi.includes("H_SEL_FIRST") && multi.includes("H_SEL_SECOND"), `${command}: multi-selection ignored the nested rules`);
      }

      await fs.rm(path.join(root, "sub-project-2"), { recursive: true });

      const repository = gitRepository(workspaceRoot, {
        workingTreeChanges: [gitChange(first, GitStatus.DELETED), gitChange(second, GitStatus.DELETED)]
      });
      const { clipboard, result } = await executeChangedCopy(gitExtension([repository]));

      assert.strictEqual(result, "copied");
      assert.ok(clipboard.includes(path.join("sub-project-2", "foo")), "Deleted file in a missing directory was dropped");
      assert.ok(!clipboard.includes(path.join("sub-project-1", "foo")), "Deleted file excluded by a nested rule was listed");
    });

    test("Applies nested rules inside external Git repositories", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "promptable-outside-"));

      try {
        const repoPath = path.join(outside, "repo");

        await writeTree(repoPath, {
          ".promptableignore": "*.log\n",
          "pkg/.promptableignore": "!keep.log\n",
          "pkg/keep.log": "H_EXT_KEEP",
          "pkg/x.log": "H_EXT_X",
          "pkg/a.txt": "H_EXT_A",
          "other/keep.log": "H_EXT_OTHER_KEEP",
          "top.log": "H_EXT_TOP"
        });

        const extension = gitExtension([gitRepository(repoPath)]);

        for (const respectGitignore of [true, false]) {
          const clipboard = await executeTargetsCopy([vscode.Uri.file(repoPath)], respectGitignore, extension);

          assert.ok(clipboard.includes("H_EXT_KEEP") && clipboard.includes("H_EXT_A"), "Locally re-included files missing");
          assert.ok(!clipboard.includes("H_EXT_X") && !clipboard.includes("H_EXT_OTHER_KEEP") && !clipboard.includes("H_EXT_TOP"), "Hierarchical external rules were not applied");
        }
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    test("Matches the behavior of git for nested .gitignore files", async function () {
      const execFileAsync = promisify(execFile);

      try {
        await execFileAsync("git", ["--version"]);
      } catch {
        this.skip();
      }

      const root = await createTempWorkspace();
      const files: Record<string, string> = {
        ".gitignore": "*.log\n/rootonly.txt\nbuild/\n!keep.log\ndocs/**/*.tmp\n\\#hash.txt\n\\!bang.txt\nfoo\nescaped\\ space\n",
        "a.log": "",
        "keep.log": "",
        "rootonly.txt": "",
        "x/rootonly.txt": "",
        "build/o.txt": "",
        "x/build/o.txt": "",
        "build/keep.log": "",
        "docs/a.tmp": "",
        "docs/z/b.tmp": "",
        "x/docs/c.tmp": "",
        "#hash.txt": "",
        "!bang.txt": "",
        "foo": "",
        "x/foo/y": "",
        "sub1/.gitignore": "foo\n!/keep.log\n/only.txt\n*.dat\n!important.dat\nbar/\n!build/\nsp ace/\n/nested/*.x\n**/deep/z\n!*.log\n\\#h2\n",
        "sub1/foo": "",
        "sub1/y/foo": "",
        "sub1/y/.gitignore": "!foo\n",
        "sub1/y/foo2": "",
        "sub1/keep.log": "",
        "sub1/other.log": "",
        "sub1/only.txt": "",
        "sub1/z/only.txt": "",
        "sub1/q.dat": "",
        "sub1/important.dat": "",
        "sub1/bar/f": "",
        "sub1/z/bar/f": "",
        "sub1/build/o.txt": "",
        "sub1/sp ace/f": "",
        "sub1/nested/a.x": "",
        "sub1/nested/n/a.x": "",
        "sub1/m/deep/z": "",
        "sub1/deep/z": "",
        "sub1/#h2": "",
        "sub2/.gitignore": "!*.log\n*.dat\n",
        "sub2/foo": "",
        "sub2/a.log": "",
        "sub2/b.dat": "",
        "sub3/foo": "",
        "sub3/q.dat": "",
        "#odd/.gitignore": "z\n",
        "#odd/z": "",
        "#odd/k": "",
        "[br]/.gitignore": "z\n",
        "[br]/z": "",
        "[br]/k": "",
        "b/z": "",
        "r/z": "",
        "!ex/.gitignore": "z\n",
        "!ex/z": "",
        "dd/.gitignore": "*\n!.gitignore\n!/keep/\n!/keep/*\n",
        "dd/keep/f": "",
        "dd/other": "",
        "pp/.gitignore": "build/\n",
        "pp/build/.gitignore": "!x\n",
        "pp/build/x": "",
        "pp/build/y": "",
        "qq/.gitignore": "/out\n",
        "qq/out/f": "",
        "qq/sub/out/f": ""
      };

      await writeTree(root, files);
      await execFileAsync("git", ["init", "-q"], { cwd: root });

      const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-per-directory=.gitignore"], { cwd: root });
      const ignoredByGit = new Set(stdout.split("\0").filter(Boolean));
      const expected = Object.keys(files)
        .filter((file) => path.posix.basename(file) !== ".gitignore" && !ignoredByGit.has(file))
        .sort();
      const actual = copiedFiles(await executeCopy("promptable.copy", vscode.Uri.file(root)), root);

      assert.ok(ignoredByGit.size > 20, "Git reported unexpectedly few ignored files");
      assert.deepStrictEqual(actual, expected);
    });

    suite("case sensitivity", () => {
      const execFileAsync = promisify(execFile);
      const platformIgnoresCase = process.platform === "win32" || process.platform === "darwin";

      // The ignore patterns deliberately differ in case from the file names. Same-directory name collisions
      // are avoided because Windows and macOS file systems cannot hold such files side by side.
      const caseTree: Record<string, string> = {
        ".gitignore": "Foo.ts\nExact.ts\n*.log\n",
        ".promptableignore": "Baz.ts\nExact2.ts\n*.dat\n",
        "sub/.gitignore": "!Important.log\n!exact.log\n",
        "sub/.promptableignore": "!Important.dat\n!exact.dat\n",
        "foo.ts": "C_FOO",
        "Exact.ts": "C_EXACT",
        "baz.ts": "C_BAZ",
        "Exact2.ts": "C_EXACT2",
        "keep.ts": "C_KEEP",
        "sub/important.log": "C_IMPORTANT_LOG",
        "sub/exact.log": "C_EXACT_LOG",
        "sub/important.dat": "C_IMPORTANT_DAT",
        "sub/exact.dat": "C_EXACT_DAT"
      };
      const sensitive = {
        standard: ["baz.ts", "foo.ts", "keep.ts", "sub/exact.dat", "sub/exact.log"],
        promptableOnly: ["Exact.ts", "baz.ts", "foo.ts", "keep.ts", "sub/exact.dat", "sub/exact.log", "sub/important.log"]
      };
      const insensitive = {
        standard: ["keep.ts", "sub/exact.dat", "sub/exact.log", "sub/important.dat", "sub/important.log"],
        promptableOnly: ["Exact.ts", "foo.ts", "keep.ts", "sub/exact.dat", "sub/exact.log", "sub/important.dat", "sub/important.log"]
      };

      suiteSetup(async function () {
        try {
          await execFileAsync("git", ["--version"]);
        } catch {
          this.skip();
        }
      });

      // Makes the Git CLI results independent of the developer's global and system configuration.
      async function withIsolatedGitConfig(run: () => Promise<void>): Promise<void> {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptable-gitconfig-"));
        const previous = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };

        await fs.writeFile(path.join(directory, "config"), "");
        process.env.GIT_CONFIG_GLOBAL = path.join(directory, "config");
        process.env.GIT_CONFIG_NOSYSTEM = "1";

        try {
          await run();
        } finally {
          for (const [name, value] of [
            ["GIT_CONFIG_GLOBAL", previous.global],
            ["GIT_CONFIG_NOSYSTEM", previous.system]
          ] as const) {
            if (value === undefined) {
              delete process.env[name];
            } else {
              process.env[name] = value;
            }
          }

          await fs.rm(directory, { recursive: true, force: true });
        }
      }

      async function createRepository(directory: string, ignoreCase: boolean | undefined, tree: Record<string, string> = caseTree): Promise<void> {
        await fs.mkdir(directory, { recursive: true });
        await execFileAsync("git", ["init", "-q"], { cwd: directory });

        if (ignoreCase === undefined) {
          await execFileAsync("git", ["config", "--local", "--unset-all", "core.ignorecase"], { cwd: directory }).catch(() => undefined);
        } else {
          await execFileAsync("git", ["config", "--local", "core.ignorecase", String(ignoreCase)], { cwd: directory });
        }

        await writeTree(directory, tree);
      }

      async function copyWithAllCommandsInRepository(repositoryPath: string): Promise<{ standard: string[]; ignoring: string[]; changed: string[] }> {
        const extension = gitExtension([gitRepository(repositoryPath)]);
        const uri = vscode.Uri.file(repositoryPath);
        const standard = copiedFiles(await executeTargetsCopy([uri], true, extension), repositoryPath);
        const ignoring = copiedFiles(await executeTargetsCopy([uri], false, extension), repositoryPath);
        const repository = gitRepository(repositoryPath, {
          workingTreeChanges: Object.keys(caseTree).map((file) => gitChange(path.join(repositoryPath, file), GitStatus.MODIFIED))
        });
        const changed = copiedFiles((await executeChangedCopy(gitExtension([repository]))).clipboard, repositoryPath);

        return { standard, ignoring, changed };
      }

      for (const ignoreCase of [false, true, undefined]) {
        test(`Honors core.ignorecase=${ignoreCase ?? "unset"} for both ignore file types and all commands`, async () => {
          await withIsolatedGitConfig(async () => {
            const repositoryPath = path.join(await createTempWorkspace(), "repo");

            await createRepository(repositoryPath, ignoreCase);

            const expected = ignoreCase === true ? insensitive : sensitive;
            const { standard, ignoring, changed } = await copyWithAllCommandsInRepository(repositoryPath);

            assert.deepStrictEqual(standard, expected.standard, "standard command");
            assert.deepStrictEqual(ignoring, expected.promptableOnly, "ignore .gitignore command");
            assert.deepStrictEqual(changed, expected.promptableOnly, "changed-files command");
          });
        });
      }

      test("Uses the repository of each file when repositories differ in core.ignorecase", async () => {
        await withIsolatedGitConfig(async () => {
          const root = await createTempWorkspace();
          const tree = { ".gitignore": "Foo.ts\n", "foo.ts": "C_MIX_FOO", "keep.ts": "C_MIX_KEEP" };
          const insensitiveRepository = path.join(root, "insensitive");
          const sensitiveRepository = path.join(root, "sensitive");
          const outer = path.join(root, "outer");
          const inner = path.join(outer, "inner");

          await createRepository(insensitiveRepository, true, tree);
          await createRepository(sensitiveRepository, false, tree);
          await createRepository(outer, true, tree);
          await createRepository(inner, false, { ".gitignore": "Bar.ts\n", "foo.ts": "C_MIX_INNER_FOO", "bar.ts": "C_MIX_INNER_BAR" });

          const extension = gitExtension([insensitiveRepository, sensitiveRepository, outer, inner].map((repository) => gitRepository(repository)));
          const files = copiedFiles(await executeTargetsCopy([vscode.Uri.file(root)], true, extension), root);

          assert.deepStrictEqual(files, ["insensitive/keep.ts", "outer/inner/bar.ts", "outer/inner/foo.ts", "outer/keep.ts", "sensitive/foo.ts", "sensitive/keep.ts"]);
        });
      });

      for (const ignoreCase of [true, false]) {
        test(`Matches git check-ignore with core.ignorecase=${ignoreCase}`, async () => {
          await withIsolatedGitConfig(async () => {
            const tree = Object.fromEntries(Object.entries(caseTree).filter(([name]) => !name.endsWith(".promptableignore")));
            const repositoryPath = path.join(await createTempWorkspace(), "repo");

            await createRepository(repositoryPath, ignoreCase, tree);

            const files = Object.keys(tree).filter((name) => path.posix.basename(name) !== ".gitignore");
            const check = execFileAsync("git", ["check-ignore", "--no-index", "-z", "--stdin"], { cwd: repositoryPath });

            check.child.stdin?.end(`${files.join("\0")}\0`);

            // `git check-ignore` exits with 1 when nothing is ignored.
            const { stdout } = await check.catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
            const ignoredByGit = new Set(stdout.split("\0").filter(Boolean));
            const expected = files.filter((name) => !ignoredByGit.has(name)).sort();
            const actual = copiedFiles(await executeTargetsCopy([vscode.Uri.file(repositoryPath)], true, gitExtension([gitRepository(repositoryPath)])), repositoryPath);

            assert.ok(ignoredByGit.size > 0, "Git did not report any ignored file");
            assert.deepStrictEqual(actual, expected);
          });
        });
      }

      test("Falls back to the platform default outside Git repositories and without Git", async () => {
        const root = await createTempWorkspace();

        await writeTree(root, { ".promptableignore": "Foo.ts\n", "foo.ts": "C_FALLBACK_FOO", "keep.ts": "C_FALLBACK_KEEP" });

        const expected = platformIgnoresCase ? ["keep.ts"] : ["foo.ts", "keep.ts"];
        const noRepositories = copiedFiles(await executeTargetsCopy([vscode.Uri.file(root)], true, gitExtension([])), root);
        const withoutExtension = copiedFiles(await executeTargetsCopy([vscode.Uri.file(root)], true), root);

        await resetClipboard();
        await copyTargets([vscode.Uri.file(root)], true, async () => {
          throw new Error("activation failed");
        });

        const failingGit = copiedFiles(await vscode.env.clipboard.readText(), root);

        assert.deepStrictEqual(noRepositories, expected);
        assert.deepStrictEqual(withoutExtension, expected);
        assert.deepStrictEqual(failingGit, expected);
      });

      test("Falls back to the platform default when the git executable cannot be run", async () => {
        const root = path.join(await createTempWorkspace(), "repo");
        const previousPath = process.env.PATH;

        await writeTree(root, { ".promptableignore": "Foo.ts\n", "foo.ts": "C_NOGIT_FOO", "keep.ts": "C_NOGIT_KEEP" });

        process.env.PATH = "";

        try {
          const files = copiedFiles(await executeTargetsCopy([vscode.Uri.file(root)], true, gitExtension([gitRepository(root)])), root);

          assert.deepStrictEqual(files, platformIgnoresCase ? ["keep.ts"] : ["foo.ts", "keep.ts"]);
        } finally {
          process.env.PATH = previousPath;
        }
      });
    });
  });
});
