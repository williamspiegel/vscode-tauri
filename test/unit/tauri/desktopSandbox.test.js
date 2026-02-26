/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const assert = require('assert');
const path = require('path');

suite('Tauri Desktop Sandbox', () => {
	const originalWindow = global.window;
	const originalGlobalProcess = global.process;
	const originalGlobalAlias = global.global;

	/** @type {typeof import('../../../../apps/tauri/ui/src/desktopSandbox')} */
	let sandboxModule;

	setup(() => {
		const compiledUiRoot = process.env.TAURI_UI_TEST_BUILD_DIR;
		assert.ok(compiledUiRoot, 'TAURI_UI_TEST_BUILD_DIR must be set by harness');
		global.window = {
			location: { search: '', origin: 'http://127.0.0.1:1420', pathname: '/', href: 'http://127.0.0.1:1420/' },
			localStorage: { getItem() { return null; }, setItem() { }, removeItem() { } },
			addEventListener() { },
			removeEventListener() { },
			postMessage() { }
		};

		sandboxModule = require(path.join(compiledUiRoot, 'desktopSandbox.js'));
	});

	teardown(() => {
		global.window = originalWindow;
		global.process = originalGlobalProcess;
		global.global = originalGlobalAlias;
	});

	test('installDesktopSandbox exposes expected vscode globals', async () => {
		const storage = new Map();
		global.window = {
			location: {
				search: '',
				origin: 'http://127.0.0.1:1420',
				pathname: '/',
				href: 'http://127.0.0.1:1420/'
			},
			localStorage: {
				getItem(key) {
					return storage.has(key) ? storage.get(key) : null;
				},
				setItem(key, value) {
					storage.set(key, String(value));
				},
				removeItem(key) {
					storage.delete(key);
				}
			},
			addEventListener() { },
			removeEventListener() { },
			postMessage() { }
		};

		const mockHost = {
			resolveWindowConfig: async () => ({
				windowId: 1,
				userEnv: { VSCODE_CWD: '/workspace' },
				os: { platform: 'darwin', arch: 'arm64' }
			}),
			invokeMethod: async (method) => method === 'process.env' ? { env: { PATH: '/usr/bin' } } : {},
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async () => async () => undefined
		};

		await sandboxModule.installDesktopSandbox(mockHost);

		const vscode = global.window.vscode;
		assert.ok(vscode);
		assert.strictEqual(typeof vscode.ipcRenderer.send, 'function');
		assert.strictEqual(typeof vscode.webFrame.setZoomLevel, 'function');
		assert.strictEqual(typeof vscode.process.platform, 'string');
		assert.strictEqual(typeof vscode.webUtils.getPathForFile, 'function');
		assert.strictEqual(vscode.process.versions.electron, 'tauri-bridge');
		assert.strictEqual(vscode.process.versions.tauri, '2');
		assert.strictEqual(vscode.process.cwd(), '/workspace');

		const shellEnv = await vscode.process.shellEnv();
		assert.strictEqual(shellEnv.PATH, '/usr/bin');
		assert.strictEqual(shellEnv.VSCODE_CWD, '/workspace');

		assert.strictEqual(global.process.type, 'renderer');
		assert.strictEqual(global.global, globalThis);
	});
});
