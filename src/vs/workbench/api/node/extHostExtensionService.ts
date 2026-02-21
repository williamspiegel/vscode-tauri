/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as performance from '../../../base/common/performance.js';
import type * as vscode from 'vscode';
import { createApiFactoryAndRegisterActors } from '../common/extHost.api.impl.js';
import { INodeModuleFactory, RequireInterceptor } from '../common/extHostRequireInterceptor.js';
import { ExtensionActivationTimesBuilder } from '../common/extHostExtensionActivator.js';
import { connectProxyResolver } from './proxyResolver.js';
import { AbstractExtHostExtensionService } from '../common/extHostExtensionService.js';
import { ExtHostDownloadService } from './extHostDownloadService.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ExtensionRuntime } from '../common/extHostTypes.js';
import { CLIServer } from './extHostCLIServer.js';
import { realpathSync } from '../../../base/node/pfs.js';
import { ExtHostConsoleForwarder } from './extHostConsoleForwarder.js';
import { ExtHostDiskFileSystemProvider } from './extHostDiskFileSystemProvider.js';
import nodeModule from 'node:module';
import * as fs from 'fs/promises';
import * as paths from '../../../base/common/path.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { assertType } from '../../../base/common/types.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { BidirectionalMap } from '../../../base/common/map.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';

const require = nodeModule.createRequire(import.meta.url);

class NodeModuleRequireInterceptor extends RequireInterceptor {

	protected _installInterceptor(): void {
		const that = this;
		const node_module = require('module');
		const originalLoad = node_module._load;
		const originalRequire = node_module.Module?.prototype?.require;
		const originalCreateRequire = node_module.createRequire;
		const fallbackParentUri = URI.file(realpathSync(import.meta.filename));
		const toParentUri = (rawPathOrUrl: string | undefined): URI => {
			if (!rawPathOrUrl) {
				return fallbackParentUri;
			}

			try {
				const normalizedPath = /^file:\/\//i.test(rawPathOrUrl) ? fileURLToPath(rawPathOrUrl) : rawPathOrUrl;
				return URI.file(realpathSync(normalizedPath));
			} catch {
				return fallbackParentUri;
			}
		};
		node_module._load = function load(request: string, parent: { filename: string }, isMain: boolean) {
			request = applyAlternatives(request);
			if (!that._factories.has(request)) {
				return originalLoad.apply(this, arguments);
			}
			return that._factories.get(request)!.load(
				request,
				URI.file(realpathSync(parent.filename)),
				request => originalLoad.apply(this, [request, parent, isMain])
			);
		};

		// Bun's CommonJS compatibility can bypass `Module._load` in some paths.
		// Intercept prototype `require` as well so `require('vscode')` still resolves
		// to the extension API factory in those environments.
		if (typeof originalRequire === 'function') {
			node_module.Module.prototype.require = function patchedRequire(this: { filename?: string }, request: string) {
				request = applyAlternatives(request);
				if (!that._factories.has(request)) {
					return originalRequire.call(this, request);
				}

				const parentFilename = typeof this.filename === 'string' ? this.filename : import.meta.filename;
				return that._factories.get(request)!.load(
					request,
					URI.file(realpathSync(parentFilename)),
					req => originalRequire.call(this, req)
				);
			};
		}

		// `createRequire(import.meta.url)` is common in ESM extensions and shims.
		// Wrap it so `require('vscode')` keeps going through the extension API factory.
		node_module.createRequire = function patchedCreateRequire(filename: string | URL) {
			const createdRequire = originalCreateRequire.call(this, filename);
			if (typeof createdRequire !== 'function') {
				return createdRequire;
			}

			const parentUri = toParentUri(typeof filename === 'string' ? filename : filename?.toString());
			const wrappedRequire = function wrappedCreateRequire(this: unknown, request: string) {
				request = applyAlternatives(request);
				if (!that._factories.has(request)) {
					return createdRequire.call(this, request);
				}

				return that._factories.get(request)!.load(
					request,
					parentUri,
					req => createdRequire.call(this, req)
				);
			} as typeof createdRequire;
			Object.assign(wrappedRequire, createdRequire);
			return wrappedRequire;
		};

		const originalLookup = node_module._resolveLookupPaths;
		node_module._resolveLookupPaths = (request: string, parent: unknown) => {
			return originalLookup.call(this, applyAlternatives(request), parent);
		};

		const originalResolveFilename = node_module._resolveFilename;
		node_module._resolveFilename = function resolveFilename(request: string, parent: unknown, isMain: boolean, options?: { paths?: string[] }) {
			if (request === 'vsda' && Array.isArray(options?.paths) && options.paths.length === 0) {
				// ESM: ever since we moved to ESM, `require.main` will be `undefined` for extensions
				// Some extensions have been using `require.resolve('vsda', { paths: require.main.paths })`
				// to find the `vsda` module in our app root. To be backwards compatible with this pattern,
				// we help by filling in the `paths` array with the node modules paths of the current module.
				options.paths = node_module._nodeModulePaths(import.meta.dirname);
			}
			return originalResolveFilename.call(this, request, parent, isMain, options);
		};

		const applyAlternatives = (request: string) => {
			for (const alternativeModuleName of that._alternatives) {
				const alternative = alternativeModuleName(request);
				if (alternative) {
					request = alternative;
					break;
				}
			}
			return request;
		};
	}
}

class NodeModuleESMInterceptor extends RequireInterceptor {

	private static _createDataUri(scriptContent: string): string {
		return `data:text/javascript;base64,${Buffer.from(scriptContent).toString('base64')}`;
	}

	// This string is a script that runs in the loader thread of NodeJS.
	private static _loaderScript = `
	let lookup;
	export const initialize = async (context) => {
		let requestIds = 0;
		const { port } = context;
		const pendingRequests = new Map();
		port.onmessage = (event) => {
			const { id, url } = event.data;
			pendingRequests.get(id)?.(url);
		};
		lookup = url => {
			// debugger;
			const myId = requestIds++;
			return new Promise((resolve) => {
				pendingRequests.set(myId, resolve);
				port.postMessage({ id: myId, url, });
			});
		};
	};
	export const resolve = async (specifier, context, nextResolve) => {
		if (specifier !== 'vscode' || !context.parentURL) {
			return nextResolve(specifier, context);
		}
		const otherUrl = await lookup(context.parentURL);
		return {
			url: otherUrl,
			shortCircuit: true,
		};
	};`;

	private static _vscodeImportFnName = `_VSCODE_IMPORT_VSCODE_API`;

	private readonly _store = new DisposableStore();

	dispose(): void {
		this._store.dispose();
	}

	protected override _installInterceptor(): void {

		type Message = { id: string; url: string };

		const apiInstances = new BidirectionalMap<typeof vscode, string>();
		const apiImportDataUrl = new Map<string, string>();

		// define a global function that can be used to get API instances given a random key
		Object.defineProperty(globalThis, NodeModuleESMInterceptor._vscodeImportFnName, {
			enumerable: false,
			configurable: false,
			writable: false,
			value: (key: string) => {
				return apiInstances.getKey(key);
			}
		});

		const { port1, port2 } = new MessageChannel();

		let apiModuleFactory: INodeModuleFactory | undefined;

		// this is a workaround for the fact that the layer checker does not understand
		// that onmessage is NodeJS API here
		const port1LayerCheckerWorkaround: any = port1;

		port1LayerCheckerWorkaround.onmessage = (e: { data: Message }) => {

			// Get the vscode-module factory - which is the same logic that's also used by
			// the CommonJS require interceptor
			if (!apiModuleFactory) {
				apiModuleFactory = this._factories.get('vscode');
				assertType(apiModuleFactory);
			}

			const { id, url } = e.data;
			const uri = URI.parse(url);

			// Get or create the API instance. The interface is per extension and extensions are
			// looked up by the uri (e.data.url) and path containment.
			const apiInstance = apiModuleFactory.load('_not_used', uri, () => { throw new Error('CANNOT LOAD MODULE from here.'); });
			let key = apiInstances.get(apiInstance);
			if (!key) {
				key = generateUuid();
				apiInstances.set(apiInstance, key);
			}

			// Create and cache a data-url which is the import script for the API instance
			let scriptDataUrlSrc = apiImportDataUrl.get(key);
			if (!scriptDataUrlSrc) {
				const jsCode = `const _vscodeInstance = globalThis.${NodeModuleESMInterceptor._vscodeImportFnName}('${key}');\n\n${Object.keys(apiInstance).map((name => `export const ${name} = _vscodeInstance['${name}'];`)).join('\n')}`;
				scriptDataUrlSrc = NodeModuleESMInterceptor._createDataUri(jsCode);
				apiImportDataUrl.set(key, scriptDataUrlSrc);
			}

			port1.postMessage({
				id,
				url: scriptDataUrlSrc
			});
		};

		nodeModule.register(NodeModuleESMInterceptor._createDataUri(NodeModuleESMInterceptor._loaderScript), {
			parentURL: import.meta.url,
			data: { port: port2 },
			transferList: [port2],
		});

		this._store.add(toDisposable(() => {
			port1.close();
			port2.close();
		}));
	}
}

export class ExtHostExtensionService extends AbstractExtHostExtensionService {

	readonly extensionRuntime = ExtensionRuntime.Node;
	private readonly electrobunEsmRewriteCache = new Map<string, string>();

	protected async _beforeAlmostReadyToRunExtensions(): Promise<void> {
		// make sure console.log calls make it to the render
		this._instaService.createInstance(ExtHostConsoleForwarder);

		// initialize API and register actors
		const extensionApiFactory = this._instaService.invokeFunction(createApiFactoryAndRegisterActors);

		// Register Download command
		this._instaService.createInstance(ExtHostDownloadService);

		// Register CLI Server for ipc
		if (this._initData.remote.isRemote && this._initData.remote.authority) {
			const cliServer = this._instaService.createInstance(CLIServer);
			process.env['VSCODE_IPC_HOOK_CLI'] = cliServer.ipcHandlePath;
		}

		// Register local file system shortcut
		this._instaService.createInstance(ExtHostDiskFileSystemProvider);

		// Module loading tricks
		await this._instaService.createInstance(NodeModuleRequireInterceptor, extensionApiFactory, { mine: this._myRegistry, all: this._globalRegistry })
			.install();

		// ESM loading tricks
		await this._store.add(this._instaService.createInstance(NodeModuleESMInterceptor, extensionApiFactory, { mine: this._myRegistry, all: this._globalRegistry }))
			.install();

		performance.mark('code/extHost/didInitAPI');

		// Do this when extension service exists, but extensions are not being activated yet.
		const configProvider = await this._extHostConfiguration.getConfigProvider();
		await connectProxyResolver(this._extHostWorkspace, configProvider, this, this._logService, this._mainThreadTelemetryProxy, this._initData, this._store);
		performance.mark('code/extHost/didInitProxyResolver');
	}

	private isElectrobunRuntime(): boolean {
		return Boolean(process.env['VSCODE_DESKTOP_RUNTIME'] === 'electrobun' || process.versions?.['bun']);
	}

	private async rewriteElectrobunEsmDirectory(sourceDir: string, rewrittenDir: string): Promise<string> {
		const shimFilePath = paths.join(rewrittenDir, '__vscode_api_shim__.mjs');
		const shimFileHref = pathToFileURL(shimFilePath).href;

		await fs.rm(rewrittenDir, { recursive: true, force: true });
		await fs.mkdir(rewrittenDir, { recursive: true });

		// Keep extension-specific API behavior by resolving `require('vscode')` from
		// a file that still lives under the extension folder.
		const shimSource = [
			`import { createRequire } from 'node:module';`,
			`const require = createRequire(import.meta.url);`,
			`const vscode = require('vscode');`,
			`export default vscode;`
		].join('\n');
		await fs.writeFile(shimFilePath, `${shimSource}\n`, 'utf8');

		const rewriteSpecifier = (source: string): string => {
			let rewritten = source;
			let seq = 0;

			// Named imports from `vscode` need to become default imports from our shim.
			rewritten = rewritten.replace(
				/import\s+\{([^}]+)\}\s+from\s+['"]vscode['"]\s*;?/g,
				(_match, imports: string) => {
					const alias = `__vscode_api_${++seq}`;
					const destructuring = imports.replace(/\bas\b/g, ':');
					return `import ${alias} from '${shimFileHref}';\nconst { ${destructuring} } = ${alias};`;
				}
			);

			rewritten = rewritten.replace(
				/import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s+from\s+['"]vscode['"]\s*;?/g,
				(_match, defaultImport: string, imports: string) => {
					const destructuring = imports.replace(/\bas\b/g, ':');
					return `import ${defaultImport} from '${shimFileHref}';\nconst { ${destructuring} } = ${defaultImport};`;
				}
			);

			rewritten = rewritten.replace(
				/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]vscode['"]\s*;?/g,
				`import $1 from '${shimFileHref}';`
			);

			rewritten = rewritten.replace(
				/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]vscode['"]\s*;?/g,
				`import $1 from '${shimFileHref}';`
			);

			rewritten = rewritten.replace(/from\s+(['"])vscode\1/g, `from '${shimFileHref}'`);
			rewritten = rewritten.replace(/import\s*\(\s*(['"])vscode\1\s*\)/g, `import('${shimFileHref}')`);
			return rewritten;
		};

		const copyRecursive = async (fromDir: string, toDir: string): Promise<void> => {
			await fs.mkdir(toDir, { recursive: true });
			const entries = await fs.readdir(fromDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name === '.electrobun-esm') {
					continue;
				}

				const sourcePath = paths.join(fromDir, entry.name);
				const targetPath = paths.join(toDir, entry.name);

				if (entry.isDirectory()) {
					await copyRecursive(sourcePath, targetPath);
					continue;
				}

				if (!entry.isFile()) {
					continue;
				}

				const extension = paths.extname(entry.name).toLowerCase();
				if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
					const content = await fs.readFile(sourcePath, 'utf8');
					await fs.writeFile(targetPath, rewriteSpecifier(content), 'utf8');
				} else {
					await fs.copyFile(sourcePath, targetPath);
				}
			}
		};

		await copyRecursive(sourceDir, rewrittenDir);
		return shimFileHref;
	}

	private async prepareElectrobunEsmModule(module: URI): Promise<URI> {
		if (!this.isElectrobunRuntime()) {
			return module;
		}

		const sourceDir = paths.dirname(module.fsPath);
		let rewrittenDir = this.electrobunEsmRewriteCache.get(sourceDir);
		if (!rewrittenDir) {
			rewrittenDir = paths.join(sourceDir, '.electrobun-esm');
			await this.rewriteElectrobunEsmDirectory(sourceDir, rewrittenDir);
			this.electrobunEsmRewriteCache.set(sourceDir, rewrittenDir);
		}

		const rewrittenModulePath = paths.join(rewrittenDir, paths.basename(module.fsPath));
		return URI.file(rewrittenModulePath);
	}

	protected _getEntryPoint(extensionDescription: IExtensionDescription): string | undefined {
		return extensionDescription.main;
	}

	private async _doLoadModule<T>(extension: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder, mode: 'esm' | 'cjs'): Promise<T> {
		if (module.scheme !== Schemas.file) {
			throw new Error(`Cannot load URI: '${module}', must be of file-scheme`);
		}
		let r: T | null = null;
		activationTimesBuilder.codeLoadingStart();
		this._logService.trace(`ExtensionService#loadModule [${mode}] -> ${module.toString(true)}`);
		this._logService.flush();
		const extensionId = extension?.identifier.value;
		if (extension) {
			await this._extHostLocalizationService.initializeLocalizedMessages(extension);
		}
		try {
			if (extensionId) {
				performance.mark(`code/extHost/willLoadExtensionCode/${extensionId}`);
			}
			if (mode === 'esm') {
				const resolvedModule = await this.prepareElectrobunEsmModule(module);
				r = <T>await import(resolvedModule.toString(true));
			} else {
				try {
					r = <T>require(module.fsPath);
				} catch (error) {
					const maybeMissingVscodePackage = error instanceof Error && /Cannot find package ['"]vscode['"]/.test(error.message);
					if (!this.isElectrobunRuntime() || extension?.type !== 'module' || !maybeMissingVscodePackage) {
						throw error;
					}

					// Bun can attempt ESM resolution from `require(...)` for `type: module` packages.
					// Retry through the Electrobun ESM rewrite path to guarantee `vscode` API shimming.
					const resolvedModule = await this.prepareElectrobunEsmModule(module);
					r = <T>await import(resolvedModule.toString(true));
				}
			}
		} finally {
			if (extensionId) {
				performance.mark(`code/extHost/didLoadExtensionCode/${extensionId}`);
			}
			activationTimesBuilder.codeLoadingStop();
		}
		return r;
	}

	protected async _loadCommonJSModule<T>(extension: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<T> {
		return this._doLoadModule<T>(extension, module, activationTimesBuilder, 'cjs');
	}

	protected async _loadESMModule<T>(extension: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<T> {
		return this._doLoadModule<T>(extension, module, activationTimesBuilder, 'esm');
	}

	public async $setRemoteEnvironment(env: { [key: string]: string | null }): Promise<void> {
		if (!this._initData.remote.isRemote) {
			return;
		}

		for (const key in env) {
			const value = env[key];
			if (value === null) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}
