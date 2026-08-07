import * as path from "path";
import * as vscode from "vscode";

import { GitChangedFile, GitExtension, collectGitChanges } from "./git";
import ignore, { Ignore } from "ignore";

interface CopyFile {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly sortPath: string;
  readonly deleted?: boolean;
}

export type CopyChangedResult = "copied" | "gitUnavailable" | "noRepositories" | "noChanges" | "error";

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
    if (path.basename(uri.fsPath) === ".git") {
      return [];
    }

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

        return relativeDir === "." ? rule : path.join(relativeDir, rule).replaceAll(path.sep, "/");
      });

      i.add(prefixedRules);
    }
    return i;
  } catch {
    return null;
  }
}

async function copyFiles(files: CopyFile[]): Promise<void> {
  files.sort((a, b) => a.sortPath.localeCompare(b.sortPath));

  let finalOutput = "";

  for (const file of files) {
    finalOutput += `--- START OF FILE: ${file.relativePath} ---\n`;

    let buffer: Uint8Array | undefined;

    try {
      buffer = await vscode.workspace.fs.readFile(file.uri);
    } catch (err) {
      if (!file.deleted) {
        throw err;
      }

      finalOutput += `[Deleted file — content not available]\n`;
    }

    if (buffer) {
      if (isBinary(buffer)) {
        finalOutput += `[Binary file — content not included]\n`;
      } else {
        const text = new TextDecoder().decode(buffer);
        const fence = createFence(text);
        const ext = path.extname(file.uri.fsPath).substring(1) || "text";

        finalOutput += `${fence}${ext}\n${text}\n${fence}\n`;
      }
    }
    finalOutput += `--- END OF FILE: ${file.relativePath} ---\n\n`;
  }

  if (finalOutput) {
    await vscode.env.clipboard.writeText(finalOutput.trim());
    vscode.window.setStatusBarMessage(`Promptable: ${files.length} file(s) copied`, 3000);
  }
}

async function copyTargets(targets: vscode.Uri[], respectGitignore: boolean): Promise<void> {
  if (targets.length === 0) {
    return;
  }

  try {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(targets[0]);
    const workspaceRoot = workspaceFolder?.uri;
    const gitignore = respectGitignore && workspaceRoot ? await getGitignore(workspaceRoot) : null;

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

    await copyFiles(
      filteredFiles.map((file) => ({
        uri: file,
        relativePath: workspaceRoot ? path.relative(workspaceRoot.fsPath, file.fsPath) : path.basename(file.fsPath),
        sortPath: workspaceRoot ? path.relative(workspaceRoot.fsPath, file.fsPath) : file.fsPath
      }))
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Promptable Error: ${err}`);
  }
}

async function loadGitExtension(): Promise<GitExtension | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");

  if (!extension) {
    return undefined;
  }

  return extension.isActive ? extension.exports : extension.activate();
}

function getGitRelativePath(file: GitChangedFile, repositoryCount: number): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(file.uri);

  if (workspaceFolder) {
    const relative = path.relative(workspaceFolder.uri.fsPath, file.uri.fsPath);
    const isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

    return isMultiRoot ? path.join(workspaceFolder.name, relative) : relative;
  }

  const relative = path.relative(file.repositoryRoot.fsPath, file.uri.fsPath);

  return repositoryCount > 1 ? path.join(path.basename(file.repositoryRoot.fsPath), relative) : relative;
}

export async function copyChangedFiles(gitExtensionLoader: () => Promise<GitExtension | undefined> = loadGitExtension): Promise<CopyChangedResult> {
  let gitExtension: GitExtension | undefined;

  try {
    gitExtension = await gitExtensionLoader();
  } catch {
    vscode.window.setStatusBarMessage("Promptable: Git is not available", 3000);
    return "gitUnavailable";
  }

  if (!gitExtension?.enabled) {
    vscode.window.setStatusBarMessage("Promptable: Git is not available", 3000);
    return "gitUnavailable";
  }

  let repositories;

  try {
    repositories = gitExtension.getAPI(1).repositories;
  } catch {
    vscode.window.setStatusBarMessage("Promptable: Git is not available", 3000);
    return "gitUnavailable";
  }

  if (repositories.length === 0) {
    vscode.window.setStatusBarMessage("Promptable: No Git repositories", 3000);
    return "noRepositories";
  }

  const changedFiles = collectGitChanges(repositories);

  if (changedFiles.length === 0) {
    vscode.window.setStatusBarMessage("Promptable: No changed files", 3000);
    return "noChanges";
  }

  try {
    await copyFiles(
      changedFiles.map((file) => {
        const relativePath = getGitRelativePath(file, repositories.length);

        return { uri: file.uri, relativePath, sortPath: relativePath, deleted: file.deleted };
      })
    );
    return "copied";
  } catch (err) {
    vscode.window.showErrorMessage(`Promptable Error: ${err}`);
    return "error";
  }
}

function copyCommand(respectGitignore: boolean) {
  return (mainUri?: vscode.Uri, allUris?: vscode.Uri[]) => copyTargets(getSelectedUris(mainUri, allUris), respectGitignore);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("promptable.copy", copyCommand(true)),
    vscode.commands.registerCommand("promptable.copyIgnoringGitignore", copyCommand(false)),
    vscode.commands.registerCommand("promptable.copyChanged", () => copyChangedFiles())
  );
}

export function deactivate() {}
