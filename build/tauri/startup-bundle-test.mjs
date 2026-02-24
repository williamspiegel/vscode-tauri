/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const uiMainPath = path.join(repoRoot, 'apps/tauri/ui/src/main.ts');
const source = fs.readFileSync(uiMainPath, 'utf8');

function fail(message) {
	console.error(`Startup bundle parity test failed: ${message}`);
	process.exit(1);
}

if (!source.includes('resolveWorkbenchBootstrapCandidates')) {
	fail('resolveWorkbenchBootstrapCandidates helper missing');
}

if (!source.includes('return dedupe([...legacyCandidates, ...minCandidates]);')) {
	fail('startup path does not keep legacy-first ordering with min fallback');
}

console.log('Startup bundle parity test passed.');
