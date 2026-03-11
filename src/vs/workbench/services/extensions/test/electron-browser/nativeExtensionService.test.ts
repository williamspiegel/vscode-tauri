/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { ExtensionHostKind, ExtensionRunningPreference } from '../../common/extensionHostKind.js';
import { NativeExtensionHostKindPicker } from '../../electron-browser/nativeExtensionService.js';

suite('NativeExtensionHostKindPicker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function withTauriDesktopRuntime(testFn: () => void): void {
		const previousVscode = (globalThis as typeof globalThis & { vscode?: unknown }).vscode;
		(globalThis as typeof globalThis & {
			vscode?: {
				process?: {
					env?: Record<string, string | undefined>;
				};
			};
		}).vscode = { process: { env: { VSCODE_DESKTOP_RUNTIME: 'electrobun' } } };
		try {
			testFn();
		} finally {
			(globalThis as typeof globalThis & { vscode?: unknown }).vscode = previousVscode;
		}
	}

	function createEnvironmentService(): IWorkbenchEnvironmentService {
		const environmentService = mock<IWorkbenchEnvironmentService>();
		environmentService.remoteAuthority = undefined;
		environmentService.isExtensionDevelopment = false;
		environmentService.extensionDevelopmentKind = [];
		return environmentService;
	}

	test('disables auto web worker extension host in tauri desktop', () => {
		withTauriDesktopRuntime(() => {
			const picker = new NativeExtensionHostKindPicker(
				createEnvironmentService(),
				new TestConfigurationService({ 'extensions.webWorker': 'auto' }),
				new NullLogService(),
			);

			assert.strictEqual(
				picker.pickExtensionHostKind(new ExtensionIdentifier('pub.name'), ['web'], true, false, ExtensionRunningPreference.None),
				null,
			);
		});
	});

	test('allows explicitly enabled web worker extension host in tauri desktop', () => {
		withTauriDesktopRuntime(() => {
			const picker = new NativeExtensionHostKindPicker(
				createEnvironmentService(),
				new TestConfigurationService({ 'extensions.webWorker': true }),
				new NullLogService(),
			);

			assert.strictEqual(
				picker.pickExtensionHostKind(new ExtensionIdentifier('pub.name'), ['web'], true, false, ExtensionRunningPreference.None),
				ExtensionHostKind.LocalWebWorker,
			);
		});
	});
});
