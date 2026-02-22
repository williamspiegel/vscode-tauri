/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const mode = process.argv[2] ?? 'dev';
if (!['dev', 'build'].includes(mode)) {
	console.error(`Unsupported tauri mode: ${mode}. Use dev or build.`);
	process.exit(1);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		...options
	});

	if (typeof result.status === 'number' && result.status !== 0) {
		process.exit(result.status);
	}
}

run('node', ['build/tauri/contract-test.mjs']);
run('node', ['build/tauri/smoke.mjs']);
run('npm', ['--prefix', 'apps/tauri/ui', 'run', 'build']);
run('cargo', ['tauri', mode], { cwd: path.join(repoRoot, 'apps/tauri/src-tauri') });
