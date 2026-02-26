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

	/**
	 * @param {string} [search]
	 */
	function createWindow(search = '') {
		const storage = new Map();
		/** @type {unknown[][]} */
		const postMessages = [];
		global.window = {
			location: {
				search,
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
			postMessage(...args) {
				postMessages.push(args);
			}
		};
		return { postMessages };
	}

	/**
	 * @param {Record<string, unknown>} [configOverrides]
	 */
	function createHost(configOverrides = {}) {
		/** @type {{ channel: string; method: string; args: unknown[] }[]} */
		const channelCalls = [];
		/** @type {{ method: string; params: unknown }[]} */
		const methodCalls = [];
		/** @type {Map<string, (payload: unknown) => void>} */
		const listeners = new Map();
		let resolveCount = 0;
		const baseConfig = {
			windowId: 1,
			userEnv: { VSCODE_CWD: '/workspace' },
			os: { platform: 'darwin', arch: 'arm64' }
		};
		const initialConfig = { ...baseConfig, ...configOverrides };

		const host = {
			resolveWindowConfig: async () => {
				resolveCount += 1;
				return JSON.parse(JSON.stringify(initialConfig));
			},
			invokeMethod: async (method, params) => {
				methodCalls.push({ method, params });
				if (method === 'process.env') {
					return { env: { PATH: '/usr/bin', SHELL: '/bin/zsh' } };
				}
				return {};
			},
			desktopChannelCall: async (channel, method, args) => {
				channelCalls.push({ channel, method, args: Array.isArray(args) ? args : [] });
				return undefined;
			},
			desktopChannelListen: async (channel, event, _arg, onEvent) => {
				listeners.set(`${channel}:${event}`, onEvent);
				return async () => undefined;
			}
		};

		return {
			host,
			channelCalls,
			methodCalls,
			listeners,
			getResolveCount: () => resolveCount
		};
	}

	test('installDesktopSandbox exposes expected vscode globals and process shims', async () => {
		createWindow('');
		const { host } = createHost();

		await sandboxModule.installDesktopSandbox(host);

		const vscode = global.window.vscode;
		assert.ok(vscode);
		assert.strictEqual(typeof vscode.ipcRenderer.send, 'function');
		assert.strictEqual(typeof vscode.webFrame.setZoomLevel, 'function');
		assert.strictEqual(typeof vscode.process.platform, 'string');
		assert.strictEqual(typeof vscode.webUtils.getPathForFile, 'function');
		assert.strictEqual(vscode.process.versions.electron, 'tauri-bridge');
		assert.strictEqual(vscode.process.versions.tauri, '2');
		assert.strictEqual(vscode.process.cwd(), '/workspace');
		assert.strictEqual(vscode.process.env.VSCODE_DESKTOP_RUNTIME, 'electrobun');
		assert.strictEqual(vscode.process.env.VSCODE_ELECTROBUN_DISABLE_MESSAGEPORT, 'true');
		assert.match(vscode.process.env.VSCODE_TAURI_WEBVIEW_EXTERNAL_ENDPOINT, /\/out\/vs\/workbench\/contrib\/webview\/browser\/pre\/$/);
		assert.strictEqual(global.window._VSCODE_USE_RELATIVE_IMPORTS, true);
		assert.strictEqual(global.window._VSCODE_DISABLE_CSS_IMPORT_MAP, false);

		const shellEnv = await vscode.process.shellEnv();
		assert.strictEqual(shellEnv.PATH, '/usr/bin');
		assert.strictEqual(shellEnv.SHELL, '/bin/zsh');
		assert.strictEqual(shellEnv.VSCODE_CWD, '/workspace');

		assert.strictEqual(global.process.type, 'renderer');
		assert.strictEqual(global.global, globalThis);
	});

	test('context.resolveConfiguration applies folder/workspace query and ew reset', async () => {
		createWindow('?folder=%2Ftmp%2Fmy%20folder');
		const folderHost = createHost();
		await sandboxModule.installDesktopSandbox(folderHost.host);
		const folderConfig = await global.window.vscode.context.resolveConfiguration();
		assert.ok(folderConfig.workspace);
		assert.strictEqual(folderConfig.workspace.uri.scheme, 'file');
		assert.strictEqual(folderConfig.workspace.uri.path, '/tmp/my folder');
		assert.strictEqual(typeof folderConfig.workspace.id, 'string');
		assert.ok(folderConfig.workspace.id.length > 0);

		createWindow('?workspace=https%3A%2F%2Fexample.com%2Fproj.code-workspace%3Fa%3D1%23frag');
		const workspaceHost = createHost();
		await sandboxModule.installDesktopSandbox(workspaceHost.host);
		const workspaceConfig = await global.window.vscode.context.resolveConfiguration();
		assert.strictEqual(workspaceConfig.workspace.configPath.scheme, 'https');
		assert.strictEqual(workspaceConfig.workspace.configPath.authority, 'example.com');
		assert.strictEqual(workspaceConfig.workspace.configPath.path, '/proj.code-workspace');
		assert.strictEqual(workspaceConfig.workspace.configPath.query, 'a=1');
		assert.strictEqual(workspaceConfig.workspace.configPath.fragment, 'frag');

		createWindow('?ew=true');
		const ewHost = createHost({
			workspace: {
				id: 'old',
				uri: { scheme: 'file', path: '/tmp/old' }
			}
		});
		await sandboxModule.installDesktopSandbox(ewHost.host);
		const ewConfig = await global.window.vscode.context.resolveConfiguration();
		assert.strictEqual(Object.prototype.hasOwnProperty.call(ewConfig, 'workspace'), false);
	});

	test('process platform/arch parsing and resolveWindowConfig caching are stable', async () => {
		createWindow('');
		const mock = createHost({
			os: { platform: 'windows', arch: 'aarch64' },
			execPath: '/tmp/custom-code'
		});
		await sandboxModule.installDesktopSandbox(mock.host);
		const vscode = global.window.vscode;

		assert.strictEqual(vscode.process.platform, 'win32');
		assert.strictEqual(vscode.process.arch, 'arm64');
		assert.strictEqual(vscode.process.execPath, '/tmp/custom-code');

		await vscode.context.resolveConfiguration();
		await vscode.process.shellEnv();
		await vscode.context.resolveConfiguration();
		assert.strictEqual(mock.getResolveCount(), 1);
	});

	test('context.resolveConfiguration keeps zoom level in sync with webFrame setter', async () => {
		createWindow('');
		const mock = createHost({
			zoomLevel: 3
		});
		await sandboxModule.installDesktopSandbox(mock.host);
		const vscode = global.window.vscode;

		const firstConfig = await vscode.context.resolveConfiguration();
		assert.strictEqual(firstConfig.zoomLevel, 3);

		vscode.webFrame.setZoomLevel(7);
		const secondConfig = await vscode.context.resolveConfiguration();
		assert.strictEqual(secondConfig.zoomLevel, 7);
	});

	test('process env external endpoint is not injected when window origin is null', async () => {
		createWindow('');
		global.window.location.origin = 'null';
		const mock = createHost();
		await sandboxModule.installDesktopSandbox(mock.host);
		const vscode = global.window.vscode;

		assert.strictEqual(
			Object.prototype.hasOwnProperty.call(vscode.process.env, 'VSCODE_TAURI_WEBVIEW_EXTERNAL_ENDPOINT'),
			false
		);
	});

	test('ipcRenderer send/invoke bridge validates channels and routes correctly', async () => {
		createWindow('');
		const mock = createHost();
		await sandboxModule.installDesktopSandbox(mock.host);
		const vscode = global.window.vscode;

		assert.throws(
			() => vscode.ipcRenderer.send('bad-channel'),
			/Unsupported event IPC channel/
		);

		vscode.ipcRenderer.send('vscode:disconnect');
		assert.strictEqual(mock.channelCalls.length, 0);

		vscode.ipcRenderer.send('vscode:testSend', 1, { ok: true });
		assert.deepStrictEqual(mock.channelCalls[0], {
			channel: '__ipcSend__',
			method: 'vscode:testSend',
			args: [1, { ok: true }]
		});

		const shell = await vscode.ipcRenderer.invoke('vscode:fetchShellEnv');
		assert.deepStrictEqual(shell, { PATH: '/usr/bin', SHELL: '/bin/zsh' });
		assert.strictEqual(mock.methodCalls[0].method, 'process.env');

		await vscode.ipcRenderer.invoke('vscode:testInvoke', 9);
		assert.deepStrictEqual(mock.channelCalls[1], {
			channel: '__ipcInvoke__',
			method: 'vscode:testInvoke',
			args: [9]
		});
	});

	test('ipcRenderer on/once/remove and menubar bridge events are normalized', async () => {
		createWindow('');
		const mock = createHost();
		await sandboxModule.installDesktopSandbox(mock.host);
		const vscode = global.window.vscode;

		/** @type {unknown[][]} */
		const pingEvents = [];
		vscode.ipcRenderer.on('vscode:ping', (_event, ...args) => {
			pingEvents.push(args);
		});

		const ipcEvent = mock.listeners.get('__ipc:event');
		assert.ok(ipcEvent);
		ipcEvent({ channel: 'vscode:ping', args: [1, 'two'] });
		ipcEvent({ channel: 'bad-channel', args: [3] });
		assert.deepStrictEqual(pingEvents, [[1, 'two']]);

		let onceCount = 0;
		const onceListener = () => {
			onceCount += 1;
		};
		vscode.ipcRenderer.once('vscode:once', onceListener);
		const onceEvent = mock.listeners.get('__ipc:event');
		onceEvent({ channel: 'vscode:once', args: [] });
		onceEvent({ channel: 'vscode:once', args: [] });
		assert.strictEqual(onceCount, 1);

		let removedCalled = false;
		const removedListener = () => {
			removedCalled = true;
		};
		vscode.ipcRenderer.once('vscode:removed', removedListener);
		vscode.ipcRenderer.removeListener('vscode:removed', removedListener);
		onceEvent({ channel: 'vscode:removed', args: [] });
		assert.strictEqual(removedCalled, false);

		let actionPayload;
		vscode.ipcRenderer.on('vscode:runAction', (_event, payload) => {
			actionPayload = payload;
		});
		const actionEvent = mock.listeners.get('menubar:runAction');
		assert.ok(actionEvent);
		actionEvent({ id: 'workbench.action.test' });
		assert.deepStrictEqual(actionPayload, {
			id: 'workbench.action.test',
			from: 'menu',
			args: undefined
		});

		let keybindingPayload;
		vscode.ipcRenderer.on('vscode:runKeybinding', (_event, payload) => {
			keybindingPayload = payload;
		});
		const keybindingEvent = mock.listeners.get('menubar:runKeybinding');
		assert.ok(keybindingEvent);
		keybindingEvent({ userSettingsLabel: 'cmd+k cmd+c' });
		assert.deepStrictEqual(keybindingPayload, { userSettingsLabel: 'cmd+k cmd+c' });
	});

	test('ipcMessagePort acquire validates channel and falls back for unsupported response channels', async () => {
		const { postMessages } = createWindow('');
		const mock = createHost();
		await sandboxModule.installDesktopSandbox(mock.host);
		const vscode = global.window.vscode;

		assert.throws(
			() => vscode.ipcMessagePort.acquire('bad-channel', 'nonce'),
			/Unsupported event IPC channel/
		);

		vscode.ipcMessagePort.acquire('vscode:otherResponse', 'nonce-fallback');
		assert.strictEqual(postMessages.length, 1);
		assert.deepStrictEqual(postMessages[0], ['nonce-fallback', '*', []]);
	});

	test('process event emitter helpers and webUtils fallback path behavior are stable', async () => {
		createWindow('');
		const mock = createHost();
		await sandboxModule.installDesktopSandbox(mock.host);
		const vscode = global.window.vscode;

		let onCount = 0;
		const onListener = () => {
			onCount += 1;
		};
		vscode.process.on('custom', onListener);
		assert.strictEqual(vscode.process.emit('custom'), true);
		vscode.process.off('custom', onListener);
		assert.strictEqual(vscode.process.emit('custom'), false);
		assert.strictEqual(onCount, 1);

		let onceCount = 0;
		vscode.process.once('once-custom', () => {
			onceCount += 1;
		});
		vscode.process.emit('once-custom');
		vscode.process.emit('once-custom');
		assert.strictEqual(onceCount, 1);

		let nextTickValue = 0;
		await new Promise(resolve => {
			vscode.process.nextTick((value) => {
				nextTickValue = value;
				resolve(undefined);
			}, 7);
		});
		assert.strictEqual(nextTickValue, 7);

		const memoryInfo = await vscode.process.getProcessMemoryInfo();
		assert.strictEqual(typeof memoryInfo.private, 'number');
		assert.strictEqual(typeof memoryInfo.residentSet, 'number');
		assert.strictEqual(typeof memoryInfo.shared, 'number');

		const fileLike = /** @type {File & { webkitRelativePath?: string; path?: string }} */ ({
			name: 'demo.txt',
			webkitRelativePath: 'folder/demo.txt'
		});
		assert.strictEqual(vscode.webUtils.getPathForFile(fileLike), 'folder/demo.txt');
		assert.strictEqual(vscode.webUtils.getPathForFile(/** @type {File} */ ({ name: 'fallback.txt' })), 'fallback.txt');
	});
});
