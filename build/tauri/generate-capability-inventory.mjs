/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const nativePath = path.join(repoRoot, 'src/vs/platform/native/common/native.ts');
const appPath = path.join(repoRoot, 'src/vs/code/electron-main/app.ts');
const desktopPath = path.join(repoRoot, 'src/vs/workbench/workbench.desktop.main.ts');
const outputPath = path.join(repoRoot, 'docs/tauri/capability-inventory.md');

const nativeSource = fs.readFileSync(nativePath, 'utf8');
const appSource = fs.readFileSync(appPath, 'utf8');
const desktopSource = fs.readFileSync(desktopPath, 'utf8');

const nativeMethods = Array.from(nativeSource.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9_]*)\(.*\): Promise<.*>;$/gm))
	.map(match => match[1])
	.sort();

const channels = Array.from(appSource.matchAll(/registerChannel\('([^']+)'/g))
	.map(match => match[1])
	.sort();

const desktopServices = Array.from(desktopSource.matchAll(/import '\.\/services\/([^']+)'/g))
	.map(match => match[1])
	.sort();

const lines = [
	'# Tauri Capability Inventory Baseline',
	'',
	'Generated from these upstream touchpoints:',
	'- `src/vs/platform/native/common/native.ts`',
	'- `src/vs/code/electron-main/app.ts`',
	'- `src/vs/workbench/workbench.desktop.main.ts`',
	'',
	`Generated at: ${new Date().toISOString()}`,
	'',
	'## Native Host Methods',
	''
];

for (const method of nativeMethods) {
	lines.push(`- ${method}`);
}

lines.push('', '## Electron Main IPC Channels', '');
for (const channel of channels) {
	lines.push(`- ${channel}`);
}

lines.push('', '## Desktop Service Imports', '');
for (const service of desktopServices) {
	lines.push(`- ${service}`);
}

fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
