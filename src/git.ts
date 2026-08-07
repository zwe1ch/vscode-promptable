import * as vscode from "vscode";

export enum GitStatus {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED
}

export interface GitChange {
  readonly uri: vscode.Uri;
  readonly status: GitStatus;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly mergeChanges: GitChange[];
    readonly indexChanges: GitChange[];
    readonly workingTreeChanges: GitChange[];
    readonly untrackedChanges?: GitChange[];
  };
}

export interface GitAPI {
  readonly repositories: GitRepository[];
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export interface GitChangedFile {
  readonly uri: vscode.Uri;
  readonly repositoryRoot: vscode.Uri;
  deleted: boolean;
}

const deletedStatuses = new Set([GitStatus.INDEX_DELETED, GitStatus.DELETED, GitStatus.DELETED_BY_US, GitStatus.DELETED_BY_THEM, GitStatus.BOTH_DELETED]);

function uriKey(uri: vscode.Uri): string {
  return uri.scheme === "file" && process.platform === "win32" ? `${uri.scheme}:${uri.fsPath.toLowerCase()}` : uri.toString();
}

export function collectGitChanges(repositories: GitRepository[]): GitChangedFile[] {
  const files = new Map<string, GitChangedFile>();

  for (const repository of repositories) {
    const changes = [...repository.state.mergeChanges, ...repository.state.indexChanges, ...repository.state.workingTreeChanges, ...(repository.state.untrackedChanges ?? [])];

    for (const change of changes) {
      const key = uriKey(change.uri);
      const existing = files.get(key);
      const deleted = deletedStatuses.has(change.status);

      if (existing) {
        existing.deleted ||= deleted;
      } else {
        files.set(key, { uri: change.uri, repositoryRoot: repository.rootUri, deleted });
      }
    }
  }

  return [...files.values()];
}
