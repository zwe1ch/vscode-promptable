import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

const clipboardSentinel = "promptable-test-clipboard-sentinel";

async function executeCopy(command: string, mainUri: vscode.Uri, allUris?: vscode.Uri[]): Promise<string> {
  await vscode.env.clipboard.writeText(clipboardSentinel);
  assert.strictEqual(await vscode.env.clipboard.readText(), clipboardSentinel, "Could not reset the test clipboard");
  await vscode.commands.executeCommand(command, mainUri, allUris);
  return vscode.env.clipboard.readText();
}

suite("promptable Multi-Root Test Suite", () => {
  let folderA: string;
  let folderB: string;

  suiteSetup(async () => {
    const folders = vscode.workspace.workspaceFolders;

    assert.strictEqual(folders?.length, 2, "Multi-root test workspace was not opened");
    folderA = folders[0].uri.fsPath;
    folderB = folders[1].uri.fsPath;

    await fs.mkdir(path.join(folderA, "src"), { recursive: true });
    await fs.mkdir(path.join(folderB, "src"), { recursive: true });
    await fs.writeFile(path.join(folderA, "src", "index.ts"), "MULTI_A_INDEX");
    await fs.writeFile(path.join(folderB, "src", "index.ts"), "MULTI_B_INDEX");
    await fs.writeFile(path.join(folderA, "secret.txt"), "MULTI_A_SECRET");
    await fs.writeFile(path.join(folderB, "secret.txt"), "MULTI_B_SECRET");
    await fs.writeFile(path.join(folderA, ".promptableignore"), "secret.txt\n");
  });

  suiteTeardown(async () => {
    for (const folder of [folderA, folderB]) {
      await fs.rm(path.dirname(folder), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
    }
  });

  test("Nested rules stay inside their own workspace folder", async () => {
    await fs.mkdir(path.join(folderA, "lib"), { recursive: true });
    await fs.mkdir(path.join(folderB, "lib"), { recursive: true });
    await fs.writeFile(path.join(folderA, "lib", ".promptableignore"), "local.txt\n");
    await fs.writeFile(path.join(folderA, "lib", "local.txt"), "MULTI_A_LOCAL");
    await fs.writeFile(path.join(folderA, "lib", "shared.txt"), "MULTI_A_SHARED");
    await fs.writeFile(path.join(folderB, "lib", "local.txt"), "MULTI_B_LOCAL");

    const uris = [vscode.Uri.file(path.join(folderA, "lib")), vscode.Uri.file(path.join(folderB, "lib"))];
    const clipboard = await executeCopy("promptable.copy", uris[0], uris);

    assert.ok(!clipboard.includes("MULTI_A_LOCAL"), "Nested rule was not applied in folder A");
    assert.ok(clipboard.includes("MULTI_A_SHARED"), "Other file of folder A missing");
    assert.ok(clipboard.includes("MULTI_B_LOCAL"), "Nested rule of folder A leaked into folder B");
  });

  for (const command of ["promptable.copy", "promptable.copyIgnoringGitignore"]) {
    test(`${command} uses unique workspace-prefixed paths and per-root rules`, async () => {
      const uris = [vscode.Uri.file(folderB), vscode.Uri.file(folderA)];
      const clipboard = await executeCopy(command, uris[0], uris);
      const pathA = path.join(path.basename(folderA), "src", "index.ts");
      const pathB = path.join(path.basename(folderB), "src", "index.ts");

      assert.ok(clipboard.includes(`--- START OF FILE: ${pathA} ---`), "Folder A path is not workspace-prefixed");
      assert.ok(clipboard.includes(`--- START OF FILE: ${pathB} ---`), "Folder B path is not workspace-prefixed");
      assert.ok(clipboard.indexOf(pathA) < clipboard.indexOf(pathB), "Files are not sorted by prefixed path");
      assert.ok(clipboard.includes("MULTI_A_INDEX") && clipboard.includes("MULTI_B_INDEX"), "Same-named files were not both copied");
      assert.ok(!clipboard.includes("MULTI_A_SECRET"), "Folder A rules were not applied");
      assert.ok(clipboard.includes("MULTI_B_SECRET"), "Folder A rules leaked into folder B");
      assert.ok(!clipboard.includes("MULTI_A_SECRET") && !clipboard.includes(".promptableignore"), ".promptableignore was copied");
    });
  }
});
