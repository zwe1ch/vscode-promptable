import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
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

const PROMPTABLE_IGNORE_FILE = ".promptableignore";
const GITIGNORE_FILE = ".gitignore";

interface ProjectRoot {
  readonly uri: vscode.Uri;
  readonly applyGitignore: boolean;
}

/**
 * Hierarchical rules of one project root. Every ignore file found on the way from the root to a copied file is
 * rewritten so that its patterns are scoped to the file's own directory and added to a single `ignore` instance,
 * parents before children. Because the last matching pattern wins, deeper files take precedence over shallower ones,
 * while the instance itself keeps excluded parent directories from being re-included.
 */
interface ProjectRules {
  readonly root: vscode.Uri;
  readonly promptableIgnore: Ignore;
  readonly gitignore: Ignore | null;
  readonly loadedDirectories: Set<string>;
}

function escapeGlobLiteral(segment: string): string {
  return segment.replace(/[\\*?[\]!#]/g, "\\$&");
}

/**
 * Rewrites the patterns of an ignore file located in `directory` (segments relative to the project root)
 * so that they have the same meaning when evaluated relative to the project root.
 */
function scopePatterns(content: string, directory: string[]): string[] {
  const lines = content.split(/\r?\n/);

  if (directory.length === 0) {
    return lines;
  }

  const prefix = directory.map(escapeGlobLiteral).join("/");
  const scoped: string[] = [];

  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) {
      continue;
    }

    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;
    const pattern = body.trimEnd();
    const anchored = pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
    const scopedBody = anchored ? `${prefix}/${body.replace(/^\//, "")}` : `${prefix}/**/${body}`;

    scoped.push(negated ? `!${scopedBody}` : scopedBody);
  }

  return scoped;
}

type IgnoreFileReader = (directory: vscode.Uri, name: string, mustBeReadable: boolean) => Promise<string | null>;
type IgnoreCaseResolver = (fsPath: string) => Promise<boolean>;

const execFileAsync = promisify(execFile);

// Fallback when no Git repository (or no usable Git) is known for a file: assume the usual file system
// behavior of the platform, which is also what Git itself picks when it initializes a repository.
const platformIgnoresCase = process.platform === "win32" || process.platform === "darwin";

/**
 * Reads the effective `core.ignorecase` of a repository (local, global, and system config). Git's default is false,
 * which is what `git config --get` reports as exit code 1 when the key is not set. If Git cannot be run at all,
 * the platform fallback is used instead of failing the copy.
 */
async function readCoreIgnoreCase(repositoryRoot: vscode.Uri): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repositoryRoot.fsPath, "config", "--type=bool", "--get", "core.ignorecase"], { timeout: 10000, windowsHide: true });

    return stdout.trim() === "true";
  } catch (err) {
    return (err as { code?: unknown }).code === 1 ? false : platformIgnoresCase;
  }
}

/**
 * Resolves case sensitivity per file from the deepest known Git repository containing it, so nested and sibling
 * repositories can differ. Each repository is queried at most once per resolver.
 */
function createIgnoreCaseResolver(repositoryRoots: vscode.Uri[]): IgnoreCaseResolver {
  const byRepository = new Map<string, Promise<boolean>>();

  return async (fsPath) => {
    const repositoryRoot = findRepositoryRoot(repositoryRoots, fsPath);

    if (!repositoryRoot) {
      return platformIgnoresCase;
    }

    let pending = byRepository.get(repositoryRoot.fsPath);

    if (!pending) {
      pending = readCoreIgnoreCase(repositoryRoot);
      byRepository.set(repositoryRoot.fsPath, pending);
    }

    return pending;
  };
}

function createIgnoreFileReader(): IgnoreFileReader {
  const cache = new Map<string, Promise<string | null>>();

  return (directory, name, mustBeReadable) => {
    const key = `${directory.toString()}|${name}`;
    let pending = cache.get(key);

    if (!pending) {
      pending = readIgnoreFile(directory, name, mustBeReadable);
      cache.set(key, pending);
    }

    return pending;
  };
}

async function readIgnoreFile(directory: vscode.Uri, name: string, mustBeReadable: boolean): Promise<string | null> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, name)));
  } catch (err) {
    const code = (err as { code?: string }).code;

    if (code === "FileNotFound" || code === "FileNotADirectory" || !mustBeReadable) {
      return null;
    }

    throw new Error(`Could not read ${name} in ${directory.fsPath}: ${err}`);
  }
}

function createProjectRules(project: ProjectRoot, ignoreCase: boolean): ProjectRules {
  return {
    root: project.uri,
    promptableIgnore: ignore({ ignorecase: ignoreCase }),
    gitignore: project.applyGitignore ? ignore({ ignorecase: ignoreCase }) : null,
    loadedDirectories: new Set()
  };
}

/**
 * Loads the ignore files of every directory from the project root down to `directory`, parents first.
 * Each directory is read at most once per rule set. A missing ignore file is fine, an unreadable
 * .promptableignore throws, and an unreadable .gitignore is skipped.
 */
async function loadRulesUpTo(rules: ProjectRules, directory: string[], readFile: IgnoreFileReader): Promise<void> {
  for (let depth = 0; depth <= directory.length; depth++) {
    const segments = directory.slice(0, depth);
    const key = segments.join("/");

    if (rules.loadedDirectories.has(key)) {
      continue;
    }

    rules.loadedDirectories.add(key);

    const uri = segments.length > 0 ? vscode.Uri.joinPath(rules.root, ...segments) : rules.root;
    const [promptableContent, gitContent] = await Promise.all([readFile(uri, PROMPTABLE_IGNORE_FILE, true), rules.gitignore ? readFile(uri, GITIGNORE_FILE, false) : null]);

    if (promptableContent !== null) {
      rules.promptableIgnore.add(scopePatterns(promptableContent, segments));
    }

    if (gitContent !== null) {
      rules.gitignore?.add(scopePatterns(gitContent, segments));
    }
  }
}

function isPromptableIgnoreFile(fsPath: string): boolean {
  return path.basename(fsPath).toLowerCase() === PROMPTABLE_IGNORE_FILE;
}

function isInside(root: vscode.Uri, fsPath: string): boolean {
  const relative = path.relative(root.fsPath, fsPath);

  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Removes files excluded by the hierarchical .promptableignore files (and .gitignore files if the project root requests it).
 * Both rule sets are evaluated independently, so negations in one never re-include files excluded by the other.
 * A .promptableignore file is never included. Other files without a project root are not filtered.
 * Rule sets are kept per project root, rule file type selection, and case sensitivity of the file's Git repository,
 * so repositories with different `core.ignorecase` values never share patterns. The ignore files themselves are read once.
 * Throws if an existing .promptableignore cannot be read.
 */
async function excludeIgnored<T extends { readonly uri: vscode.Uri }>(files: T[], getRoot: (file: T) => ProjectRoot | undefined, resolveIgnoreCase: IgnoreCaseResolver): Promise<T[]> {
  const rulesByKey = new Map<string, ProjectRules>();
  const readFile = createIgnoreFileReader();
  const included: T[] = [];

  for (const file of files) {
    if (isPromptableIgnoreFile(file.uri.fsPath)) {
      continue;
    }

    const project = getRoot(file);

    if (!project || !isInside(project.uri, file.uri.fsPath)) {
      included.push(file);
      continue;
    }

    const ignoreCase = await resolveIgnoreCase(file.uri.fsPath);
    const key = `${project.uri.toString()}|${project.applyGitignore}|${ignoreCase}`;
    let rules = rulesByKey.get(key);

    if (!rules) {
      rules = createProjectRules(project, ignoreCase);
      rulesByKey.set(key, rules);
    }

    const relative = path.relative(project.uri.fsPath, file.uri.fsPath).split(path.sep).join("/");

    await loadRulesUpTo(rules, relative.split("/").slice(0, -1), readFile);

    if (!rules.promptableIgnore.ignores(relative) && !rules.gitignore?.ignores(relative)) {
      included.push(file);
    }
  }

  return included;
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

async function getRepositoryRoots(gitExtensionLoader: () => Promise<GitExtension | undefined>): Promise<vscode.Uri[]> {
  try {
    const gitExtension = await gitExtensionLoader();

    return gitExtension?.enabled ? gitExtension.getAPI(1).repositories.map((repository) => repository.rootUri) : [];
  } catch {
    return [];
  }
}

function findRepositoryRoot(repositoryRoots: vscode.Uri[], fsPath: string): vscode.Uri | undefined {
  const containing = repositoryRoots.filter((root) => isInside(root, fsPath));

  return containing.sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
}

export async function copyTargets(targets: vscode.Uri[], respectGitignore: boolean, gitExtensionLoader: () => Promise<GitExtension | undefined> = loadGitExtension): Promise<void> {
  if (targets.length === 0) {
    return;
  }

  try {
    const allFiles: vscode.Uri[] = [];

    for (const target of targets) {
      allFiles.push(...(await collectFiles(target)));
    }

    const uniqueFiles = Array.from(new Map(allFiles.map((u) => [u.fsPath, u])).values());
    const repositoryRoots = await getRepositoryRoots(gitExtensionLoader);
    const getProjectRoot = (uri: vscode.Uri): ProjectRoot | undefined => {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

      if (workspaceFolder) {
        return { uri: workspaceFolder.uri, applyGitignore: respectGitignore };
      }

      const repositoryRoot = findRepositoryRoot(repositoryRoots, uri.fsPath);

      return repositoryRoot ? { uri: repositoryRoot, applyGitignore: false } : undefined;
    };
    const filteredFiles = await excludeIgnored(
      uniqueFiles.map((uri) => ({ uri })),
      (file) => getProjectRoot(file.uri),
      createIgnoreCaseResolver(repositoryRoots)
    );

    await copyFiles(
      filteredFiles.map(({ uri }) => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const relativePath = workspaceFolder ? getWorkspaceRelativePath(workspaceFolder, uri.fsPath) : undefined;

        return {
          uri,
          relativePath: relativePath ?? path.basename(uri.fsPath),
          sortPath: relativePath ?? uri.fsPath
        };
      })
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

function getGitProjectRoot(file: GitChangedFile): ProjectRoot {
  return { uri: vscode.workspace.getWorkspaceFolder(file.uri)?.uri ?? file.repositoryRoot, applyGitignore: false };
}

function getWorkspaceRelativePath(workspaceFolder: vscode.WorkspaceFolder, fsPath: string): string {
  const relative = path.relative(workspaceFolder.uri.fsPath, fsPath);
  const isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

  return isMultiRoot ? path.join(workspaceFolder.name, relative) : relative;
}

function getGitRelativePath(file: GitChangedFile, repositoryCount: number): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(file.uri);

  if (workspaceFolder) {
    return getWorkspaceRelativePath(workspaceFolder, file.uri.fsPath);
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
    const files = await excludeIgnored(
      changedFiles,
      getGitProjectRoot,
      createIgnoreCaseResolver(repositories.map((repository) => repository.rootUri))
    );

    if (files.length === 0) {
      vscode.window.setStatusBarMessage("Promptable: No changed files", 3000);
      return "noChanges";
    }

    await copyFiles(
      files.map((file) => {
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
