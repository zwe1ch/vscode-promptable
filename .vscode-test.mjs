import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaceFolder = mkdtempSync(join(tmpdir(), 'promptable-test-workspace-'));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
});
