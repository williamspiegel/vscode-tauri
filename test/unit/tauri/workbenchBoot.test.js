/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

suite('Tauri Workbench Boot', () => {
	/** @type {typeof import('../../../../apps/tauri/ui/src/workbenchBoot')} */
	let workbenchBootModule;
	/** @type {string[]} */
	let tempModulePaths;

	/**
	 * @param {{
	 * 	href?: string;
	 * 	desktopChannelCall?: (channel: string, method: string, args: unknown[]) => Promise<unknown>;
	 * 	resolveWindowConfig?: () => Promise<Record<string, unknown>>;
	 * 	getWorkbenchCssModules?: () => Promise<string[]>;
	 * 	getFallbackCounts?: () => Promise<Record<string, number>>;
	 * 	openReturnsNull?: boolean;
	 * 	onCreate?: (domElement: HTMLElement, options: Record<string, unknown>) => void;
	 * }} [options]
	 */
	async function boot(options = {}) {
		const compiledUiRoot = process.env.TAURI_UI_TEST_BUILD_DIR;
		assert.ok(compiledUiRoot, 'TAURI_UI_TEST_BUILD_DIR must be set by harness');

		let capturedCreateOptions;
		const modulePath = path.join(os.tmpdir(), `tauri-workbench-module-${Date.now()}-${Math.random()}.js`);
		tempModulePaths.push(modulePath);
		global.__tauriWorkbenchCreate = (domElement, createOptions) => {
			capturedCreateOptions = createOptions;
			if (typeof options.onCreate === 'function') {
				options.onCreate(domElement, createOptions);
			}
			return { dispose() { } };
		};
		fs.writeFileSync(
			modulePath,
			'module.exports = { create: (...args) => global.__tauriWorkbenchCreate(...args) };',
			'utf8'
		);

		const href = options.href || 'http://127.0.0.1:1420/';
		const parsed = new URL(href);
		let openedUrl;
		/** @type {unknown[]} */
		const headChildren = [];
		const documentStub = {
			head: {
				appendChild(node) {
					headChildren.push(node);
					node.parentNode = this;
					return node;
				},
				removeChild(node) {
					const index = headChildren.indexOf(node);
					if (index >= 0) {
						headChildren.splice(index, 1);
					}
				}
			},
			getElementById(id) {
				return headChildren.find(
					/** @param {any} node */
					node => node && node.id === id
				) || null;
			},
			querySelector(selector) {
				if (selector === 'script[data-vscode-css-import-map="1"]') {
					return headChildren.find(
						/** @param {any} node */
						node => node && node.tagName === 'script' && node.dataset?.vscodeCssImportMap === '1'
					) || null;
				}
				return null;
			},
			createElement(tagName) {
				if (tagName === 'style') {
					return {
						tagName,
						id: '',
						type: '',
						media: '',
						parentNode: null,
						sheet: {
							insertRule() { }
						}
					};
				}
				return {
					tagName,
					type: '',
					dataset: {},
					textContent: '',
					parentNode: null
				};
			}
		};

			global.window = {
				__VSCODE_WORKBENCH_MODULE__: modulePath,
			location: {
				href,
				origin: parsed.origin,
				pathname: parsed.pathname,
				search: parsed.search
			},
			localStorage: {
				getItem() { return null; }
				},
				open(url) {
					openedUrl = String(url);
					return options.openReturnsNull ? null : {};
				}
			};
			global.document = documentStub;

			const host = {
				resolveWindowConfig: options.resolveWindowConfig || (async () => ({
					windowId: 1,
					workspace: null
				})),
				getWorkbenchCssModules: options.getWorkbenchCssModules || (async () => []),
				getFallbackCounts: options.getFallbackCounts || (async () => ({})),
				desktopChannelCall: options.desktopChannelCall || (async () => ({ canceled: true }))
			};

		await workbenchBootModule.bootWorkbench(/** @type {HTMLElement} */({}), host);
		assert.ok(capturedCreateOptions, 'workbench create options should be captured');
		assert.ok(Array.isArray(capturedCreateOptions.commands), 'commands should be registered');

			return {
				createOptions: capturedCreateOptions,
				getOpenedUrl: () => openedUrl,
				getLocationHref: () => global.window.location.href,
				getHeadChildren: () => headChildren.slice()
			};
		}

	setup(() => {
		const compiledUiRoot = process.env.TAURI_UI_TEST_BUILD_DIR;
		assert.ok(compiledUiRoot, 'TAURI_UI_TEST_BUILD_DIR must be set by harness');
		workbenchBootModule = require(path.join(compiledUiRoot, 'workbenchBoot.js'));
		tempModulePaths = [];
	});

	teardown(() => {
		for (const modulePath of tempModulePaths) {
			try {
				fs.unlinkSync(modulePath);
			} catch {
				// ignore cleanup issues
			}
		}
		delete global.__tauriWorkbenchCreate;
		delete global.document;
		delete global.window;
	});

	test('bootWorkbench derives workspace and payload from query', async () => {
		const { createOptions } = await boot({
			href: 'http://127.0.0.1:1420/?folder=%2Ftmp%2Fsample&payload=%7B%22source%22%3A%22test%22%7D'
		});

		const workspaceProvider = createOptions.workspaceProvider;
		assert.deepStrictEqual(workspaceProvider.workspace, {
			folderUri: {
				scheme: 'file',
				authority: '',
				path: '/tmp/sample'
			}
		});
		assert.deepStrictEqual(workspaceProvider.payload, { source: 'test' });
		assert.strictEqual(workspaceProvider.trusted, true);
	});

	test('bootWorkbench derives workspace, development options, and trust from host window config', async () => {
		const { createOptions } = await boot({
			resolveWindowConfig: async () => ({
				windowId: 1,
				workspace: {
					id: 'ws-1',
					uri: {
						scheme: 'file',
						authority: '',
						path: '/tmp/from-config'
					}
				},
				extensionDevelopmentPath: ['/tmp/ext-dev'],
				extensionTestsPath: '/tmp/ext-tests',
				'enable-proposed-api': ['vscode.vscode-api-tests'],
				'skip-welcome': true,
				'skip-release-notes': true,
				'disable-workspace-trust': true
			})
		});

		const workspaceProvider = createOptions.workspaceProvider;
		assert.strictEqual(workspaceProvider.workspace.folderUri.scheme, 'file');
		assert.strictEqual(workspaceProvider.workspace.folderUri.authority, '');
		assert.strictEqual(workspaceProvider.workspace.folderUri.path, '/tmp/from-config');
		assert.deepStrictEqual(workspaceProvider.payload, [
			['skipWelcome', 'true'],
			['skipReleaseNotes', 'true'],
			['extensionDevelopmentPath', '/tmp/ext-dev'],
			['extensionTestsPath', '/tmp/ext-tests'],
			['enableProposedApi', 'vscode.vscode-api-tests']
		]);
		assert.strictEqual(createOptions.enableWorkspaceTrust, false);
		assert.deepStrictEqual(createOptions.developmentOptions, {
			extensions: [{
				scheme: 'file',
				authority: '',
				path: '/tmp/ext-dev'
			}],
			extensionTestsPath: {
				scheme: 'file',
				authority: '',
				path: '/tmp/ext-tests'
			},
			enableSmokeTestDriver: false
		});
	});

	test('bootWorkbench parses workspace URI query and invalid payload fallback', async () => {
		const { createOptions } = await boot({
			href: 'http://127.0.0.1:1420/?workspace=https%3A%2F%2Fexample.test%2Fdemo.code-workspace%3Fa%3D1%23frag&payload=not-json'
		});

		const workspaceProvider = createOptions.workspaceProvider;
		assert.deepStrictEqual(workspaceProvider.workspace, {
			workspaceUri: {
				scheme: 'https',
				authority: 'example.test',
				path: '/demo.code-workspace',
				query: 'a=1',
				fragment: 'frag'
			}
		});
		assert.deepStrictEqual(workspaceProvider.payload, {});
	});

	test('workspaceProvider.open short-circuits when reusing same workspace without payload', async () => {
		const booted = await boot({
			href: 'http://127.0.0.1:1420/?folder=%2Ftmp%2Freuse-me'
		});
		const workspaceProvider = booted.createOptions.workspaceProvider;

		const opened = await workspaceProvider.open({
			folderUri: {
				scheme: 'file',
				authority: '',
				path: '/tmp/reuse-me'
			}
		}, { reuse: true });

		assert.strictEqual(opened, true);
		assert.strictEqual(booted.getOpenedUrl(), undefined);
		assert.strictEqual(booted.getLocationHref(), 'http://127.0.0.1:1420/?folder=%2Ftmp%2Freuse-me');
	});

	test('workspaceProvider.open encodes workspace target and payload for new window flow', async () => {
		const booted = await boot({
			href: 'http://127.0.0.1:1420/'
		});
		const workspaceProvider = booted.createOptions.workspaceProvider;

		const opened = await workspaceProvider.open({
			workspaceUri: {
				scheme: 'file',
				authority: '',
				path: '/tmp/demo.code-workspace'
			}
		}, {
			reuse: false,
			payload: { source: 'unit-test' }
		});

		assert.strictEqual(opened, true);
		assert.match(booted.getOpenedUrl(), /\?workspace=file%3A%2F%2F%2Ftmp%2Fdemo\.code-workspace/);
		assert.match(booted.getOpenedUrl(), /&payload=%7B%22source%22%3A%22unit-test%22%7D$/);
		assert.strictEqual(booted.getLocationHref(), 'http://127.0.0.1:1420/');
	});

	test('open-folder command preserves Windows drive-letter paths as file URIs', async () => {
		const { createOptions, getLocationHref } = await boot({
			href: 'http://127.0.0.1:1420/',
			desktopChannelCall: async () => ({ canceled: false, filePath: 'C:\\Users\\tester\\project' })
		});

		const openFolderCommand = createOptions.commands.find(command => command.id === 'workbench.action.files.openFolder');
		assert.ok(openFolderCommand, 'open-folder command should be registered');
		await openFolderCommand.handler();

		assert.strictEqual(
			getLocationHref(),
			'http://127.0.0.1:1420/?folder=file%3A%2F%2F%2FC%3A%2FUsers%2Ftester%2Fproject'
		);
	});

	test('workspaceProvider.open falls back to current window when popup is blocked', async () => {
		const booted = await boot({
			href: 'http://127.0.0.1:1420/',
			openReturnsNull: true
		});
		const workspaceProvider = booted.createOptions.workspaceProvider;

		const opened = await workspaceProvider.open({
			folderUri: {
				scheme: 'file',
				authority: '',
				path: '/tmp/blocked-popup'
			}
		}, { reuse: false });

		assert.strictEqual(opened, true);
		assert.match(booted.getOpenedUrl(), /\?folder=file%3A%2F%2F%2Ftmp%2Fblocked-popup$/);
		assert.match(booted.getLocationHref(), /\?folder=file%3A%2F%2F%2Ftmp%2Fblocked-popup$/);
	});

		test('workspaceProvider.open encodes empty-window targets when payload is present', async () => {
			const booted = await boot({
				href: 'http://127.0.0.1:1420/?folder=%2Ftmp%2Fcurrent'
			});
			const workspaceProvider = booted.createOptions.workspaceProvider;

			const opened = await workspaceProvider.open(undefined, {
				reuse: true,
				payload: { from: 'reset' }
			});

			assert.strictEqual(opened, true);
			assert.match(booted.getLocationHref(), /\?ew=true&payload=%7B%22from%22%3A%22reset%22%7D$/);
		});

	test('open-folder command uses nativeHost picker and reuses current window', async () => {
		/** @type {{ channel?: string; method?: string; args?: unknown[] }} */
		const call = {};
		const { createOptions, getLocationHref } = await boot({
			href: 'http://127.0.0.1:1420/',
			desktopChannelCall: async (channel, method, args) => {
				call.channel = channel;
				call.method = method;
				call.args = args;
				return { canceled: false, filePaths: ['/tmp/picked-folder'] };
			}
		});

		const openFolderCommand = createOptions.commands.find(command => command.id === 'workbench.action.files.openFolder');
		assert.ok(openFolderCommand, 'open-folder command should be registered');
		await openFolderCommand.handler();

		assert.strictEqual(call.channel, 'nativeHost');
		assert.strictEqual(call.method, 'showOpenDialog');
		assert.deepStrictEqual(call.args, [{
			title: 'Open Folder',
			properties: ['openDirectory', 'createDirectory']
		}]);
		assert.match(getLocationHref(), /\?folder=file%3A%2F%2F%2Ftmp%2Fpicked-folder$/);
	});

	test('open-folder command accepts single filePath dialog results', async () => {
		const { createOptions, getLocationHref } = await boot({
			href: 'http://127.0.0.1:1420/',
			desktopChannelCall: async () => ({ canceled: false, filePath: '/tmp/single-picked-folder' })
		});

		const openFolderCommand = createOptions.commands.find(command => command.id === 'workbench.action.files.openFolder');
		assert.ok(openFolderCommand, 'open-folder command should be registered');
		await openFolderCommand.handler();

		assert.match(getLocationHref(), /\?folder=file%3A%2F%2F%2Ftmp%2Fsingle-picked-folder$/);
	});

	test('open-folder command does not navigate when picker is canceled or fails', async () => {
		const canceledBoot = await boot({
			href: 'http://127.0.0.1:1420/',
			desktopChannelCall: async () => ({ canceled: true })
		});
		const canceledCommand = canceledBoot.createOptions.commands.find(command => command.id === 'workbench.action.files.openFolder');
		await canceledCommand.handler();
		assert.strictEqual(canceledBoot.getLocationHref(), 'http://127.0.0.1:1420/');

		const failedBoot = await boot({
			href: 'http://127.0.0.1:1420/',
			desktopChannelCall: async () => {
				throw new Error('picker failed');
			}
		});
		const failedCommand = failedBoot.createOptions.commands.find(command => command.id === 'workbench.action.files.openFolder');
		await failedCommand.handler();
		assert.strictEqual(failedBoot.getLocationHref(), 'http://127.0.0.1:1420/');
	});

	test('open-folder-in-new-window command opens popup target', async () => {
		const { createOptions, getOpenedUrl, getLocationHref } = await boot({
			href: 'http://127.0.0.1:1420/',
			desktopChannelCall: async () => ({ canceled: false, filePaths: ['/tmp/new-folder'] })
		});

		const openInNewWindowCommand = createOptions.commands.find(command => command.id === 'workbench.action.files.openFolderInNewWindow');
		assert.ok(openInNewWindowCommand, 'open-folder-in-new-window command should be registered');
		await openInNewWindowCommand.handler();

		assert.match(getOpenedUrl(), /\?folder=file%3A%2F%2F%2Ftmp%2Fnew-folder$/);
		assert.strictEqual(getLocationHref(), 'http://127.0.0.1:1420/');
	});

		test('open-folder-in-new-window command reuses current window when forceReuseWindow is set', async () => {
		const { createOptions, getOpenedUrl, getLocationHref } = await boot({
			href: 'http://127.0.0.1:1420/',
			desktopChannelCall: async () => ({ canceled: false, filePaths: ['/tmp/reused-folder'] })
		});

		const openInNewWindowCommand = createOptions.commands.find(command => command.id === 'workbench.action.files.openFolderInNewWindow');
		await openInNewWindowCommand.handler({ forceReuseWindow: true });

			assert.strictEqual(getOpenedUrl(), undefined);
			assert.match(getLocationHref(), /\?folder=file%3A%2F%2F%2Ftmp%2Freused-folder$/);
		});

		test('open-folder-via-workspace and open-file-folder commands stay in current window', async () => {
			const booted = await boot({
				href: 'http://127.0.0.1:1420/',
				desktopChannelCall: async () => ({ canceled: false, filePaths: ['/tmp/shared-folder'] })
			});

			const openViaWorkspace = booted.createOptions.commands.find(command => command.id === 'workbench.action.files.openFolderViaWorkspace');
			const openFileFolder = booted.createOptions.commands.find(command => command.id === 'workbench.action.files.openFileFolder');
			assert.ok(openViaWorkspace, 'openFolderViaWorkspace command should be registered');
			assert.ok(openFileFolder, 'openFileFolder command should be registered');

			await openViaWorkspace.handler({ forceNewWindow: true });
			assert.strictEqual(booted.getOpenedUrl(), undefined);
			assert.match(booted.getLocationHref(), /\?folder=file%3A%2F%2F%2Ftmp%2Fshared-folder$/);

			global.window.location.href = 'http://127.0.0.1:1420/';
			await openFileFolder.handler();
			assert.strictEqual(booted.getOpenedUrl(), undefined);
			assert.match(booted.getLocationHref(), /\?folder=file%3A%2F%2F%2Ftmp%2Fshared-folder$/);
		});

		test('tauri.host.showFallbackCounts command proxies host values', async () => {
			const booted = await boot({
				getFallbackCounts: async () => ({ 'channel:logger:log': 3 })
			});

			const showFallbackCounts = booted.createOptions.commands.find(command => command.id === 'tauri.host.showFallbackCounts');
			assert.ok(showFallbackCounts, 'showFallbackCounts command should be registered');
			const originalLog = console.log;
			console.log = () => { };
			let result;
			try {
				result = await showFallbackCounts.handler();
			} finally {
				console.log = originalLog;
			}

			assert.deepStrictEqual(result, { 'channel:logger:log': 3 });
		});

		test('bootWorkbench installs import map entries for css modules', async () => {
		const { getHeadChildren } = await boot({
			getWorkbenchCssModules: async () => ['vs/workbench/workbench.desktop.main.css', '/custom.css']
		});

		const importMapNode = getHeadChildren().find(
			/** @param {any} node */
			node => node && node.tagName === 'script' && node.dataset?.vscodeCssImportMap === '1'
		);
		assert.ok(importMapNode, 'import map node should be created');
		const importMap = JSON.parse(importMapNode.textContent);
		assert.ok(importMap.imports['http://127.0.0.1:1420/out/vs/workbench/workbench.desktop.main.css']);
		assert.ok(importMap.imports['http://127.0.0.1:1420/custom.css']);
	});
});
