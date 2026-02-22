/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const protocolPath = path.join(repoRoot, 'apps/tauri/protocol/host-v1.json');
const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8'));

function fail(message) {
	console.error(`Protocol contract test failed: ${message}`);
	process.exit(1);
}

if (protocol.protocolVersion !== '1.0.0') {
	fail(`expected protocolVersion=1.0.0, got ${protocol.protocolVersion}`);
}

if (protocol.jsonrpc !== '2.0') {
	fail(`expected jsonrpc=2.0, got ${protocol.jsonrpc}`);
}

const requiredDomains = [
	'window',
	'filesystem',
	'terminal',
	'clipboard',
	'dialogs',
	'process',
	'power',
	'os',
	'update'
];

for (const domain of requiredDomains) {
	if (!protocol.capabilities?.[domain]) {
		fail(`missing capability domain ${domain}`);
	}

	const methods = protocol.capabilities[domain].methods;
	if (!Array.isArray(methods) || methods.length === 0) {
		fail(`capability domain ${domain} has no methods`);
	}

	for (const method of methods) {
		if (!protocol.methods?.[method]) {
			fail(`method ${method} declared in ${domain} but missing method spec`);
		}
	}
}

if (!Array.isArray(protocol.errors) || protocol.errors.length < 3) {
	fail('error catalog is incomplete');
}

console.log('Protocol contract test passed.');
