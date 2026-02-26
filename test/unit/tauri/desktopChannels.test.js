/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const assert = require('assert');
const path = require('path');

suite('Tauri Desktop Channels', () => {
	/** @type {typeof import('../../../../apps/tauri/ui/src/desktopChannels')} */
	let desktopChannelsModule;

	setup(() => {
		const compiledUiRoot = process.env.TAURI_UI_TEST_BUILD_DIR;
		assert.ok(compiledUiRoot, 'TAURI_UI_TEST_BUILD_DIR must be set by harness');

		global.window = {
			location: {
				search: '',
				origin: 'http://127.0.0.1:1420',
				pathname: '/',
				href: 'http://127.0.0.1:1420/'
			},
			localStorage: {
				getItem() { return null; }
			},
			open() {
				return null;
			}
		};

		desktopChannelsModule = require(path.join(compiledUiRoot, 'desktopChannels.js'));
	});

	test('registry exposes expected channel membership', () => {
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);
		assert.strictEqual(registry.has('nativeHost'), true);
		assert.strictEqual(registry.has('localFilesystem'), true);
		assert.strictEqual(registry.has('notARealChannel'), false);
	});

	test('call normalizes getInstalled + update initial state fallback', async () => {
		const host = {
			desktopChannelCall: async (_channel, method) => {
				if (method === 'getInstalled') {
					return { invalid: true };
				}
				return undefined;
			},
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const installed = await registry.call('extensions', 'getInstalled', []);
		assert.deepStrictEqual(installed, []);

		const updateInitialState = await registry.call('update', '_getInitialState', []);
		assert.deepStrictEqual(updateInitialState, { type: 'uninitialized' });
	});

	test('call normalizes userDataSync and store management fallback payloads', async () => {
		const host = {
			desktopChannelCall: async (_channel, method) => {
				if (method === '_getInitialData') {
					return ['bad-state', 'not-an-array', 'not-a-number'];
				}
				if (method === 'getPreviousUserDataSyncStore') {
					return { invalid: true };
				}
				return undefined;
			},
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const initialData = await registry.call('userDataSync', '_getInitialData', []);
		assert.deepStrictEqual(initialData, ['bad-state', [], undefined]);

		const syncStore = await registry.call('userDataSyncStoreManagement', 'getPreviousUserDataSyncStore', []);
		assert.strictEqual(syncStore.type, 'stable');
		assert.strictEqual(syncStore.canSwitch, false);
		assert.deepStrictEqual(syncStore.authenticationProviders, {});
		assert.strictEqual(syncStore.url.scheme, 'file');
		assert.strictEqual(syncStore.url.path, '/.vscode-tauri/user-data/sync');
	});

	test('call normalizes mcpManagement installed payload and userDataSync hard fallback shape', async () => {
		const host = {
			desktopChannelCall: async (_channel, method) => {
				if (method === 'getInstalled') {
					return { invalid: true };
				}
				if (method === '_getInitialData') {
					return 'not-an-array';
				}
				return undefined;
			},
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const installed = await registry.call('mcpManagement', 'getInstalled', []);
		assert.deepStrictEqual(installed, []);

		const syncInitial = await registry.call('userDataSync', '_getInitialData', []);
		assert.deepStrictEqual(syncInitial, ['uninitialized', [], undefined]);
	});

	test('call normalizes externalTerminal defaults and localFilesystem stat/readFile fallbacks', async () => {
		const host = {
			desktopChannelCall: async (_channel, method) => {
				if (method === 'getDefaultTerminalForPlatforms') {
					return { linux: 42 };
				}
				if (method === 'stat') {
					return {};
				}
				if (method === 'readFile') {
					return null;
				}
				return undefined;
			},
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const defaults = await registry.call('externalTerminal', 'getDefaultTerminalForPlatforms', []);
		assert.deepStrictEqual(defaults, {
			windows: 'cmd.exe',
			linux: 'xterm',
			osx: 'Terminal.app'
		});

		const stat = await registry.call('localFilesystem', 'stat', [{ path: '/tmp/example.txt' }]);
		assert.strictEqual(stat.type, 1);
		assert.strictEqual(stat.size, 0);

		const readFile = await registry.call('localFilesystem', 'readFile', [{ path: '/tmp/missing.bin' }]);
		assert.strictEqual(readFile.buffer instanceof Uint8Array, true);
		assert.strictEqual(readFile.buffer.byteLength, 0);
	});

	test('call normalizes extensionHostStarter and userDataSyncAccount payloads', async () => {
		const host = {
			desktopChannelCall: async (_channel, method) => {
				if (method === 'createExtensionHost') {
					return { id: 'dynamic-host-1', ignored: true };
				}
				if (method === 'start') {
					return { pid: 1234, extra: true };
				}
				if (method === '_getInitialData') {
					return 'invalid';
				}
				if (method === 'updateAccount') {
					return { changed: true };
				}
				return undefined;
			},
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const extensionHost = await registry.call('extensionHostStarter', 'createExtensionHost', []);
		assert.deepStrictEqual(extensionHost, { id: 'dynamic-host-1' });

		const startResult = await registry.call('extensionHostStarter', 'start', []);
		assert.deepStrictEqual(startResult, { pid: 1234 });

		const syncAccountInitial = await registry.call('userDataSyncAccount', '_getInitialData', []);
		assert.strictEqual(syncAccountInitial, undefined);

		const updateAccountResult = await registry.call('userDataSyncAccount', 'updateAccount', []);
		assert.strictEqual(updateAccountResult, undefined);
	});

	test('call normalizes extension manifests and queryLocal fallback payloads', async () => {
		const host = {
			desktopChannelCall: async (_channel, method) => {
				if (method === 'getExtensionsControlManifest') {
					return {
						malicious: 'invalid',
						deprecated: [],
						search: 'invalid',
						autoUpdate: null
					};
				}
				if (method === 'queryLocal') {
					return undefined;
				}
				return undefined;
			},
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const manifest = await registry.call('extensions', 'getExtensionsControlManifest', []);
		assert.deepStrictEqual(manifest, {
			malicious: [],
			deprecated: {},
			search: [],
			autoUpdate: {}
		});

		const queryLocal = await registry.call('extensions', 'queryLocal', []);
		assert.deepStrictEqual(queryLocal, []);
	});

	test('call normalizes localPty default payloads', async () => {
		const host = {
			desktopChannelCall: async (_channel, method) => {
				if (method === 'getDefaultSystemShell') {
					return 42;
				}
				if (method === 'getEnvironment') {
					return 'invalid';
				}
				if (method === 'getShellEnvironment') {
					return null;
				}
				return 'invalid';
			},
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const marks = await registry.call('localPty', 'getPerformanceMarks', []);
		assert.deepStrictEqual(marks, []);

		const latency = await registry.call('localPty', 'getLatency', []);
		assert.deepStrictEqual(latency, []);

		const profiles = await registry.call('localPty', 'getProfiles', []);
		assert.deepStrictEqual(profiles, []);

		const shell = await registry.call('localPty', 'getDefaultSystemShell', []);
		assert.strictEqual(shell, '/bin/zsh');

		const env = await registry.call('localPty', 'getEnvironment', []);
		assert.deepStrictEqual(env, {});

		const shellEnv = await registry.call('localPty', 'getShellEnvironment', []);
		assert.deepStrictEqual(shellEnv, {});
	});

	test('call handles nativeHost picker cancellation without navigation', async () => {
		const initialHref = global.window.location.href;
		const host = {
			desktopChannelCall: async () => ({ canceled: true }),
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const result = await registry.call('nativeHost', 'pickFolderAndOpen', [{}]);
		assert.strictEqual(result, null);
		assert.strictEqual(global.window.location.href, initialHref);
	});

	test('call navigates to selected folder on nativeHost pickFolderAndOpen', async () => {
		const host = {
			desktopChannelCall: async () => ({ filePaths: ['/tmp/example-folder'] }),
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const result = await registry.call('nativeHost', 'pickFolderAndOpen', [{}]);
		assert.strictEqual(result, null);
		assert.match(global.window.location.href, /\?folder=%2Ftmp%2Fexample-folder$/);
	});

	test('call opens workspace in new window when forced and supported', async () => {
		const initialHref = global.window.location.href;
		let openedUrl;
		global.window.open = (url) => {
			openedUrl = String(url);
			return {};
		};

		const host = {
			desktopChannelCall: async () => ({ filePath: '/tmp/project.code-workspace' }),
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const result = await registry.call('nativeHost', 'pickFileFolderAndOpen', [{ forceNewWindow: true }]);
		assert.strictEqual(result, null);
		assert.match(openedUrl, /\?workspace=%2Ftmp%2Fproject\.code-workspace$/);
		assert.strictEqual(global.window.location.href, initialHref);
	});

	test('call falls back to current-window navigation when new window open fails or is reused', async () => {
		global.window.open = () => null;
		const host = {
			desktopChannelCall: async () => ({ filePaths: ['/tmp/project-folder'] }),
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const result = await registry.call('nativeHost', 'pickFolderAndOpen', [{ forceNewWindow: true }]);
		assert.strictEqual(result, null);
		assert.match(global.window.location.href, /\?folder=%2Ftmp%2Fproject-folder$/);

		global.window.location.href = 'http://127.0.0.1:1420/';
		await registry.call('nativeHost', 'pickFolderAndOpen', [{ forceNewWindow: true, forceReuseWindow: true }]);
		assert.match(global.window.location.href, /\?folder=%2Ftmp%2Fproject-folder$/);
	});

	test('call maps localFilesystem host errors to FileSystemError names', async () => {
		const host = {
			desktopChannelCall: async () => {
				throw new Error('ENOENT: No such file or directory');
			},
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		await assert.rejects(
			registry.call('localFilesystem', 'stat', [{ path: '/missing/file.txt' }]),
			/** @param {Error} err */
			err => {
				assert.strictEqual(err.name, 'EntryNotFound (FileSystemError)');
				return true;
			}
		);
	});

	test('call maps additional localFilesystem host errors to FileSystemError names', async () => {
		const scenarios = [
			{ message: 'EEXIST: File exists', name: 'EntryExists (FileSystemError)' },
			{ message: 'ENOTDIR: Not a directory', name: 'EntryNotADirectory (FileSystemError)' },
			{ message: 'EISDIR: Is a directory', name: 'EntryIsADirectory (FileSystemError)' },
			{ message: 'EACCES: Permission denied', name: 'NoPermissions (FileSystemError)' }
		];

		for (const scenario of scenarios) {
			const host = {
				desktopChannelCall: async () => {
					throw new Error(scenario.message);
				},
				desktopChannelListen: async () => async () => undefined
			};
			const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

			await assert.rejects(
				registry.call('localFilesystem', 'stat', [{ path: '/tmp/file' }]),
				/** @param {Error} err */
				err => {
					assert.strictEqual(err.name, scenario.name);
					return true;
				}
			);
		}
	});

	test('listen normalizes storage profile payloads', async () => {
		/** @type {((payload: unknown) => void)[]} */
		const listeners = [];
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async (_channel, _event, _arg, onEvent) => {
				listeners.push(onEvent);
				return async () => undefined;
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		let seen;
		await registry.listen('storage', 'onDidChangeStorage', undefined, payload => {
			seen = payload;
		});
		listeners[0]({ changed: ['alpha'], deleted: 'invalid' });
		assert.deepStrictEqual(seen, { changed: ['alpha'], deleted: [] });

		let profileSeen;
		await registry.listen('userDataProfiles', 'onDidChangeProfiles', undefined, payload => {
			profileSeen = payload;
		});
		listeners[1]({ all: ['a'], added: 'bad', removed: ['r'], updated: ['u'] });
		assert.deepStrictEqual(profileSeen, {
			all: ['a'],
			added: [],
			removed: ['r'],
			updated: ['u']
		});
	});

	test('localFilesystem read normalizes byte payloads', async () => {
		const host = {
			desktopChannelCall: async () => [{ base64: 'aGk=' }],
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const result = await registry.call('localFilesystem', 'read', [{ path: '/tmp/test.bin' }]);
		assert.strictEqual(Array.isArray(result), true);
		assert.deepStrictEqual(Array.from(result[0].buffer), [104, 105]);
		assert.strictEqual(result[1], 2);
	});

	test('localFilesystem read normalizes Buffer-like data and preserves explicit bytesRead', async () => {
		const host = {
			desktopChannelCall: async () => [{ buffer: { type: 'Buffer', data: [1, 2, 3, 4] } }, 99],
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const result = await registry.call('localFilesystem', 'read', [{ path: '/tmp/test-buffer.bin' }]);
		assert.deepStrictEqual(Array.from(result[0].buffer), [1, 2, 3, 4]);
		assert.strictEqual(result[1], 99);
	});

	test('localFilesystem read normalizes array-like numeric keyed payloads', async () => {
		const host = {
			desktopChannelCall: async () => [{ buffer: { 0: 65, 1: 66, length: 2 } }],
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const result = await registry.call('localFilesystem', 'read', [{ path: '/tmp/test-arraylike.bin' }]);
		assert.deepStrictEqual(Array.from(result[0].buffer), [65, 66]);
		assert.strictEqual(result[1], 2);
	});

	test('localFilesystem readFile accepts direct byte array payloads', async () => {
		const host = {
			desktopChannelCall: async () => [9, 8, 7],
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const readFile = await registry.call('localFilesystem', 'readFile', [{ path: '/tmp/raw-bytes.bin' }]);
		assert.deepStrictEqual(Array.from(readFile.buffer), [9, 8, 7]);
	});

	test('localFilesystem stat infers directory type from path hint', async () => {
		const host = {
			desktopChannelCall: async () => ({}),
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		const stat = await registry.call('localFilesystem', 'stat', [{ path: '/tmp/folder/' }]);
		assert.strictEqual(stat.type, 2);
	});

	test('localFilesystem readFile maps decode failures to FileSystemError', async () => {
		const host = {
			desktopChannelCall: async () => ({ unexpected: true }),
			desktopChannelListen: async () => async () => undefined
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		await assert.rejects(
			registry.call('localFilesystem', 'readFile', [{ path: '/tmp/unreadable.bin' }]),
			/** @param {Error} err */
			err => {
				assert.strictEqual(err.name, 'Unknown (FileSystemError)');
				assert.match(err.message, /Unable to decode localFilesystem\.readFile payload/);
				return true;
			}
		);
	});

	test('localFilesystem readFileStream decodes chunks and emits end once', async () => {
		/** @type {(payload: unknown) => void} */
		let streamListener = () => undefined;
		let stopped = false;
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async (_channel, _event, _arg, onEvent) => {
				streamListener = onEvent;
				return async () => {
					stopped = true;
				};
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);
		/** @type {unknown[]} */
		const seen = [];
		const stop = await registry.listen('localFilesystem', 'readFileStream', { path: '/tmp/stream.bin' }, payload => {
			seen.push(payload);
		});

		streamListener({ base64: 'aGk=' });
		streamListener('end');
		streamListener({ base64: 'YQ==' });

		assert.strictEqual(seen.length, 2);
		assert.deepStrictEqual(Array.from(seen[0]), [104, 105]);
		assert.strictEqual(seen[1], 'end');

		await stop();
		assert.strictEqual(stopped, true);
	});

	test('localFilesystem readFileStream listen errors map to FileSystemError', async () => {
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async () => {
				throw new Error('ENOENT: stream source does not exist');
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);
		/** @type {unknown[]} */
		const seen = [];
		await registry.listen('localFilesystem', 'readFileStream', { path: '/tmp/missing.bin' }, payload => {
			seen.push(payload);
		});

		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].name, 'EntryNotFound (FileSystemError)');
	});

	test('localFilesystem readFileStream maps structured error payloads once', async () => {
		/** @type {(payload: unknown) => void} */
		let streamListener = () => undefined;
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async (_channel, _event, _arg, onEvent) => {
				streamListener = onEvent;
				return async () => undefined;
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);
		/** @type {unknown[]} */
		const seen = [];

		await registry.listen('localFilesystem', 'readFileStream', { path: '/tmp/error-stream.bin' }, payload => {
			seen.push(payload);
		});
		streamListener({ message: 'stream failed', name: 'StreamFailure', code: 'EIO' });
		streamListener({ base64: 'aGk=' });

		assert.strictEqual(seen.length, 1);
		assert.deepStrictEqual(seen[0], {
			message: 'stream failed',
			name: 'StreamFailure',
			code: 'EIO'
		});
	});

	test('localFilesystem readFileStream maps invalid payloads to FileSystemError', async () => {
		/** @type {(payload: unknown) => void} */
		let streamListener = () => undefined;
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async (_channel, _event, _arg, onEvent) => {
				streamListener = onEvent;
				return async () => undefined;
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);
		/** @type {unknown[]} */
		const seen = [];

		await registry.listen('localFilesystem', 'readFileStream', { path: '/tmp/invalid-stream.bin' }, payload => {
			seen.push(payload);
		});
		streamListener({ nope: true });
		streamListener({ base64: 'aGk=' });

		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].name, 'Unknown (FileSystemError)');
		assert.match(seen[0].message, /Invalid readFileStream payload from host/);
	});

	test('listen normalizes watcher and extension host events', async () => {
		/** @type {((payload: unknown) => void)[]} */
		const listeners = [];
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async (_channel, _event, _arg, onEvent) => {
				listeners.push(onEvent);
				return async () => undefined;
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		let watcherLog;
		await registry.listen('watcher', 'onDidLogMessage', undefined, payload => {
			watcherLog = payload;
		});
		listeners[0]('from-host-string');
		assert.deepStrictEqual(watcherLog, { type: 'trace', message: 'from-host-string' });

		let watcherError;
		await registry.listen('watcher', 'onDidError', undefined, payload => {
			watcherError = payload;
		});
		listeners[1]({ message: 'watch failed', request: { path: '/tmp/watched' } });
		assert.deepStrictEqual(watcherError, {
			error: 'watch failed',
			request: { path: '/tmp/watched' }
		});

		let messagePortFrame;
		await registry.listen('extensionHostStarter', 'onDynamicMessagePortFrame', undefined, payload => {
			messagePortFrame = payload;
		});
		listeners[2]({ base64: 'aGk=' });
		assert.deepStrictEqual(Array.from(messagePortFrame), [104, 105]);

		let dynamicExit;
		await registry.listen('extensionHostStarter', 'onDynamicExit', undefined, payload => {
			dynamicExit = payload;
		});
		listeners[3]({ signal: 9 });
		assert.deepStrictEqual(dynamicExit, { code: 0, signal: '' });

		let foundInFrame;
		await registry.listen('webview', 'onFoundInFrame', undefined, payload => {
			foundInFrame = payload;
		});
		listeners[4]({ requestId: 'bad', matches: 5 });
		assert.deepStrictEqual(foundInFrame, {
			requestId: 0,
			activeMatchOrdinal: 0,
			matches: 5,
			finalUpdate: true
		});
	});

	test('listen normalizes nativeHost sync mcp extension and debug events', async () => {
		/** @type {((payload: unknown) => void)[]} */
		const listeners = [];
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async (_channel, _event, _arg, onEvent) => {
				listeners.push(onEvent);
				return async () => undefined;
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);

		let alwaysOnTop;
		await registry.listen('nativeHost', 'onDidChangeWindowAlwaysOnTop', undefined, payload => {
			alwaysOnTop = payload;
		});
		listeners[0]({});
		assert.deepStrictEqual(alwaysOnTop, { windowId: 1, alwaysOnTop: false });

		let colorScheme;
		await registry.listen('nativeHost', 'onDidChangeColorScheme', undefined, payload => {
			colorScheme = payload;
		});
		listeners[1]({ dark: true });
		assert.deepStrictEqual(colorScheme, { dark: true, highContrast: false });

		let syncConflicts;
		await registry.listen('userDataSync', 'onDidChangeConflicts', undefined, payload => {
			syncConflicts = payload;
		});
		listeners[2]({ invalid: true });
		assert.deepStrictEqual(syncConflicts, []);

		let syncErrors;
		await registry.listen('userDataSync', 'onSyncErrors', undefined, payload => {
			syncErrors = payload;
		});
		listeners[3]('not-array');
		assert.deepStrictEqual(syncErrors, []);

		let mcpInstallEvent;
		await registry.listen('mcpManagement', 'onInstallMcpServer', undefined, payload => {
			mcpInstallEvent = payload;
		});
		listeners[4]('invalid');
		assert.deepStrictEqual(mcpInstallEvent, {});

		let extensionInstallDone;
		await registry.listen('extensions', 'onDidInstallExtensions', undefined, payload => {
			extensionInstallDone = payload;
		});
		listeners[5]('invalid');
		assert.deepStrictEqual(extensionInstallDone, []);

		let debugAttach;
		await registry.listen('extensionhostdebugservice', 'attach', undefined, payload => {
			debugAttach = payload;
		});
		listeners[6](null);
		assert.deepStrictEqual(debugAttach, { sessionId: '', port: 0 });
	});

	test('listen applies event-name fallback normalizers even for unknown channels', async () => {
		/** @type {(payload: unknown) => void} */
		let eventListener = () => undefined;
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async (_channel, _event, _arg, onEvent) => {
				eventListener = onEvent;
				return async () => undefined;
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);
		let seen;

		await registry.listen('notARealChannel', 'onDidChangeStorage', undefined, payload => {
			seen = payload;
		});
		eventListener({ changed: 'bad', deleted: ['ok'] });
		assert.deepStrictEqual(seen, { changed: [], deleted: ['ok'] });
	});

	test('listen returns noop when host listener registration fails', async () => {
		const host = {
			desktopChannelCall: async () => undefined,
			desktopChannelListen: async () => {
				throw new Error('listener unavailable');
			}
		};
		const registry = desktopChannelsModule.createDesktopChannelRegistry(host);
		let observed = false;
		const stop = await registry.listen('watcher', 'onDidError', undefined, () => {
			observed = true;
		});

		await stop();
		assert.strictEqual(observed, false);
	});
});
