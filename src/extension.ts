import * as path from "path";
import * as vscode from "vscode";

import ignore, { Ignore } from "ignore";

function getSelectedUris(mainUri: vscode.Uri | undefined, allUris: vscode.Uri[] | undefined): vscode.Uri[] {
  if (Array.isArray(allUris) && allUris.length > 0) {
    return allUris;
  }

  if (mainUri instanceof vscode.Uri) {
    return [mainUri];
  }

  if (vscode.window.activeTextEditor) {
    return [vscode.window.activeTextEditor.document.uri];
  }
  return [];
}

function isBinary(buffer: Uint8Array): boolean {
  const checkLength = Math.min(buffer.length, 8000);

  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }

  return false;
}

function createFence(content: string): string {
  const matches = content.match(/`+/g);

  return "`".repeat(Math.max(3, (matches ? Math.max(...matches.map((m) => m.length)) : 0) + 1));
}

async function collectFiles(uri: vscode.Uri, type?: vscode.FileType): Promise<vscode.Uri[]> {
  const currentType = type ?? (await vscode.workspace.fs.stat(uri)).type;

  if (currentType === vscode.FileType.File) {
    return [uri];
  }

  if (currentType === vscode.FileType.Directory) {
    const entries = await vscode.workspace.fs.readDirectory(uri);

    let files: vscode.Uri[] = [];

    for (const [name, childType] of entries) {
      if (name === ".git") {
        continue;
      }

      files = files.concat(await collectFiles(vscode.Uri.joinPath(uri, name), childType));
    }
    return files;
  }
  return [];
}

async function getGitignore(workspaceRoot: vscode.Uri): Promise<Ignore | null> {
  try {
    const i = ignore();
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceRoot, "**/.gitignore"));

    for (const file of files) {
      const content = await vscode.workspace.fs.readFile(file);
      const relativeDir = path.dirname(path.relative(workspaceRoot.fsPath, file.fsPath));
      const rules = new TextDecoder().decode(content).split(/\r?\n/);

      const prefixedRules = rules.map((rule) => {
        if (!rule.trim() || rule.startsWith("#")) {
          return rule;
        }

        return relativeDir === "." ? rule : path.join(relativeDir, rule);
      });

      i.add(prefixedRules);
    }
    return i;
  } catch {
    return null;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("promptable.copy", async (mainUri?: vscode.Uri, allUris?: vscode.Uri[]) => {
    const targets = getSelectedUris(mainUri, allUris);

    if (targets.length === 0) {
      return;
    }

    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(targets[0]);
      const workspaceRoot = workspaceFolder?.uri;
      const gitignore = workspaceRoot ? await getGitignore(workspaceRoot) : null;

      const allFiles: vscode.Uri[] = [];

      for (const target of targets) {
        allFiles.push(...(await collectFiles(target)));
      }

      const uniqueFiles = Array.from(new Map(allFiles.map((u) => [u.fsPath, u])).values());
      const filteredFiles = uniqueFiles.filter((file) => {
        if (!gitignore || !workspaceRoot) {
          return true;
        }

        const relative = path.relative(workspaceRoot.fsPath, file.fsPath);

        return !gitignore.ignores(relative);
      });

      filteredFiles.sort((a, b) => {
        if (!workspaceRoot) {
          return a.fsPath.localeCompare(b.fsPath);
        }

        const ra = path.relative(workspaceRoot.fsPath, a.fsPath);
        const rb = path.relative(workspaceRoot.fsPath, b.fsPath);

        return ra.localeCompare(rb);
      });

      let finalOutput = "";

      for (const file of filteredFiles) {
        const buffer = await vscode.workspace.fs.readFile(file);
        const relPath = workspaceRoot ? path.relative(workspaceRoot.fsPath, file.fsPath) : path.basename(file.fsPath);

        finalOutput += `--- START OF FILE: ${relPath} ---\n`;

        if (isBinary(buffer)) {
          finalOutput += `[Binary file — content not included]\n`;
        } else {
          const text = new TextDecoder().decode(buffer);
          const fence = createFence(text);
          const ext = path.extname(file.fsPath).substring(1) || "text";

          finalOutput += `${fence}${ext}\n${text}\n${fence}\n`;
        }
        finalOutput += `--- END OF FILE: ${relPath} ---\n\n`;
      }

      if (finalOutput) {
        await vscode.env.clipboard.writeText(finalOutput.trim());

        vscode.window.setStatusBarMessage(`Promptable: ${filteredFiles.length} file(s) copied`, 3000);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Promptable Error: ${err}`);
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
