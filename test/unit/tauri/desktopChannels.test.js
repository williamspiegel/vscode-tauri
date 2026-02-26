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
	});
});
