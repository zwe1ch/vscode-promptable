import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "promptable-test-"));
}

suite("promptable Integration Test Suite", () => {
  test("Copies a single text file from disk", async () => {
    const filePath = path.join(await createTempWorkspace(), "test.md");

    await fs.writeFile(filePath, "# Hello\n\nSome text.");

    const uri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand("promptable.copy", uri);

    await sleep(300);

    const clipboard = await vscode.env.clipboard.readText();

    assert.ok(clipboard.includes("--- START OF FILE:"), "Missing START marker");
    assert.ok(clipboard.includes("# Hello"), "File content missing");
  });

  test("Replaces binary file content with placeholder", async () => {
    const filePath = path.join(await createTempWorkspace(), "image.png");

    await fs.writeFile(filePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const uri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand("promptable.copy", uri);

    await sleep(300);

    const clipboard = await vscode.env.clipboard.readText();

    assert.ok(clipboard.includes("[Binary file — content not included]"), "Binary placeholder missing");
  });

  test("Copies multiple selected files", async () => {
    const root = await createTempWorkspace();

    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");

    await fs.writeFile(a, "File A");
    await fs.writeFile(b, "File B");

    const uris = [vscode.Uri.file(a), vscode.Uri.file(b)];

    await vscode.commands.executeCommand("promptable.copy", uris[0], uris);

    await sleep(300);

    const clipboard = await vscode.env.clipboard.readText();

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

    const uri = vscode.Uri.file(root);

    await vscode.commands.executeCommand("promptable.copy", uri);

    await sleep(300);

    const clipboard = await vscode.env.clipboard.readText();

    assert.ok(clipboard.includes("Root file"), "Root file missing");
    assert.ok(clipboard.includes("Nested file A"), "Nested file A missing");
    assert.ok(clipboard.includes("Nested file B"), "Nested file B missing");
  });

  test("Uses dynamic fences when file contains long backtick sequences", async () => {
    const filePath = path.join(await createTempWorkspace(), "README.md");

    const content = `Here is a fenced block:\n\n\`\`\`\`\ncode inside\n\`\`\`\`\n\nAnd even longer:\n\n\`\`\`\`\`\nnested code\n\`\`\`\`\`\n`;

    await fs.writeFile(filePath, content);

    const uri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand("promptable.copy", uri);

    await sleep(300);

    const clipboard = await vscode.env.clipboard.readText();

    assert.ok(clipboard.includes("``````"), "Dynamic fence with sufficient length was not used");
  });
});
