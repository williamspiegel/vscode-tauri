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
const protocolPath = path.join(repoRoot, 'apps/tauri/protocol/host-v1.json');
const rustMainPath = path.join(repoRoot, 'apps/tauri/src-tauri/src/main.rs');
const rustCapabilitiesPath = path.join(repoRoot, 'apps/tauri/src-tauri/src/capabilities');
const outputPath = path.join(repoRoot, 'docs/tauri/capability-inventory.md');

const nativeSource = fs.readFileSync(nativePath, 'utf8');
const appSource = fs.readFileSync(appPath, 'utf8');
const desktopSource = fs.readFileSync(desktopPath, 'utf8');
const rustMainSource = fs.readFileSync(rustMainPath, 'utf8');
const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8'));

const nativeMethods = uniqueSorted(
	Array.from(nativeSource.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9_]*)\(.*\): Promise<.*>;$/gm))
		.map(match => match[1])
);

const channels = uniqueSorted(
	Array.from(appSource.matchAll(/registerChannel\('([^']+)'/g))
		.map(match => match[1])
);

const desktopServices = uniqueSorted(
	Array.from(desktopSource.matchAll(/import '\.\/services\/([^']+)'/g))
		.map(match => match[1])
);

const protocolMethods = uniqueSorted(Object.keys(protocol.methods ?? {}));
const protocolMethodSet = new Set(protocolMethods);

const rustSources = [rustMainSource];
for (const entry of fs.readdirSync(rustCapabilitiesPath, { withFileTypes: true })) {
	if (entry.isFile() && entry.name.endsWith('.rs')) {
		const filePath = path.join(rustCapabilitiesPath, entry.name);
		rustSources.push(fs.readFileSync(filePath, 'utf8'));
	}
}

const rustMentionedMethods = new Set();
for (const source of rustSources) {
	for (const match of source.matchAll(/"([a-z]+(?:\.[A-Za-z][A-Za-z0-9]*)+)"/g)) {
		const method = match[1];
		if (protocolMethodSet.has(method)) {
			rustMentionedMethods.add(method);
		}
	}
}

const methodRows = protocolMethods.map(method => {
	let backend = 'node-fallback';
	if (method.startsWith('protocol.') || method.startsWith('host.')) {
		backend = 'host-core';
	} else if (rustMentionedMethods.has(method)) {
		backend = 'rust-primary';
	}

	return {
		method,
		domain: method.split('.')[0],
		backend
	};
});

const domainStats = new Map();
for (const row of methodRows) {
	const current = domainStats.get(row.domain) ?? {
		total: 0,
		rust: 0,
		fallback: 0,
		core: 0
	};

	current.total += 1;
	if (row.backend === 'rust-primary') {
		current.rust += 1;
	} else if (row.backend === 'node-fallback') {
		current.fallback += 1;
	} else {
		current.core += 1;
	}

	domainStats.set(row.domain, current);
}

const rustCount = methodRows.filter(row => row.backend === 'rust-primary').length;
const fallbackCount = methodRows.filter(row => row.backend === 'node-fallback').length;
const coreCount = methodRows.filter(row => row.backend === 'host-core').length;

const lines = [
	'# Tauri Capability Inventory Baseline',
	'',
	'Generated from these upstream touchpoints:',
	'- `src/vs/platform/native/common/native.ts`',
	'- `src/vs/code/electron-main/app.ts`',
	'- `src/vs/workbench/workbench.desktop.main.ts`',
	'',
	'Generated from these Tauri touchpoints:',
	'- `apps/tauri/protocol/host-v1.json`',
	'- `apps/tauri/src-tauri/src/main.rs`',
	'- `apps/tauri/src-tauri/src/capabilities/*.rs`',
	'',
	`Generated at: ${new Date().toISOString()}`,
	'',
	'## Protocol Coverage Snapshot',
	'',
	`- Protocol methods: ${protocolMethods.length}`,
	`- Rust primary methods with handler entrypoints: ${rustCount}`,
	`- Methods missing Rust entrypoints (Node fallback required): ${fallbackCount}`,
	`- Host/protocol core methods: ${coreCount}`,
	'- Note: methods counted as Rust primary can still route to Node fallback at runtime based on platform or partial implementation.',
	'',
	'### By Domain',
	'',
	'| Domain | Total | Rust Primary Entry | Missing Rust Entry | Host Core |',
	'| --- | ---: | ---: | ---: | ---: |'
];

for (const domain of uniqueSorted(Array.from(domainStats.keys()))) {
	const stats = domainStats.get(domain);
	if (!stats) {
		continue;
	}
	lines.push(
		`| ${domain} | ${stats.total} | ${stats.rust} | ${stats.fallback} | ${stats.core} |`
	);
}

const fallbackMethods = methodRows
	.filter(row => row.backend === 'node-fallback')
	.map(row => row.method)
	.sort((a, b) => a.localeCompare(b));

lines.push('', '### Methods Missing Rust Entry', '');
for (const method of fallbackMethods) {
	lines.push(`- ${method}`);
}

lines.push(
	'',
	'## Native Host Methods',
	`Count: ${nativeMethods.length}`,
	''
);

for (const method of nativeMethods) {
	lines.push(`- ${method}`);
}

lines.push('', '## Electron Main IPC Channels', `Count: ${channels.length}`, '');
for (const channel of channels) {
	lines.push(`- ${channel}`);
}

lines.push('', '## Desktop Service Imports', `Count: ${desktopServices.length}`, '');
for (const service of desktopServices) {
	lines.push(`- ${service}`);
}

fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);

function uniqueSorted(items) {
	return Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));
}
