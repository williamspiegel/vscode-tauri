/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function listConflictFiles() {
	try {
		const output = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
		return output.length === 0 ? [] : output.split('\n');
	} catch {
		return [];
	}
}

const conflicts = listConflictFiles();
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const metricsPath = process.env.VSCODE_TAURI_FALLBACK_METRICS_PATH
	? path.resolve(process.env.VSCODE_TAURI_FALLBACK_METRICS_PATH)
	: path.join(repoRoot, 'apps/tauri/logs/fallback-metrics.json');

function topFallbackMethods(filePath, limit = 5) {
	if (!fs.existsSync(filePath)) {
		return [];
	}

	try {
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		const counts = Object.entries(raw?.counts ?? {})
			.filter(([, value]) => typeof value === 'number')
			.map(([method, count]) => ({ method, count }))
			.sort((a, b) => b.count - a.count || a.method.localeCompare(b.method));
		return counts.slice(0, limit);
	} catch {
		return [];
	}
}

const topFallback = topFallbackMethods(metricsPath);
const topCapabilityFallback = topFallback.filter(entry => entry.method.startsWith('capability:')).slice(0, 5);
const topChannelFallback = topFallback.filter(entry => entry.method.startsWith('channel:')).slice(0, 5);
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

lines.push('', '## Fallback Telemetry', '');
if (topFallback.length === 0) {
	lines.push('No persisted fallback telemetry available.');
} else {
	lines.push('| Key | Count |');
	lines.push('| --- | ---: |');
	for (const entry of topFallback) {
		lines.push(`| ${entry.method} | ${entry.count} |`);
	}
}

if (topCapabilityFallback.length > 0) {
	lines.push('', '### Top Capability Fallback Keys', '', '| Key | Count |', '| --- | ---: |');
	for (const entry of topCapabilityFallback) {
		lines.push(`| ${entry.method} | ${entry.count} |`);
	}
}

if (topChannelFallback.length > 0) {
	lines.push('', '### Top Channel Fallback Keys', '', '| Key | Count |', '| --- | ---: |');
	for (const entry of topChannelFallback) {
		lines.push(`| ${entry.method} | ${entry.count} |`);
	}
}

fs.writeFileSync('tauri-upstream-sync-report.md', `${lines.join('\n')}\n`);
console.log('Wrote tauri-upstream-sync-report.md');
