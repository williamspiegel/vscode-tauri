/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'node:child_process';

const allowedPrefixes = ['apps/tauri/', 'build/tauri/', 'docs/tauri/'];
const allowlist = new Set([
	'package.json',
	'scripts/code-tauri.sh',
	'scripts/code-tauri.bat',
	'.github/workflows/tauri-touchpoint-gate.yml',
	'.github/workflows/tauri-upstream-sync.yml'
]);

function uniqueFiles(values) {
	return [...new Set(values.filter(Boolean))].sort();
}

function listFilesFromCommand(command) {
	const output = execSync(command, { encoding: 'utf8' }).trim();
	return output.length === 0 ? [] : output.split('\n');
}

let files = [];
if (process.env.GITHUB_BASE_REF) {
	const baseRef = `origin/${process.env.GITHUB_BASE_REF}`;
	const headRef = process.env.GITHUB_SHA ?? 'HEAD';
	files = listFilesFromCommand(`git diff --name-only ${baseRef}...${headRef}`);
} else {
	files = uniqueFiles([
		...listFilesFromCommand('git diff --name-only'),
		...listFilesFromCommand('git diff --name-only --cached'),
		...listFilesFromCommand('git ls-files --others --exclude-standard')
	]);
}

const disallowed = files.filter(file => {
	if (allowlist.has(file)) {
		return false;
	}

	return !allowedPrefixes.some(prefix => file.startsWith(prefix));
});

if (disallowed.length === 0) {
	console.log('Touchpoint gate passed: all changed files are within approved areas.');
	process.exit(0);
}

const ledgerUpdated = files.includes('docs/tauri/upstream-touchpoints.md');
if (!ledgerUpdated) {
	console.error('Touchpoint gate failed. Found edits outside approved areas and ledger was not updated:');
	for (const file of disallowed) {
		console.error(`- ${file}`);
	}
	process.exit(1);
}

console.warn('Touchpoint gate warning: ledger updated for out-of-bound edits.');
for (const file of disallowed) {
	console.warn(`- ${file}`);
}
