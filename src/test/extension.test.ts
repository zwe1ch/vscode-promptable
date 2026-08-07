import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import { CopyChangedResult, copyChangedFiles } from "../extension";
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
    await fs.rm(workspaceRoot, { recursive: true, force: true });
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
});
