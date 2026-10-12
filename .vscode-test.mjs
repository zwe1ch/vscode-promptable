import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaceFolder = mkdtempSync(join(tmpdir(), 'promptable-test-workspace-'));

const multiRootDirectory = mkdtempSync(join(tmpdir(), 'promptable-test-multiroot-'));
const multiRootFolders = ['folder-a', 'folder-b'];

for (const name of multiRootFolders) {
	mkdirSync(join(multiRootDirectory, name));
}

const multiRootWorkspace = join(multiRootDirectory, 'promptable.code-workspace');

writeFileSync(multiRootWorkspace, JSON.stringify({ folders: multiRootFolders.map((name) => ({ path: name })) }));

export default defineConfig([
	{
		label: 'single-root',
		files: 'out/test/extension.test.js',
		workspaceFolder,
	},
	{
		label: 'multi-root',
		files: 'out/test/multiroot.test.js',
		workspaceFolder: multiRootWorkspace,
	},
]);
