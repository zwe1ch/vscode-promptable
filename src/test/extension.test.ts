import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

const clipboardSentinel = "promptable-test-clipboard-sentinel";

let workspaceRoot: string;
let testDirectoryIndex = 0;

async function createTempWorkspace(): Promise<string> {
  const directory = path.join(workspaceRoot, `case-${testDirectoryIndex++}`);

  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function executeCopy(command: string, mainUri: vscode.Uri, allUris?: vscode.Uri[]): Promise<string> {
  await vscode.env.clipboard.writeText(clipboardSentinel);
  await vscode.commands.executeCommand(command, mainUri, allUris);
  return vscode.env.clipboard.readText();
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
});
