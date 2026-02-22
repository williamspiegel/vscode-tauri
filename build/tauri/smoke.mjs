/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const required = [
	'apps/tauri/protocol/host-v1.json',
	'apps/tauri/src-tauri/Cargo.toml',
	'apps/tauri/src-tauri/src/main.rs',
	'apps/tauri/ui/src/main.ts',
	'docs/tauri/parity-matrix.yaml',
	'docs/tauri/upstream-touchpoints.md'
];

const missing = required.filter(file => !fs.existsSync(path.join(repoRoot, file)));
if (missing.length > 0) {
	console.error('Tauri smoke check failed. Missing required files:');
	for (const file of missing) {
		console.error(`- ${file}`);
	}
	process.exit(1);
}

const matrixPath = path.join(repoRoot, 'docs/tauri/parity-matrix.yaml');
const matrix = fs.readFileSync(matrixPath, 'utf8');
if (!matrix.includes('capabilities:')) {
	console.error('Tauri smoke check failed: parity matrix has no capabilities section.');
	process.exit(1);
}

console.log('Tauri smoke check passed.');
