/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const uiMainPath = path.join(repoRoot, 'apps/tauri/ui/src/main.ts');
const source = fs.readFileSync(uiMainPath, 'utf8');
const hostMainPath = path.join(repoRoot, 'apps/tauri/src-tauri/src/main.rs');
const hostSource = fs.readFileSync(hostMainPath, 'utf8');

function fail(message) {
	console.error(`Startup bundle parity test failed: ${message}`);
	process.exit(1);
}

if (!source.includes('resolveWorkbenchBootstrapCandidates')) {
	fail('resolveWorkbenchBootstrapCandidates helper missing');
}

if (!source.includes('resolveHostWorkbenchBootstrapConfig(windowConfig)')) {
	fail('startup path is not host-config driven');
}

if (!source.includes('markBootstrapAttempt(startupBootstrapBuildId, candidatePath)')) {
	fail('startup import loop is missing bootstrap attempt tracking');
}

if (!source.includes('shouldAutoRetryWithLegacy(lastAttemptPath)')) {
	fail('startup fallback retry guard is missing');
}

if (!source.includes('startupCurrentAttemptPath')) {
	fail('startup runtime fallback is missing in-memory attempt tracking');
}

if (!hostSource.includes('"workbenchBootstrap": workbench_bootstrap')) {
	fail('desktop.resolveWindowConfig is missing workbenchBootstrap payload');
}

if (!hostSource.includes('resolve_workbench_bootstrap_config')) {
	fail('host workbench bootstrap resolver is missing');
}

console.log('Startup bundle parity test passed.');
