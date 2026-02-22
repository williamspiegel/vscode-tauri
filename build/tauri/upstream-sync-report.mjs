/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'node:child_process';
import fs from 'node:fs';

function listConflictFiles() {
	try {
		const output = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
		return output.length === 0 ? [] : output.split('\n');
	} catch {
		return [];
	}
}

const conflicts = listConflictFiles();
const lines = [
	'# Upstream Sync Report',
	'',
	`Generated: ${new Date().toISOString()}`,
	'',
	`Conflict count: ${conflicts.length}`,
	''
];

if (conflicts.length > 0) {
	lines.push('## Conflict Files', '');
	for (const file of conflicts) {
		lines.push(`- ${file}`);
	}
} else {
	lines.push('No merge conflicts detected.');
}

fs.writeFileSync('tauri-upstream-sync-report.md', `${lines.join('\n')}\n`);
console.log('Wrote tauri-upstream-sync-report.md');
