/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const assert = require('assert');
const path = require('path');

suite('Tauri Host Client', () => {
	const originalWindow = global.window;

	/** @type {typeof import('../../../../apps/tauri/ui/src/hostClient')} */
	let hostClientModule;
	/** @type {string} */
	let modulePath;

	function createBaseWindow() {
		return {
			location: {
				search: '',
				origin: 'http://127.0.0.1:1420',
				pathname: '/',
				href: 'http://127.0.0.1:1420/'
			},
			localStorage: {
				getItem() { return null; }
			}
		};
	}

	/**
	 * @param {{
	 * 	invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
	 * 	listen?: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
	 * 	internals?: {
	 * 		invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
	 * 		transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number;
	 * 		unregisterCallback: (id: number) => void;
	 * 	};
	 * }} [options]
	 */
	function loadHostClient(options = {}) {
		global.window = createBaseWindow();
		if (options.invoke || options.listen) {
			global.window.__TAURI__ = {
				core: options.invoke ? { invoke: options.invoke } : undefined,
				event: options.listen ? { listen: options.listen } : undefined
			};
		}
		if (options.internals) {
			global.window.__TAURI_INTERNALS__ = options.internals;
		}

		delete require.cache[require.resolve(modulePath)];
		hostClientModule = require(modulePath);
	}

	/**
	 * @param {{ id: number }} request
	 * @param {Record<string, unknown>} payload
	 */
	function jsonRpcResponse(request, payload) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			...payload
		};
	}

	setup(() => {
		const compiledUiRoot = process.env.TAURI_UI_TEST_BUILD_DIR;
		assert.ok(compiledUiRoot, 'TAURI_UI_TEST_BUILD_DIR must be set by harness');
		modulePath = path.join(compiledUiRoot, 'hostClient.js');
		loadHostClient();
	});

	teardown(() => {
		if (typeof originalWindow === 'undefined') {
			delete global.window;
		} else {
			global.window = originalWindow;
		}
	});

	test('getWorkbenchCssModules rejects invalid host payloads with a stable error', async () => {
		for (const result of [null, { modules: ['ok.css', 7] }]) {
			loadHostClient({
				invoke: async (_command, args) => {
					const request = args.request;
					assert.strictEqual(request.method, 'host.cssModules');
					return jsonRpcResponse(request, { result });
				}
			});

			const client = new hostClientModule.HostClient();
			await assert.rejects(
				client.getWorkbenchCssModules(),
				/Host returned an invalid workbench CSS module payload/
			);
		}
	});

	test('handshake sends the expected protocol request and returns the host payload', async () => {
		loadHostClient({
			invoke: async (_command, args) => {
				const request = args.request;
				assert.strictEqual(request.method, 'protocol.handshake');
				assert.strictEqual(request.params.protocolVersion, '1.0.0');
				assert.strictEqual(request.params.clientName, 'vscode-tauri-ui');
				assert.strictEqual(request.params.clientVersion, '0.1.0');
				assert.ok(Array.isArray(request.params.requestedCapabilities));
				assert.ok(request.params.requestedCapabilities.length > 0);
				return jsonRpcResponse(request, {
					result: {
						protocolVersion: '1.0.0',
						serverName: 'vscode-tauri-host',
						serverVersion: '0.1.0',
						supportedCapabilities: ['desktopChannels']
					}
				});
			}
		});

		const client = new hostClientModule.HostClient();
		const result = await client.handshake();
		assert.deepStrictEqual(result, {
			protocolVersion: '1.0.0',
			serverName: 'vscode-tauri-host',
			serverVersion: '0.1.0',
			supportedCapabilities: ['desktopChannels']
		});
	});

	test('invokeMethod rejects unknown methods before sending a host request', async () => {
		let invokeCalls = 0;
		loadHostClient({
			invoke: async () => {
				invokeCalls += 1;
				return {};
			}
		});

		const client = new hostClientModule.HostClient();
		await assert.rejects(
			client.invokeMethod('desktop.notReal', {}),
			/Unknown host method: desktop\.notReal/
		);
		assert.strictEqual(invokeCalls, 0);
	});

	test('invokeMethod wraps transport failures with method context', async () => {
		loadHostClient({
			invoke: async (_command, args) => {
				const request = args.request;
				assert.strictEqual(request.method, 'host.httpRequest');
				throw new Error('socket closed');
			}
		});

		const client = new hostClientModule.HostClient();
		await assert.rejects(
			client.httpRequest({ url: 'https://example.test' }),
			/host_invoke transport failed for host\.httpRequest: Error \| socket closed/
		);
	});

	test('invokeMethod rejects malformed JSON-RPC envelopes before reading response fields', async () => {
		loadHostClient({
			invoke: async () => null
		});

		const client = new hostClientModule.HostClient();
		await assert.rejects(
			client.getFallbackCounts(),
			/Invalid JSON-RPC envelope for method host\.fallbackCounts/
		);
	});

	test('invokeMethod normalizes malformed host error payloads into stable error text', async () => {
		loadHostClient({
			invoke: async (_command, args) => {
				const request = args.request;
				assert.strictEqual(request.method, 'host.fallbackCounts');
				return jsonRpcResponse(request, {
					error: 'host exploded'
				});
			}
		});

		const client = new hostClientModule.HostClient();
		await assert.rejects(
			client.getFallbackCounts(),
			/Host error in host\.fallbackCounts \(unknown\): host exploded/
		);
	});

	test('resolveWindowConfig retries after failure and caches the first successful payload', async () => {
		let resolveCalls = 0;
		loadHostClient({
			invoke: async (_command, args) => {
				const request = args.request;
				assert.strictEqual(request.method, 'desktop.resolveWindowConfig');
				resolveCalls += 1;

				if (resolveCalls === 1) {
					return jsonRpcResponse(request, {
						error: {
							code: -32000,
							message: 'transient failure'
						}
					});
				}

				return jsonRpcResponse(request, {
					result: {
						windowId: 9,
						userEnv: { VSCODE_CWD: '/workspace' }
					}
				});
			}
		});

		const client = new hostClientModule.HostClient();
		await assert.rejects(
			client.resolveWindowConfig(),
			/Host error in desktop\.resolveWindowConfig/
		);

		const second = await client.resolveWindowConfig();
		const third = await client.resolveWindowConfig();
		assert.deepStrictEqual(second, {
			windowId: 9,
			userEnv: { VSCODE_CWD: '/workspace' }
		});
		assert.strictEqual(third, second);
		assert.strictEqual(resolveCalls, 2);
	});

	test('desktopChannelListen buffers pre-registration events, normalizes payloads, and unlistens cleanly', async () => {
		/** @type {((event: { payload: unknown }) => void) | undefined} */
		let desktopEventListener;
		/** @type {string[]} */
		const methods = [];
		loadHostClient({
			invoke: async (_command, args) => {
				const request = args.request;
				methods.push(request.method);

				if (request.method === 'desktop.channelListen') {
					assert.ok(desktopEventListener, 'desktop.channelEvent listener should be registered first');
					desktopEventListener({
						payload: {
							subscriptionId: 'sub-1',
							channel: 'storage',
							event: 'onDidChangeStorage',
							payload: {
								changed: ['alpha'],
								deleted: 'invalid'
							}
						}
					});
					return jsonRpcResponse(request, {
						result: { subscriptionId: 'sub-1' }
					});
				}

				if (request.method === 'desktop.channelUnlisten') {
					assert.deepStrictEqual(request.params, { subscriptionId: 'sub-1' });
					return jsonRpcResponse(request, { result: null });
				}

				throw new Error(`Unexpected method ${request.method}`);
			},
			listen: async (event, handler) => {
				assert.strictEqual(event, 'desktop_channel_event');
				desktopEventListener = handler;
				return async () => undefined;
			}
		});

		const client = new hostClientModule.HostClient();
		/** @type {unknown[]} */
		const seen = [];
		const stop = await client.desktopChannelListen('storage', 'onDidChangeStorage', undefined, payload => {
			seen.push(payload);
		});

		assert.deepStrictEqual(seen, [{
			changed: ['alpha'],
			deleted: []
		}]);

		await stop();
		assert.deepStrictEqual(methods, ['desktop.channelListen', 'desktop.channelUnlisten']);
	});

	test('desktopChannelListen fails fast when the desktop event bridge is unavailable', async () => {
		let invokeCalls = 0;
		loadHostClient({
			invoke: async (_command, args) => {
				invokeCalls += 1;
				return jsonRpcResponse(args.request, { result: {} });
			}
		});

		const client = new hostClientModule.HostClient();
		await assert.rejects(
			client.desktopChannelListen('storage', 'onDidChangeStorage', undefined, () => undefined),
			/desktop\.channelEvent listener is unavailable/
		);
		assert.strictEqual(invokeCalls, 0);
	});

	test('desktopChannelListen rejects invalid subscription payloads with a stable error', async () => {
		loadHostClient({
			invoke: async (_command, args) => {
				const request = args.request;
				assert.strictEqual(request.method, 'desktop.channelListen');
				return jsonRpcResponse(request, { result: null });
			},
			listen: async () => async () => undefined
		});

		const client = new hostClientModule.HostClient();
		await assert.rejects(
			client.desktopChannelListen('storage', 'onDidChangeStorage', undefined, () => undefined),
			/desktop\.channelListen returned an invalid subscription id/
		);
	});

	test('listenEvent falls back to Tauri internals and sanitizes mapped event names', async () => {
		/** @type {((payload: unknown) => void) | undefined} */
		let transformedCallback;
		/** @type {{ command: string; args?: Record<string, unknown> }[]} */
		const commands = [];
		/** @type {number | undefined} */
		let unregisteredId;
		loadHostClient({
			internals: {
				invoke: async (command, args) => {
					commands.push({ command, args });

					if (command === 'plugin:event|listen') {
						return 77;
					}

					if (command === 'plugin:event|unlisten') {
						return null;
					}

					throw new Error(`Unexpected command ${command}`);
				},
				transformCallback: (callback) => {
					transformedCallback = callback;
					return 12;
				},
				unregisterCallback: (id) => {
					unregisteredId = id;
				}
			}
		});

		const client = new hostClientModule.HostClient();
		let seenPayload;
		const stop = await client.listenEvent('filesystem.changed', payload => {
			seenPayload = payload;
		});

		assert.deepStrictEqual(commands[0], {
			command: 'plugin:event|listen',
			args: {
				event: 'filesystem_changed',
				target: { kind: 'Any' },
				handler: 12
			}
		});

		assert.ok(transformedCallback, 'transformCallback should receive the native event bridge callback');
		transformedCallback({ payload: [{ path: '/tmp/example' }] });
		assert.deepStrictEqual(seenPayload, [{ path: '/tmp/example' }]);

		await stop();
		assert.deepStrictEqual(commands[1], {
			command: 'plugin:event|unlisten',
			args: {
				event: 'filesystem_changed',
				eventId: 77
			}
		});
		assert.strictEqual(unregisteredId, 12);
	});

	test('listenEvent wraps underlying listen failures with the original and mapped event names', async () => {
		loadHostClient({
			listen: async (event) => {
				assert.strictEqual(event, 'desktop_channel_event');
				throw new Error('permission denied');
			},
			invoke: async () => {
				throw new Error('invoke should not be used');
			}
		});

		const client = new hostClientModule.HostClient();
		await assert.rejects(
			client.listenEvent('desktop.channelEvent', () => undefined),
			/Failed to listen to host event 'desktop\.channelEvent' as 'desktop_channel_event': permission denied/
		);
	});
});
