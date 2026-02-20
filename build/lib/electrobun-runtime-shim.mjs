import { fork as forkChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";

const noop = () => undefined;
const runtimeDebug = process.env["VSCODE_ELECTROBUN_DEBUG"] === "1";
const vscodeWindowConfigurations = new Map();
const vscodeWindowConfigurationsByChannel = new Map();
const rendererHostWebviewIds = new Map();
const rendererEventBridge = {
	send: undefined,
	registerTransferPort: undefined,
};
const runtimeDiagLogPath =
	process.env["VSCODE_ELECTROBUN_DIAG_LOG"] ||
	path.join(
		process.env["VSCODE_CWD"] || process.cwd(),
		".build",
		"electrobun-diag.log",
	);

function appendRuntimeDiag(message) {
	try {
		fs.mkdirSync(path.dirname(runtimeDiagLogPath), { recursive: true });
		fs.appendFileSync(
			runtimeDiagLogPath,
			`[${new Date().toISOString()}] ${String(message)}\n`,
			"utf8",
		);
	} catch {}
}

function serializeIpcArgForRenderer(value) {
	if (Buffer.isBuffer(value)) {
		return { type: "Buffer", data: Array.from(value) };
	}
	if (value instanceof ArrayBuffer) {
		return { type: "Buffer", data: Array.from(new Uint8Array(value)) };
	}
	if (ArrayBuffer.isView(value)) {
		return {
			type: "Buffer",
			data: Array.from(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
		};
	}
	return value;
}

function reviveSerializedIpcArg(value) {
	if (value instanceof ArrayBuffer) {
		return Buffer.from(value);
	}
	if (ArrayBuffer.isView(value)) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value && typeof value === "object") {
		if (value.type === "Buffer" && Array.isArray(value.data)) {
			return Buffer.from(value.data);
		}
		const keys = Object.keys(value);
		if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
			const sortedNumericKeys = keys.sort((a, b) => Number(a) - Number(b));
			const bytes = Uint8Array.from(
				sortedNumericKeys.map((key) => Number(value[key]) || 0),
			);
			return Buffer.from(bytes);
		}
	}
	return value;
}

const fileContentTypes = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
	[".ttf", "font/ttf"],
	[".wasm", "application/wasm"],
	[".map", "application/json; charset=utf-8"],
]);

function getFileContentType(filePath) {
	return (
		fileContentTypes.get(path.extname(filePath).toLowerCase()) ??
		"application/octet-stream"
	);
}

async function createRuntimeFileServer() {
	return await new Promise((resolve) => {
		let settled = false;
		const settle = (value) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(value);
		};

		const server = http.createServer((request, response) => {
			try {
				const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
				const fetchDestination = String(
					request.headers["sec-fetch-dest"] ?? "",
				);
				if (runtimeDebug) {
					console.log(
						"[electrobun-runtime-shim] file-server",
						request.method ?? "GET",
						requestUrl.pathname,
						fetchDestination || "n/a",
					);
				}

				let absolutePath = "";
				if (requestUrl.pathname.startsWith("/DIAGNOSTICS")) {
					const diagPayload = requestUrl.searchParams.get("data");
					console.log(
						"\\n\\n[electrobun-renderer-diag] DIAGNOSTICS VIA FETCH:",
						diagPayload,
						"\\n\\n",
					);
					appendRuntimeDiag(`[renderer] ${diagPayload ?? "<empty>"}`);
					response.writeHead(200);
					response.end("ok");
					return;
				}
				if (requestUrl.pathname.startsWith("/fs/")) {
					absolutePath = decodeURIComponent(
						requestUrl.pathname.slice("/fs".length),
					);
				} else {
					const directPath = decodeURIComponent(requestUrl.pathname);
					if (path.isAbsolute(directPath)) {
						absolutePath = directPath;
					}
				}

				if (!absolutePath || !path.isAbsolute(absolutePath)) {
					response.writeHead(400, {
						"Content-Type": "text/plain; charset=utf-8",
					});
					response.end("Invalid path");
					return;
				}

				const normalizedPath = absolutePath.replace(/\\/g, "/");
				if (
					fetchDestination === "script" &&
					normalizedPath.endsWith("/build/lib/electrobun-runtime-shim.mjs")
				) {
					const browserShimSource = `
const noop = () => undefined;
const fallbackIpcRenderer = {
	send() {},
	async invoke() { return undefined; },
	on() { return this; },
	once() { return this; },
	removeListener() { return this; },
	off() { return this; },
	postMessage() {}
};
export const ipcRenderer = globalThis.vscode?.ipcRenderer ?? fallbackIpcRenderer;
export const contextBridge = {
	exposeInMainWorld(name, value) {
		globalThis[name] = value;
	}
};
export const webFrame = globalThis.vscode?.webFrame ?? { setZoomLevel: noop, setZoomFactor: noop };
export const webUtils = globalThis.vscode?.webUtils ?? { getPathForFile(file) { return file?.path ?? ''; } };
const defaultExport = new Proxy({ ipcRenderer, contextBridge, webFrame, webUtils }, {
	get(target, key) {
		if (key in target) {
			return target[key];
		}
		return noop;
	}
});
export default defaultExport;
`;
					response.writeHead(200, {
						"Content-Type": "text/javascript; charset=utf-8",
						"Cache-Control": "no-cache",
					});
					response.end(browserShimSource);
					return;
				}

				fs.readFile(absolutePath, (error, contents) => {
					if (error) {
						if (runtimeDebug) {
							console.warn(
								"[electrobun-runtime-shim] file-server missing",
								absolutePath,
							);
						}
						response.writeHead(404, {
							"Content-Type": "text/plain; charset=utf-8",
						});
						response.end("Not found");
						return;
					}

					const extension = path.extname(absolutePath).toLowerCase();
					if (extension === ".css" && fetchDestination === "script") {
						const cssText = contents.toString("utf8");
						const moduleSource = `const style = document.createElement('style');\nstyle.setAttribute('data-electrobun-css-module', ${JSON.stringify(absolutePath)});\nstyle.textContent = ${JSON.stringify(cssText)};\ndocument.head.appendChild(style);\nexport default undefined;\n`;
						response.writeHead(200, {
							"Content-Type": "text/javascript; charset=utf-8",
							"Cache-Control": "no-cache",
						});
						response.end(moduleSource);
						return;
					}

					if (
						fetchDestination === "script" &&
						extension &&
						extension !== ".js" &&
						extension !== ".mjs" &&
						extension !== ".cjs"
					) {
						let moduleSource = "";
						if (extension === ".json") {
							const jsonText = contents.toString("utf8");
							moduleSource = `export default JSON.parse(${JSON.stringify(jsonText)});\n`;
						} else {
							const hostedPath = `${requestUrl.origin}/fs${encodeURI(absolutePath)}`;
							moduleSource = `export default ${JSON.stringify(hostedPath)};\n`;
						}

						response.writeHead(200, {
							"Content-Type": "text/javascript; charset=utf-8",
							"Cache-Control": "no-cache",
						});
						response.end(moduleSource);
						return;
					}

					response.writeHead(200, {
						"Content-Type": getFileContentType(absolutePath),
						"Cache-Control": "no-cache",
					});
					response.end(contents);
				});
			} catch (error) {
				response.writeHead(500, {
					"Content-Type": "text/plain; charset=utf-8",
				});
				response.end(`Internal error: ${error}`);
			}
		});

		server.on("error", (error) => {
			console.warn(
				"[electrobun-runtime-shim] Failed to start runtime file server.",
				error,
			);
			settle(undefined);
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				settle(undefined);
				return;
			}
			const origin = `http://127.0.0.1:${address.port}`;
			console.log("[electrobun-runtime-shim] Runtime file server", origin);
			settle({ origin, server });
		});
	});
}

const runtimeFileServer = await createRuntimeFileServer();

function translateElectronUrlToRuntime(url) {
	if (typeof url !== "string") {
		return url;
	}

	if (!url.startsWith("vscode-file://")) {
		return url;
	}

	try {
		const parsed = new URL(url);
		if (parsed.protocol === "vscode-file:") {
			// Serve files over localhost to avoid file:// module CORS restrictions in WKWebView.
			if (runtimeFileServer?.origin) {
				const hostedPath = encodeURI(parsed.pathname);
				return `${runtimeFileServer.origin}/fs${hostedPath}${parsed.search}${parsed.hash}`;
			}

			// Fallback: native file URL.
			return `file://${parsed.pathname}${parsed.search}${parsed.hash}`;
		}
	} catch (error) {
		console.warn(
			"[electrobun-runtime-shim] Failed to translate vscode-file URL",
			url,
			error,
		);
	}

	return url;
}

function createElectrobunCompatiblePreloadScript(
	preloadPath,
	additionalArguments,
) {
	let preloadSource = "";
	if (typeof preloadPath === "string" && preloadPath.length > 0) {
		let actualPath = preloadPath;
		if (preloadPath.startsWith("vscode-file://")) {
			try {
				actualPath = decodeURIComponent(new URL(preloadPath).pathname);
			} catch (e) {}
		}
		if (fs.existsSync(actualPath)) {
			preloadSource = fs.readFileSync(actualPath, "utf8");
		} else if (fs.existsSync(preloadPath)) {
			preloadSource = fs.readFileSync(preloadPath, "utf8");
		} else {
			// Electrobun accepts preload source as raw JavaScript text.
			preloadSource = preloadPath;
		}
	}
	if (preloadSource.length > 0) {
		// Electrobun preload runs as a classic script. Drop ESM leftovers from TS output.
		preloadSource = preloadSource
			.replace(/\r\n/g, "\n")
			.replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, "")
			.replace(/^\s*\/\/# sourceMappingURL=.*$/gm, "");
	}

	const args = Array.isArray(additionalArguments) ? additionalArguments : [];
	const bootstrapSource = `
try {
	window.__preloadRan = true;
	fetch('${runtimeFileServer?.origin ?? "http://127.0.0.1"}' + "/DIAGNOSTICS?data=PRELOAD_STARTED").catch(e => {});
(() => {
	const __vscodeArgs = ${JSON.stringify(args)};
	window.__vscodePreloadBootstrapLoaded = true;
	const __vscodePending = new Map();
	const __vscodeListeners = new Map();
	let __vscodeSeq = 0;
	const __vscodeDiagEndpoint = '${runtimeFileServer?.origin ?? "http://127.0.0.1"}' + '/DIAGNOSTICS?data=';
	const __vscodeReportRendererIssue = (label, value) => {
		try {
			const payload = typeof value === 'string' ? value : String(value ?? '');
			fetch(__vscodeDiagEndpoint + encodeURIComponent(label + ': ' + payload)).catch(() => {});
		} catch {}
	};
	window.addEventListener('error', (event) => {
		const message = event?.error?.stack || event?.message || 'Unknown renderer error';
		__vscodeReportRendererIssue('RENDERER_ERROR', message);
	});
	window.addEventListener('unhandledrejection', (event) => {
		const reason = event?.reason?.stack || event?.reason || 'Unknown unhandled rejection';
		__vscodeReportRendererIssue('UNHANDLED_REJECTION', reason);
	});

	const __electrobunObj = window.__electrobun ?? (window.__electrobun = {});
	const __previousReceive = __electrobunObj.receiveInternalMessageFromBun;
	const __vscodeOutgoingQueue = [];
	const __vscodeInFlightBatches = [];
	const __vscodeVirtualPorts = new Map();
	let __vscodeBridgeBusy = false;

	function __vscodeRetainBatch(batch) {
		__vscodeInFlightBatches.push(batch);
		setTimeout(() => {
			const index = __vscodeInFlightBatches.indexOf(batch);
			if (index >= 0) {
				__vscodeInFlightBatches.splice(index, 1);
			}
		}, 250);
	}

	function __vscodeEnsureVirtualPort(portId) {
		if (!portId) {
			return undefined;
		}
		const existing = __vscodeVirtualPorts.get(portId);
		if (existing?.clientPort) {
			return existing.clientPort;
		}
		const channel = new MessageChannel();
		const clientPort = channel.port1;
		const bridgePort = channel.port2;
		bridgePort.onmessage = (event) => {
			const payload = event?.data;
			let serializedData = payload;
			if (payload instanceof ArrayBuffer) {
				serializedData = { type: 'Buffer', data: Array.from(new Uint8Array(payload)) };
			} else if (ArrayBuffer.isView(payload)) {
				serializedData = {
					type: 'Buffer',
					data: Array.from(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength))
				};
			}
			__vscodePost({
				type: 'message',
				id: 'vscodeVirtualPortPost',
				payload: {
					portId,
					data: serializedData,
					windowId: window.__electrobunWindowId,
					hostWebviewId: window.__electrobunWebviewId
				}
			});
		};
		bridgePort.start();
		const entry = { clientPort, bridgePort };
		__vscodeVirtualPorts.set(portId, entry);
		return clientPort;
	}

	function __vscodeForwardVirtualPortMessage(portId, data) {
		const entry = __vscodeVirtualPorts.get(portId);
		if (!entry?.bridgePort) {
			return;
		}
		try {
			entry.bridgePort.postMessage(data);
		} catch (error) {
			console.error('[electrobun preload bootstrap] virtual port forward failed', error);
		}
	}

	function __vscodeCloseVirtualPort(portId) {
		const entry = __vscodeVirtualPorts.get(portId);
		if (!entry) {
			return;
		}
		try {
			entry.bridgePort?.close?.();
		} catch {}
		try {
			entry.clientPort?.close?.();
		} catch {}
		__vscodeVirtualPorts.delete(portId);
	}

	function __vscodeReviveArg(value) {
		if (value && typeof value === 'object') {
			if (value.type === 'Buffer' && Array.isArray(value.data)) {
				return Uint8Array.from(value.data);
			}
			const keys = Object.keys(value);
			if (keys.length > 0 && keys.every((key) => /^\\d+$/.test(key))) {
				const sortedKeys = keys.sort((a, b) => Number(a) - Number(b));
				return Uint8Array.from(sortedKeys.map((key) => Number(value[key]) || 0));
			}
		}
		return value;
	}

	function __vscodeEmit(channel, args) {
		const listeners = __vscodeListeners.get(channel);
		if (!listeners || listeners.size === 0) {
			return;
		}
		const event = { sender: null, ports: [] };
		for (const listener of listeners) {
			try {
				listener(event, ...(Array.isArray(args) ? args : []));
			} catch (error) {
				console.error('[electrobun preload bootstrap] ipc listener failed', error);
			}
		}
	}

	function __vscodePostBatch(batch) {
		try {
			const bridge = window.__electrobunInternalBridge;
			if (!bridge || typeof bridge.postMessage !== 'function') {
				__vscodeReportRendererIssue('INTERNAL_BRIDGE_MISSING', 'vscode-ipc');
				return false;
			}
			__vscodeRetainBatch(batch);
			bridge.postMessage(batch);
			return true;
		} catch (error) {
			console.error('[electrobun preload bootstrap] postMessage failed', error);
			__vscodeReportRendererIssue('INTERNAL_BRIDGE_POST_FAILED', error?.stack || String(error));
			return false;
		}
	}

	function __vscodeProcessOutgoingQueue() {
		if (__vscodeBridgeBusy) {
			setTimeout(__vscodeProcessOutgoingQueue, 1);
			return;
		}
		if (__vscodeOutgoingQueue.length === 0) {
			return;
		}
		__vscodeBridgeBusy = true;
		const batchEntries = __vscodeOutgoingQueue.splice(0, Math.min(__vscodeOutgoingQueue.length, 16));
		const batch = JSON.stringify(batchEntries);
		const posted = __vscodePostBatch(batch);
		if (!posted) {
			__vscodeOutgoingQueue.unshift(...batchEntries);
			__vscodeBridgeBusy = false;
			return;
		}
		// Keep a delay between bridge calls to avoid JSCallback threading corruption
		// seen under heavy VS Code startup traffic.
		setTimeout(() => {
			__vscodeBridgeBusy = false;
			__vscodeProcessOutgoingQueue();
		}, 6);
	}

	function __vscodePost(entry) {
		try {
			__vscodeOutgoingQueue.push(JSON.stringify(entry));
		} catch (error) {
			console.error('[electrobun preload bootstrap] failed to serialize IPC payload', error);
			__vscodeReportRendererIssue('INTERNAL_BRIDGE_SERIALIZE_FAILED', error?.stack || String(error));
			return false;
		}
		__vscodeProcessOutgoingQueue();
		return true;
	}

	__electrobunObj.receiveInternalMessageFromBun = (message) => {
		try {
			if (Array.isArray(message)) {
				for (const entry of message) {
					__electrobunObj.receiveInternalMessageFromBun(entry);
				}
				return;
			}
			if (message && typeof message === 'object') {
				if (typeof message.id === 'string' && message.id.startsWith('vscode-ipc-')) {
					const pending = __vscodePending.get(message.id);
					if (pending) {
						if (message.success !== false && message?.payload?.__vscodeAsyncInvoke === true) {
							// Async IPC invoke acknowledged by main process. Keep pending
							// until the follow-up response with the actual payload arrives.
							return;
						}
						__vscodePending.delete(message.id);
						if (message.success === false) {
							pending.reject(new Error(String(message.payload ?? 'Unknown IPC invoke failure')));
						} else {
							pending.resolve(__vscodeReviveArg(message.payload));
						}
						return;
					}
				}
					if (message.type === 'event' && typeof message.channel === 'string') {
						const revivedArgs = Array.isArray(message.args) ? message.args.map(__vscodeReviveArg) : [];
						if (message.channel === 'vscode:__virtualPortMessage') {
							const portId = typeof revivedArgs[0] === 'string' ? revivedArgs[0] : String(revivedArgs[0] ?? '');
							if (portId) {
								__vscodeForwardVirtualPortMessage(portId, revivedArgs[1]);
							}
							return;
						}
						if (message.channel === 'vscode:__virtualPortClose') {
							const portId = typeof revivedArgs[0] === 'string' ? revivedArgs[0] : String(revivedArgs[0] ?? '');
							if (portId) {
								__vscodeCloseVirtualPort(portId);
							}
							return;
						}
						__vscodeEmit(message.channel, revivedArgs);
						return;
					}
			}
		} catch (error) {
			console.error('[electrobun preload bootstrap] receive handler failed', error);
		}
		if (typeof __previousReceive === 'function') {
			return __previousReceive(message);
		}
	};

	const ipcRenderer = {
		send(channel, ...args) {
			__vscodePost({
				type: 'message',
				id: 'vscodeIpcSend',
				payload: { channel, args, windowId: window.__electrobunWindowId, hostWebviewId: window.__electrobunWebviewId }
			});
		},
		invoke(channel, ...args) {
			return new Promise((resolve, reject) => {
				const id = 'vscode-ipc-' + (++__vscodeSeq) + '-' + Date.now();
				__vscodePending.set(id, { resolve, reject });
				const posted = __vscodePost({
					type: 'request',
					method: 'vscodeIpcInvoke',
					id,
					hostWebviewId: window.__electrobunWebviewId,
					params: { requestId: id, channel, args, windowId: window.__electrobunWindowId, hostWebviewId: window.__electrobunWebviewId }
				});
				if (!posted) {
					__vscodePending.delete(id);
					reject(new Error('Electrobun internal bridge is unavailable.'));
					return;
				}
				setTimeout(() => {
					const pending = __vscodePending.get(id);
					if (pending) {
						__vscodePending.delete(id);
						pending.reject(new Error('IPC invoke timeout for channel: ' + channel));
					}
				}, 15000);
			});
		},
		on(channel, listener) {
			let listeners = __vscodeListeners.get(channel);
			if (!listeners) {
				listeners = new Set();
				__vscodeListeners.set(channel, listeners);
			}
			listeners.add(listener);
			return this;
		},
		once(channel, listener) {
			const onceListener = (event, ...args) => {
				this.removeListener(channel, onceListener);
				listener(event, ...args);
			};
			return this.on(channel, onceListener);
		},
		removeListener(channel, listener) {
			const listeners = __vscodeListeners.get(channel);
			if (listeners) {
				listeners.delete(listener);
				if (listeners.size === 0) {
					__vscodeListeners.delete(channel);
				}
			}
			return this;
		},
		off(channel, listener) {
			return this.removeListener(channel, listener);
		}
	};

	const webFrame = {
		setZoomLevel() {},
		setZoomFactor() {}
	};

	const contextBridge = {
		exposeInMainWorld(name, value) {
			window[name] = value;
		}
	};

	const webUtils = {
		getPathForFile(file) {
			return file?.path ?? '';
		}
	};

	const __require = (moduleName) => {
		if (moduleName === 'electrobun' || String(moduleName).includes('electrobun-runtime-shim')) {
			return { ipcRenderer, webFrame, contextBridge, webUtils };
		}
		throw new Error('Unsupported preload module: ' + moduleName);
	};

	globalThis.require = __require;

	const __process = globalThis.process ?? {};
	__process.platform = __process.platform || ${JSON.stringify(process.platform)};
	__process.arch = __process.arch || ${JSON.stringify(process.arch)};
	__process.argv = Array.isArray(__process.argv) ? [...__process.argv, ...__vscodeArgs] : ['bun', 'renderer', ...__vscodeArgs];
	__process.env = __process.env ?? {};
	__process.env['VSCODE_DESKTOP_RUNTIME'] = 'electrobun';
	__process.versions = __process.versions ?? {};
	__process.execPath = __process.execPath || ${JSON.stringify(process.execPath)};
	__process.getProcessMemoryInfo = __process.getProcessMemoryInfo || (() => Promise.resolve({}));
	__process.on = __process.on || (() => undefined);
	globalThis.process = __process;

	function __parseArgv(key) {
		const prefix = '--' + key + '=';
		for (const arg of __vscodeArgs) {
			if (typeof arg === 'string' && arg.startsWith(prefix)) {
				return arg.slice(prefix.length);
			}
		}
		return undefined;
	}

	const __defaultProduct = (() => {
		const product = globalThis._VSCODE_PRODUCT_JSON;
		if (product && typeof product === 'object') {
			return product;
		}
		return {
			version: '1.110.0-dev',
			nameShort: 'Code - OSS Dev',
			nameLong: 'Code - OSS Dev',
			applicationName: 'code-oss',
			dataFolderName: '.vscode-oss',
			urlProtocol: 'code-oss',
			reportIssueUrl: 'https://github.com/microsoft/vscode/issues/new',
			licenseName: 'MIT',
			licenseUrl: 'https://github.com/microsoft/vscode/blob/main/LICENSE.txt',
			serverLicenseUrl: 'https://github.com/microsoft/vscode/blob/main/LICENSE.txt',
			defaultChatAgent: {
				extensionId: 'GitHub.copilot',
				chatExtensionId: 'GitHub.copilot-chat',
				provider: {
					default: { id: 'github', name: 'GitHub' },
					enterprise: { id: 'github-enterprise', name: 'GitHub Enterprise' }
				},
				providerScopes: []
			}
		};
	})();

	function __applyConfigurationDefaults(configuration) {
		if (!configuration || typeof configuration !== 'object') {
			return configuration;
		}
		if (!configuration.userEnv || typeof configuration.userEnv !== 'object') {
			configuration.userEnv = {};
		}
		if (!configuration.product || typeof configuration.product !== 'object') {
			configuration.product = { ...__defaultProduct };
		}
		if (!configuration.nls || typeof configuration.nls !== 'object') {
			configuration.nls = { messages: [], language: 'en' };
		} else if (!Array.isArray(configuration.nls.messages)) {
			configuration.nls.messages = [];
		}
		if (!Array.isArray(configuration.cssModules)) {
			configuration.cssModules = [];
		}
		if (!Array.isArray(configuration.loggers)) {
			configuration.loggers = [];
		}
		if (typeof configuration.logLevel !== 'number') {
			configuration.logLevel = 2;
		}
		if (!configuration.homeDir || typeof configuration.homeDir !== 'string') {
			configuration.homeDir = __process.env['HOME'] || '/';
		}
		if (!configuration.tmpDir || typeof configuration.tmpDir !== 'string') {
			configuration.tmpDir = __process.env['TMPDIR'] || '/tmp';
		}
		if (!configuration.userDataDir || typeof configuration.userDataDir !== 'string') {
			const homeDir = String(configuration.homeDir || __process.env['HOME'] || '/').replace(/\\/+$/g, '');
			configuration.userDataDir = homeDir + '/.vscode-oss';
		}
		if (!configuration.os || typeof configuration.os !== 'object') {
			configuration.os = { release: '' };
		}
		if (!configuration.colorScheme || typeof configuration.colorScheme !== 'object') {
			configuration.colorScheme = { dark: true, highContrast: false };
		}
		if (!Array.isArray(configuration.perfMarks)) {
			configuration.perfMarks = [];
		}
		if (typeof configuration.windowId !== 'number') {
			configuration.windowId = Number(window.__electrobunWindowId) || 1;
		}
		return configuration;
	}

	let __vscodeConfiguration;
	const __windowConfigChannel = __parseArgv('vscode-window-config');
	const __vscodeConfigurationPromise = (async () => {
		if (!__windowConfigChannel) {
			__vscodeConfiguration = __applyConfigurationDefaults({ userEnv: {} });
			return __vscodeConfiguration;
		}
		try {
			const resolved = await ipcRenderer.invoke(__windowConfigChannel);
			if (__process.env['VSCODE_ELECTROBUN_DEBUG'] === '1') {
				__vscodeReportRendererIssue('CONFIG_KEYS', Object.keys(resolved || {}).join(','));
			}
			if (resolved && typeof resolved === 'object') {
				__vscodeConfiguration = __applyConfigurationDefaults(resolved);
				if (__vscodeConfiguration.userEnv && typeof __vscodeConfiguration.userEnv === 'object') {
					Object.assign(__process.env, __vscodeConfiguration.userEnv);
				}
				return __vscodeConfiguration;
			}
		} catch (error) {
			console.error('[electrobun preload bootstrap] window config resolve failed', error);
		}
		__vscodeConfiguration = __applyConfigurationDefaults({ userEnv: {} });
		return __vscodeConfiguration;
	})();

	if (!window.vscode) {
		window.vscode = {
			ipcRenderer,
				ipcMessagePort: {
					acquire(responseChannel, nonce) {
						if (!responseChannel || !nonce) {
							return;
						}
						const responseListener = (event, responseNonce, responseMetadata) => {
							if (responseNonce !== nonce) {
								return;
							}
							ipcRenderer.off(responseChannel, responseListener);
							let ports = Array.isArray(event?.ports) ? event.ports : [];
							if (ports.length === 0 && responseMetadata && typeof responseMetadata === 'object') {
								const tokens = Array.isArray(responseMetadata.__vscodePortTokens)
									? responseMetadata.__vscodePortTokens
									: [];
								if (tokens.length > 0) {
									ports = tokens
										.map((token) => __vscodeEnsureVirtualPort(String(token)))
										.filter(Boolean);
								}
							}
							window.postMessage(nonce, '*', ports);
						};
						ipcRenderer.on(responseChannel, responseListener);
					}
				},
			webFrame,
			webUtils,
			process: {
				get platform() { return __process.platform; },
				get arch() { return __process.arch; },
				get env() { return { ...__process.env }; },
				get versions() { return __process.versions; },
				get type() { return 'renderer'; },
				get execPath() { return __process.execPath; },
				cwd() {
					return __process.env['VSCODE_CWD'] || '/';
				},
				shellEnv() {
					return Promise.resolve({});
				},
				getProcessMemoryInfo() {
					return __process.getProcessMemoryInfo();
				},
				on(type, callback) {
					return __process.on(type, callback);
				}
			},
			context: {
				configuration() {
					return __vscodeConfiguration;
				},
				async resolveConfiguration() {
					return __vscodeConfigurationPromise;
				}
			}
		};
	}

	const __patchVscodeGlobals = () => {
		const globals = window.vscode;
		if (!globals || typeof globals !== 'object') {
			return;
		}
		const context = globals.context;
		if (!context || typeof context !== 'object' || context.__electrobunConfigPatched) {
			return;
		}
		const originalConfiguration = typeof context.configuration === 'function' ? context.configuration.bind(context) : null;
		const originalResolveConfiguration = typeof context.resolveConfiguration === 'function' ? context.resolveConfiguration.bind(context) : null;

		context.configuration = () => {
			try {
				if (originalConfiguration) {
					return __applyConfigurationDefaults(originalConfiguration());
				}
			} catch {}
			return __applyConfigurationDefaults({ userEnv: {} });
		};

		context.resolveConfiguration = async () => {
			try {
				if (originalResolveConfiguration) {
					const resolved = await originalResolveConfiguration();
					return __applyConfigurationDefaults(resolved || { userEnv: {} });
				}
			} catch {}
			return __applyConfigurationDefaults({ userEnv: {} });
		};

		context.__electrobunConfigPatched = true;
	};

	queueMicrotask(__patchVscodeGlobals);
	setTimeout(__patchVscodeGlobals, 0);
	setTimeout(__patchVscodeGlobals, 50);
})();
} catch (e) {
	fetch('${runtimeFileServer?.origin ?? "http://127.0.0.1"}' + "/DIAGNOSTICS?data=" + encodeURIComponent("Bootstrap Error: " + (e.stack || String(e))));
}
`;

	return `${bootstrapSource}\n${preloadSource}`;
}

let electrobunRuntime = undefined;
try {
	const runtimeModule = await import("electrobun");
	electrobunRuntime = runtimeModule.default ?? runtimeModule;
} catch (error) {
	console.warn(
		"[electrobun-runtime-shim] Failed to import electrobun package, using fallback stubs only.",
		error,
	);
}

const appEmitter = new EventEmitter();
let appReady = false;
let resolveAppReady;
const appReadyPromise = new Promise((resolve) => {
	resolveAppReady = resolve;
});
const appPaths = new Map();
const commandLineValues = new Map();
const recentDocuments = [];
let badgeCount = 0;

const commandLine = {
	appendSwitch(key, value) {
		commandLineValues.set(key, value ?? true);
	},
	hasSwitch(key) {
		return commandLineValues.has(key);
	},
	getSwitchValue(key) {
		const value = commandLineValues.get(key);
		return typeof value === "string" ? value : "";
	},
};

export const app = Object.assign(appEmitter, {
	commandLine,
	enableSandbox: noop,
	disableHardwareAcceleration: noop,
	setPath(name, value) {
		appPaths.set(name, value);
	},
	getPath(name) {
		return appPaths.get(name) ?? process.cwd();
	},
	setAppLogsPath(value) {
		appPaths.set("logs", value);
	},
	getPreferredSystemLanguages() {
		return [Intl.DateTimeFormat().resolvedOptions().locale || "en"];
	},
	getLocale() {
		return Intl.DateTimeFormat().resolvedOptions().locale || "en";
	},
	getGPUFeatureStatus() {
		return {};
	},
	focus: noop,
	hide: noop,
	show: noop,
	setAppUserModelId: noop,
	requestSingleInstanceLock() {
		return true;
	},
	releaseSingleInstanceLock: noop,
	whenReady() {
		return appReady ? Promise.resolve() : appReadyPromise;
	},
	isReady() {
		return appReady;
	},
	addRecentDocument(path) {
		recentDocuments.push(path);
	},
	clearRecentDocuments() {
		recentDocuments.length = 0;
	},
	getJumpListSettings() {
		return { removedItems: [] };
	},
	setJumpList() {
		return "ok";
	},
	setBadgeCount(count = 0) {
		badgeCount = Number(count) || 0;
	},
	getBadgeCount() {
		return badgeCount;
	},
	setAboutPanelOptions: noop,
	exit(code) {
		process.exit(code ?? 0);
	},
	quit() {
		const quit = electrobunRuntime?.Utils?.quit;
		if (typeof quit === "function") {
			quit();
			return;
		}
		process.exit(0);
	},
	runningUnderARM64Translation: false,
});

app.dock = {
	setMenu: noop,
	bounce: noop,
	hide: noop,
	show: noop,
};

function emitAppReadyLifecycle() {
	console.log("[electrobun-runtime-shim] emitAppReadyLifecycle called");
	if (appReady) {
		return;
	}

	appEmitter.emit("will-finish-launching");
	appReady = true;
	resolveAppReady?.();
	console.log("[electrobun-runtime-shim] Emitting ready event");
	appEmitter.emit("ready");
}

// Delay lifecycle emission to avoid racing with listeners that are attached
// during main module evaluation.
setTimeout(() => emitAppReadyLifecycle(), 0);

const originalOn = app.on.bind(app);
const originalOnce = app.once.bind(app);
const originalAddListener = app.addListener.bind(app);

function invokeReadyListener(listener) {
	console.log("[electrobun-runtime-shim] invokeReadyListener called");
	queueMicrotask(() => {
		try {
			listener();
		} catch (error) {
			console.error("[electrobun-runtime-shim] ready listener failed", error);
		}
	});
}

app.on = function (eventName, listener) {
	if (eventName === "ready" && appReady) {
		invokeReadyListener(listener);
	}
	return originalOn(eventName, listener);
};

app.addListener = function (eventName, listener) {
	if (eventName === "ready" && appReady) {
		invokeReadyListener(listener);
	}
	return originalAddListener(eventName, listener);
};

app.once = function (eventName, listener) {
	if (eventName === "ready" && appReady) {
		invokeReadyListener(listener);
		return app;
	}
	return originalOnce(eventName, listener);
};

export const protocol = {
	registerSchemesAsPrivileged: noop,
	registerBufferProtocol: noop,
	registerHttpProtocol: noop,
	registerFileProtocol: noop,
	interceptFileProtocol: noop,
	unregisterProtocol: noop,
	handle: noop,
};

export const crashReporter = {
	start: noop,
};

export class MenuItem {
	constructor(options = {}) {
		Object.assign(this, options);
	}
}

export class Menu {
	constructor() {
		this.items = [];
	}

	append(item) {
		this.items.push(item);
	}

	popup() {}

	closePopup() {}

	static setApplicationMenu(menu) {}

	static buildFromTemplate(template) {
		const menu = new Menu();
		for (const item of template ?? []) {
			menu.append(item instanceof MenuItem ? item : new MenuItem(item));
		}
		return menu;
	}

	static getApplicationMenu() {
		return null;
	}
}

export const contentTracing = {
	startRecording: async () => undefined,
	stopRecording: async () => "",
	getCategories: async () => [],
};

const clipboardState = {
	text: "",
	image: undefined,
};

export const clipboard = {
	readText() {
		const readText = electrobunRuntime?.Utils?.clipboardReadText;
		if (typeof readText === "function") {
			return readText() ?? "";
		}
		return clipboardState.text;
	},
	writeText(text) {
		const writeText = electrobunRuntime?.Utils?.clipboardWriteText;
		if (typeof writeText === "function") {
			writeText(String(text ?? ""));
			return;
		}
		clipboardState.text = String(text ?? "");
	},
	readImage() {
		return clipboardState.image;
	},
	writeImage(image) {
		clipboardState.image = image;
	},
	clear() {
		clipboardState.text = "";
		clipboardState.image = undefined;
	},
	availableFormats() {
		return clipboardState.text ? ["text/plain"] : [];
	},
};

export const shell = {
	openExternal: async (url) =>
		electrobunRuntime?.Utils?.openExternal?.(url) ?? true,
	openPath: async (filePath) =>
		electrobunRuntime?.Utils?.openPath?.(filePath) ?? "",
	showItemInFolder: (filePath) =>
		electrobunRuntime?.Utils?.showItemInFolder?.(filePath),
	trashItem: async (filePath) =>
		electrobunRuntime?.Utils?.moveToTrash?.(filePath) ?? true,
};

export class Notification {
	constructor(options = {}) {
		this.options = options;
	}

	show() {
		electrobunRuntime?.Utils?.showNotification?.(this.options);
	}
}

export const dialog = {
	showErrorBox(title, content) {
		console.error(`${title}: ${content}`);
	},
	showMessageBoxSync(optionsOrWindow, maybeOptions) {
		const options = maybeOptions ?? optionsOrWindow ?? {};
		return options.defaultId ?? 0;
	},
	async showMessageBox(optionsOrWindow, maybeOptions) {
		const options = maybeOptions ?? optionsOrWindow ?? {};
		const showMessageBox = electrobunRuntime?.Utils?.showMessageBox;
		if (typeof showMessageBox === "function") {
			const result = await showMessageBox(options);
			return {
				response: result?.response ?? options.defaultId ?? 0,
				checkboxChecked: false,
			};
		}
		return { response: options.defaultId ?? 0, checkboxChecked: false };
	},
	async showOpenDialog(optionsOrWindow, maybeOptions) {
		const options = maybeOptions ?? optionsOrWindow ?? {};
		const openFileDialog = electrobunRuntime?.Utils?.openFileDialog;
			if (typeof openFileDialog === "function") {
				const properties = Array.isArray(options?.properties) ? options.properties : [];
				const hasOpenDirectory = properties.includes("openDirectory");
				const hasOpenFile = properties.includes("openFile");
				const canChooseDirectory = hasOpenDirectory || (!hasOpenDirectory && !hasOpenFile);
				const canChooseFiles = hasOpenFile || (!hasOpenDirectory && !hasOpenFile);
				const canChooseFilesForRuntime =
					canChooseFiles || (canChooseDirectory && !hasOpenFile);
				const allowsMultipleSelection = properties.includes("multiSelections");
			const filters = Array.isArray(options?.filters) ? options.filters : [];
			const extensionFilters = filters
				.flatMap((filter) =>
					Array.isArray(filter?.extensions) ? filter.extensions : [],
				)
				.map((extension) => String(extension).trim())
				.filter(Boolean);
			const allowedFileTypes =
				extensionFilters.length > 0 && !extensionFilters.includes("*")
					? extensionFilters.join(",")
					: "*";
				const paths = await openFileDialog({
					startingFolder:
						typeof options?.defaultPath === "string"
							? options.defaultPath
							: "~/",
					allowedFileTypes,
					canChooseDirectory,
					canChooseFiles: canChooseFilesForRuntime,
					allowsMultipleSelection,
				});
				let filePaths = (Array.isArray(paths) ? paths : [])
					.map((filePath) => String(filePath))
					.filter(Boolean);
				if (hasOpenDirectory && !hasOpenFile) {
					filePaths = filePaths.filter((filePath) => {
						try {
							return fs.statSync(filePath).isDirectory();
						} catch {
							return false;
						}
					});
				}
				return { canceled: filePaths.length === 0, filePaths };
			}
		return { canceled: true, filePaths: [] };
	},
	async showSaveDialog() {
		return { canceled: true, filePath: undefined };
	},
};

const webRequest = {
	onBeforeRequest: noop,
	onBeforeSendHeaders: noop,
	onHeadersReceived: noop,
};

const defaultSession = Object.assign(new EventEmitter(), {
	webRequest,
	protocol,
	setPermissionRequestHandler: noop,
	setPermissionCheckHandler: noop,
	setProxy: async () => undefined,
	clearCache: async () => undefined,
	clearStorageData: async () => undefined,
	fetch: globalThis.fetch?.bind(globalThis),
	cookies: {
		get: async () => [],
		set: async () => undefined,
		remove: async () => undefined,
		flushStore: async () => undefined,
	},
});

export const session = {
	defaultSession,
	fromPartition() {
		return defaultSession;
	},
};

export class Session {}

const systemPreferencesValues = new Map();
export const systemPreferences = {
	getUserDefault(key) {
		return systemPreferencesValues.get(key);
	},
	setUserDefault(key, _type, value) {
		systemPreferencesValues.set(key, value);
	},
};

export const powerMonitor = Object.assign(new EventEmitter(), {
	getSystemIdleState() {
		return "active";
	},
	getSystemIdleTime() {
		return 0;
	},
	getCurrentThermalState() {
		return "nominal";
	},
	isOnBatteryPower() {
		return false;
	},
});

let nextPowerSaveBlockerId = 1;
const powerSaveBlockers = new Set();
export const powerSaveBlocker = {
	start() {
		const id = nextPowerSaveBlockerId++;
		powerSaveBlockers.add(id);
		return id;
	},
	stop(id) {
		powerSaveBlockers.delete(id);
	},
	isStarted(id) {
		return powerSaveBlockers.has(id);
	},
};

const primaryDisplay = {
	id: 1,
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	workArea: { x: 0, y: 0, width: 1920, height: 1080 },
	scaleFactor: 2,
};
export const screen = Object.assign(new EventEmitter(), {
	getPrimaryDisplay() {
		return primaryDisplay;
	},
	getAllDisplays() {
		return [primaryDisplay];
	},
	getDisplayMatching() {
		return primaryDisplay;
	},
	getCursorScreenPoint() {
		return { x: 0, y: 0 };
	},
});

const browserWindows = new Map();
const webContentsById = new Map();
let nextWindowId = 1;
let nextWebContentsId = 1;
let focusedWindowId = undefined;

class WebContentsImpl extends EventEmitter {
	constructor(ownerWindow) {
		super();
		this.ownerWindow = ownerWindow;
		this.id = nextWebContentsId++;
		this._devToolsOpened = false;
		this.session = defaultSession;
		this.mainFrame = {
			processId: process.pid,
			framesInSubtree: [],
			collectJavaScriptCallStack: async () => "",
			parent: undefined,
		};
		this.navigationHistory = {
			canGoBack: () => false,
			canGoForward: () => false,
		};
		this.debugger = Object.assign(new EventEmitter(), {
			attached: false,
			attach() {
				this.attached = true;
			},
			detach() {
				this.attached = false;
			},
			isAttached() {
				return this.attached;
			},
			sendCommand: async () => ({}),
		});

		const nativeWebview = ownerWindow?._nativeWindow?.webview;
		if (nativeWebview?.on) {
			nativeWebview.on("did-navigate", () => this.emit("did-navigate"));
			nativeWebview.on("did-navigate-in-page", () =>
				this.emit("did-navigate-in-page"),
			);
			nativeWebview.on("dom-ready", () => this.emit("did-finish-load"));
		}
	}

	getURL() {
		return this.ownerWindow._url ?? "";
	}

	isDestroyed() {
		return this.ownerWindow._destroyed;
	}

	isOffscreen() {
		return false;
	}

	isDevToolsOpened() {
		return this._devToolsOpened;
	}

	isDevToolsFocused() {
		return this._devToolsOpened;
	}

	isFocused() {
		return focusedWindowId === this.ownerWindow.id;
	}

	getType() {
		return "window";
	}

	getOSProcessId() {
		return process.pid;
	}

	loadURL(url) {
		this.ownerWindow._url = url;
		const runtimeUrl = translateElectronUrlToRuntime(url);
		const formatUrlForLog = (value) => {
			if (typeof value !== "string") {
				return value;
			}
			return value.length > 300
				? `${value.slice(0, 300)}... (${value.length} chars)`
				: value;
		};
		if (runtimeDebug) {
			console.log(
				"[electrobun-runtime-shim] webContents.loadURL",
				formatUrlForLog(url),
				"=>",
				formatUrlForLog(runtimeUrl),
			);
		}
		this.ownerWindow._nativeWindow?.webview?.loadURL?.(runtimeUrl);
		if (runtimeDebug) {
			setTimeout(() => {
				const webview = this.ownerWindow?._nativeWindow?.webview;
				console.log(
					"[electrobun-runtime-shim] webview object:",
					typeof webview,
					webview ? Object.keys(Object.getPrototypeOf(webview)) : "null",
				);
				console.log(
					"[electrobun-runtime-shim] executeJavascript fn:",
					typeof webview?.executeJavascript,
				);

				webview?.executeJavascript?.(`
						const diag = {
							vscode: !!window.vscode,
							preloadBootstrap: !!window.__vscodePreloadBootstrapLoaded,
							preloadRan: !!window.__preloadRan,
							requireType: typeof window.require,
							href: String(window.location.href || ''),
							bodyChildren: document.body ? document.body.children.length : -1,
							monacoWorkbench: !!document.querySelector('.monaco-workbench'),
							workbenchContainer: !!document.querySelector('#workbench-container'),
							bodyBg: getComputedStyle(document.body || document.documentElement).backgroundColor
						};
						fetch(window.location.origin + "/DIAGNOSTICS?data=" + encodeURIComponent(JSON.stringify(diag)));
					`);
			}, 2000);
		}
		this.emit("did-start-loading");
		this.emit("did-navigate");
		this.emit("did-finish-load");
		this.emit("did-stop-loading");
		this.ownerWindow.emit("ready-to-show");
	}

	send(channel, ...args) {
		const ownerWindowId =
			typeof this.ownerWindow?.id === "number" ? this.ownerWindow.id : undefined;
		if (typeof ownerWindowId === "number" && typeof rendererEventBridge.send === "function") {
			rendererEventBridge.send(ownerWindowId, channel, args);
			return;
		}
		this.emit("ipc-message", { sender: this, ports: [] }, channel, ...args);
	}

	postMessage(channel, message, transfer) {
		const ownerWindowId =
			typeof this.ownerWindow?.id === "number" ? this.ownerWindow.id : undefined;
		if (typeof ownerWindowId === "number" && typeof rendererEventBridge.send === "function") {
			const eventArgs = [message];
			if (
				Array.isArray(transfer) &&
				transfer.length > 0 &&
				typeof rendererEventBridge.registerTransferPort === "function"
			) {
				const portTokens = transfer
					.map((port) => rendererEventBridge.registerTransferPort(ownerWindowId, port))
					.filter((token) => typeof token === "string");
				if (portTokens.length > 0) {
					eventArgs.push({ __vscodePortTokens: portTokens });
				}
			}
			rendererEventBridge.send(ownerWindowId, channel, eventArgs);
			return;
		}
		this.emit(
			"ipc-message",
			{ sender: this, ports: Array.isArray(transfer) ? transfer : [] },
			channel,
			message,
		);
	}

	setWindowOpenHandler() {
		return { action: "deny" };
	}

	setBackgroundThrottling() {}

	executeJavaScript() {
		const executeJavascript =
			this.ownerWindow?._nativeWindow?.webview?.executeJavascript;
		if (typeof executeJavascript === "function") {
			return Promise.resolve(executeJavascript(...arguments));
		}
		return Promise.resolve(undefined);
	}

	focus() {
		this.emit("focus");
	}

	reload() {
		const currentUrl = this.getURL();
		if (typeof currentUrl === "string" && currentUrl.length > 0) {
			this.loadURL(currentUrl);
		}
	}

	openDevTools() {
		this.ownerWindow?._nativeWindow?.webview?.openDevTools?.();
		this._devToolsOpened = true;
		this.emit("devtools-opened");
	}

	closeDevTools() {
		this.ownerWindow?._nativeWindow?.webview?.closeDevTools?.();
		this._devToolsOpened = false;
		this.emit("devtools-closed");
	}

	toggleDevTools() {
		if (this._devToolsOpened) {
			this.closeDevTools();
			return;
		}
		this.openDevTools();
	}
}

export class BrowserWindow extends EventEmitter {
	constructor(options = {}) {
		super();
		this.id = nextWindowId++;
		this._destroyed = false;
		this._visible = options.show !== false;
		this._url = "";
		this._representedFilename = "";
		this._simpleFullScreen = false;
		this._bounds = {
			x: options.x ?? 100,
			y: options.y ?? 100,
			width: options.width ?? 1280,
			height: options.height ?? 800,
		};
		this._minimumSize = [0, 0];
		this._maximumSize = [0, 0];
		this._vscodeWindowConfigChannel = undefined;
		const additionalArgs = Array.isArray(options.webPreferences?.additionalArguments)
			? options.webPreferences.additionalArguments
			: [];
		for (const arg of additionalArgs) {
			if (
				typeof arg === "string" &&
				arg.startsWith("--vscode-window-config=")
			) {
				this._vscodeWindowConfigChannel = arg.slice(
					"--vscode-window-config=".length,
				);
				break;
			}
		}

		this._nativeWindow = undefined;
		if (electrobunRuntime?.BrowserWindow) {
			try {
				// Map Electron titlebar values to Electrobun while keeping native controls visible.
				const runtimeTitleBarStyle =
					options.titleBarStyle === "hiddenInset" ||
					options.titleBarStyle === "hidden"
						? "hiddenInset"
						: "default";
				const runtimeRenderer =
					process.env["VSCODE_ELECTROBUN_RENDERER"] === "cef"
						? "cef"
						: "native";
				// Electrobun sandbox mode disables the internal bridge VS Code preload depends on.
				const runtimeSandbox = false;
				const runtimePreloadScript = createElectrobunCompatiblePreloadScript(
					options.webPreferences?.preload ?? null,
					options.webPreferences?.additionalArguments ?? [],
				);
				if (runtimeDebug) {
					const preloadDebugPath = path.join(
						process.cwd(),
						".build",
						"electrobun-preload.generated.js",
					);
					try {
						fs.mkdirSync(path.dirname(preloadDebugPath), { recursive: true });
						fs.writeFileSync(preloadDebugPath, runtimePreloadScript, "utf8");
					} catch {}
					try {
						// Validate before passing to runtime: Electrobun executes preload as classic script.
						new Function(runtimePreloadScript);
					} catch (error) {
						console.error(
							"[electrobun-runtime-shim] Invalid generated preload script",
							error,
						);
					}
				}
				if (runtimeDebug) {
					console.log(
						"[electrobun-runtime-shim] Generated preload script",
						{
							length: runtimePreloadScript.length,
							preloadPath: options.webPreferences?.preload ?? null,
						},
					);
				}
				this._nativeWindow = new electrobunRuntime.BrowserWindow({
					title: options.title ?? "Code - OSS",
					frame: { ...this._bounds },
					url: null,
					html: null,
					preload: runtimePreloadScript,
					renderer: runtimeRenderer,
					titleBarStyle: runtimeTitleBarStyle,
					transparent: Boolean(options.transparent),
					sandbox: runtimeSandbox,
				});
				if (typeof this._nativeWindow.id === "number") {
					this.id = this._nativeWindow.id;
				}
				console.log(
					"[electrobun-runtime-shim] Created native BrowserWindow",
					this.id,
					this._bounds,
					{
						titleBarStyle: options.titleBarStyle,
						runtimeTitleBarStyle,
						runtimeRenderer,
						runtimeSandbox,
					},
				);
				if (this._visible) {
					console.log(
						"[electrobun-runtime-shim] Showing native BrowserWindow",
						this.id,
					);
					this._nativeWindow.show?.();
					this._nativeWindow.focus?.();

					if (runtimeDebug) {
						try {
							this._nativeWindow.webview?.openDevTools?.();
						} catch (e) {
							console.error("Failed to open devtools", e);
						}
					}
				}
				this._nativeWindow.on?.("focus", () => {
					focusedWindowId = this.id;
					this.webContents.emit("focus");
					this.emit("focus");
				});
				this._nativeWindow.on?.("move", () => this.emit("move"));
				this._nativeWindow.on?.("resize", () => this.emit("resize"));
				this._nativeWindow.on?.("close", () => {
					if (this._destroyed) {
						return;
					}
					this.emit("close", { preventDefault() {} });
					this._destroyed = true;
					this._visible = false;
					vscodeWindowConfigurations.delete(this.id);
					if (this._vscodeWindowConfigChannel) {
						vscodeWindowConfigurationsByChannel.delete(
							this._vscodeWindowConfigChannel,
						);
					}
					browserWindows.delete(this.id);
					webContentsById.delete(this.webContents.id);
					this.emit("closed");
				});
			} catch (error) {
				console.warn(
					"[electrobun-runtime-shim] Failed to create native BrowserWindow, fallback to stub window.",
					error,
				);
				this._nativeWindow = undefined;
			}
		}

		this.webContents = new WebContentsImpl(this);
		browserWindows.set(this.id, this);
		webContentsById.set(this.webContents.id, this.webContents);
		focusedWindowId = this.id;
	}

	destroy() {
		this.close();
	}

	close() {
		if (this._destroyed) {
			return;
		}
		if (this._nativeWindow) {
			this._nativeWindow.close?.();
			return;
		}
		this.emit("close", { preventDefault() {} });
		this._destroyed = true;
		vscodeWindowConfigurations.delete(this.id);
		if (this._vscodeWindowConfigChannel) {
			vscodeWindowConfigurationsByChannel.delete(this._vscodeWindowConfigChannel);
		}
		browserWindows.delete(this.id);
		webContentsById.delete(this.webContents.id);
		this.emit("closed");
	}

	isDestroyed() {
		return this._destroyed;
	}

	show() {
		this._visible = true;
		focusedWindowId = this.id;
		this._nativeWindow?.show?.();
		this._nativeWindow?.focus?.();
	}

	showInactive() {
		this.show();
	}

	hide() {
		this._visible = false;
	}

	isVisible() {
		return this._visible;
	}

	focus() {
		focusedWindowId = this.id;
		this._nativeWindow?.focus?.();
		this.webContents.focus();
		this.emit("focus");
	}

	blur() {}

	isFocused() {
		return focusedWindowId === this.id;
	}

	loadURL(url) {
		this.webContents.loadURL(url);
		return Promise.resolve();
	}

	setBounds(bounds) {
		this._bounds = { ...this._bounds, ...bounds };
		this._nativeWindow?.setFrame?.(
			this._bounds.x,
			this._bounds.y,
			this._bounds.width,
			this._bounds.height,
		);
	}

	getBounds() {
		if (this._nativeWindow?.getFrame) {
			const frame = this._nativeWindow.getFrame();
			this._bounds = { ...frame };
		}
		return { ...this._bounds };
	}

	setPosition(x, y) {
		this._bounds.x = x;
		this._bounds.y = y;
		this._nativeWindow?.setPosition?.(x, y);
	}

	getPosition() {
		return [this._bounds.x, this._bounds.y];
	}

	setSize(width, height) {
		this._bounds.width = width;
		this._bounds.height = height;
		this._nativeWindow?.setSize?.(width, height);
	}

	getSize() {
		return [this._bounds.width, this._bounds.height];
	}

	setMinimumSize(width, height) {
		this._minimumSize = [Math.max(0, width | 0), Math.max(0, height | 0)];
		this._nativeWindow?.setMinimumSize?.(width, height);
	}

	getMinimumSize() {
		if (typeof this._nativeWindow?.getMinimumSize === "function") {
			return this._nativeWindow.getMinimumSize();
		}
		return [...this._minimumSize];
	}

	setMaximumSize(width, height) {
		this._maximumSize = [Math.max(0, width | 0), Math.max(0, height | 0)];
		this._nativeWindow?.setMaximumSize?.(width, height);
	}

	getMaximumSize() {
		if (typeof this._nativeWindow?.getMaximumSize === "function") {
			return this._nativeWindow.getMaximumSize();
		}
		return [...this._maximumSize];
	}

	minimize() {
		this._nativeWindow?.minimize?.();
	}

	restore() {
		this._nativeWindow?.unminimize?.();
	}

	isMinimized() {
		if (this._nativeWindow?.isMinimized) {
			return Boolean(this._nativeWindow.isMinimized());
		}
		return false;
	}

	maximize() {
		this._nativeWindow?.maximize?.();
	}

	unmaximize() {
		this._nativeWindow?.unmaximize?.();
	}

	isMaximized() {
		if (this._nativeWindow?.isMaximized) {
			return Boolean(this._nativeWindow.isMaximized());
		}
		return false;
	}

	setFullScreen(fullscreen) {
		this._nativeWindow?.setFullScreen?.(Boolean(fullscreen));
	}

	isFullScreen() {
		if (this._nativeWindow?.isFullScreen) {
			return Boolean(this._nativeWindow.isFullScreen());
		}
		return false;
	}

	setSimpleFullScreen(fullscreen) {
		this._simpleFullScreen = Boolean(fullscreen);
	}

	isSimpleFullScreen() {
		return this._simpleFullScreen;
	}

	setAlwaysOnTop(alwaysOnTop) {
		this._nativeWindow?.setAlwaysOnTop?.(Boolean(alwaysOnTop));
	}

	isAlwaysOnTop() {
		if (this._nativeWindow?.isAlwaysOnTop) {
			return Boolean(this._nativeWindow.isAlwaysOnTop());
		}
		return false;
	}

	setTitle(title) {
		this._nativeWindow?.setTitle?.(title);
	}

	setSheetOffset() {}

	setWindowButtonPosition() {}

	getWindowButtonPosition() {
		return { x: 0, y: 0 };
	}

	setTitleBarOverlay() {}

	setRepresentedFilename(filename = "") {
		this._representedFilename = filename;
	}

	setVSCodeWindowConfig(configuration) {
		this._vscodeWindowConfig = configuration;
		vscodeWindowConfigurations.set(this.id, configuration);
		if (this._vscodeWindowConfigChannel) {
			vscodeWindowConfigurationsByChannel.set(
				this._vscodeWindowConfigChannel,
				configuration,
			);
		}
	}

	getRepresentedFilename() {
		return this._representedFilename;
	}

	setDocumentEdited() {}

	isDocumentEdited() {
		return false;
	}

	setMenuBarVisibility() {}

	setAutoHideMenuBar() {}

	setBrowserView() {}

	addBrowserView() {}

	removeBrowserView() {}

	setVibrancy() {}

	setBackgroundColor() {}

	setTouchBar() {}

	getNativeWindowHandle() {
		return Buffer.from(String(this.id));
	}

	static getAllWindows() {
		return [...browserWindows.values()];
	}

	static getFocusedWindow() {
		return focusedWindowId ? browserWindows.get(focusedWindowId) : undefined;
	}

	static fromWebContents(webContentsInstance) {
		return webContentsInstance?.ownerWindow;
	}
}

export class WebContentsView {
	constructor(options = {}) {
		this.webContents =
			options.webContents ??
			new WebContentsImpl({ _url: "", _destroyed: false, id: 0 });
	}

	setBackgroundColor() {}

	setBounds() {}
}

export const webContents = {
	getAllWebContents() {
		return [...webContentsById.values()];
	},
	fromId(id) {
		return webContentsById.get(id);
	},
	fromDevToolsTargetId() {
		return undefined;
	},
};

export class MessagePortMain extends EventEmitter {
	postMessage(message) {
		this.emit("message", { data: message, ports: [] });
	}

	start() {}

	close() {}
}

export class MessageChannelMain {
	constructor() {
		const channel = new MessageChannel();
		this.port1 = channel.port1;
		this.port2 = channel.port2;
	}
}

const runtimeSharedState =
	globalThis.__electrobunRuntimeSharedState ??
	(globalThis.__electrobunRuntimeSharedState = {
		ipcHandlers: new Map(),
		ipcMainEmitter: new EventEmitter(),
	});
const ipcHandlers = runtimeSharedState.ipcHandlers;
const ipcMainEmitter = runtimeSharedState.ipcMainEmitter;

export const ipcMain = Object.assign(ipcMainEmitter, {
	handle(channel, handler) {
		if (typeof channel === "string" && channel.startsWith("vscode:")) {
			console.log("[electrobun-runtime-shim] ipcMain.handle", channel);
		}
		ipcHandlers.set(channel, handler);
	},
	handleOnce(channel, handler) {
		ipcHandlers.set(channel, async (...args) => {
			ipcHandlers.delete(channel);
			return handler(...args);
		});
	},
	removeHandler(channel) {
		ipcHandlers.delete(channel);
	},
});

export const ipcRenderer = Object.assign(new EventEmitter(), {
	send(channel, ...args) {
		if (typeof channel === "string" && channel.startsWith("vscode:")) {
			console.log("[electrobun-runtime-shim] ipcRenderer.send", channel);
		}
		ipcMainEmitter.emit(channel, { sender: ipcRenderer }, ...args);
	},
	async invoke(channel, ...args) {
		const handler = ipcHandlers.get(channel);
		if (typeof channel === "string" && channel.startsWith("vscode:")) {
			console.log(
				"[electrobun-runtime-shim] ipcRenderer.invoke",
				channel,
				handler ? "handler-found" : "handler-missing",
			);
		}
		if (!handler) {
			return undefined;
		}
		return handler({ sender: ipcRenderer }, ...args);
	},
	postMessage(channel, message, transfer) {
		ipcMainEmitter.emit(
			channel,
			{ sender: ipcRenderer, ports: transfer ?? [] },
			message,
		);
	},
});

ipcMain.handle("vscode:electrobunRendererPing", (_event, _stage, _details) => {
	return true;
});

async function registerElectrobunInternalBridgeHandlers() {
	try {
		const nativeModulePath = path.join(
			import.meta.dirname,
			"..",
			"..",
			"node_modules",
			"electrobun",
			"dist",
			"api",
			"bun",
			"proc",
			"native.ts",
		);
		const nativeModule = await import(pathToFileURL(nativeModulePath).href);
		const internalRpcHandlers = nativeModule?.internalRpcHandlers;
		if (!internalRpcHandlers?.request || !internalRpcHandlers?.message) {
			return;
		}
		const pendingRendererEvents = new Map();
		const flushRendererEvents = (windowId) => {
			const pending = pendingRendererEvents.get(windowId);
			if (!pending) {
				return;
			}
			pending.scheduled = false;
			if (!pending.queue.length) {
				pendingRendererEvents.delete(windowId);
				return;
			}

			const nativeWebview =
				browserWindows.get(windowId)?._nativeWindow?.webview;
			if (
				!nativeWebview?.executeJavascript &&
				typeof nativeWebview?.sendInternalMessageViaExecute !== "function"
			) {
				appendRuntimeDiag(
					`[main] missing-native-webview-for-send windowId=${String(windowId)}`,
				);
				pending.queue.length = 0;
				pendingRendererEvents.delete(windowId);
				return;
			}

			const batchedPayload =
				pending.queue.length === 1
					? pending.queue[0]
					: pending.queue.splice(0, pending.queue.length);
			pending.queue.length = 0;
			if (!pending.scheduled) {
				pendingRendererEvents.delete(windowId);
			}

			try {
				if (typeof nativeWebview.sendInternalMessageViaExecute === "function") {
					nativeWebview.sendInternalMessageViaExecute(batchedPayload);
					return;
				}
				nativeWebview.executeJavascript(
					`window.__electrobun?.receiveInternalMessageFromBun(${JSON.stringify(batchedPayload)});`,
				);
			} catch (error) {
				console.error(
					"[electrobun-runtime-shim] Failed to flush IPC event batch to renderer",
					windowId,
					error,
				);
			}
		};
		const enqueueRendererEvent = (windowId, payload) => {
			let pending = pendingRendererEvents.get(windowId);
			if (!pending) {
				pending = { queue: [], scheduled: false };
				pendingRendererEvents.set(windowId, pending);
			}
			pending.queue.push(payload);
			if (!pending.scheduled) {
				pending.scheduled = true;
				setTimeout(() => flushRendererEvents(windowId), 0);
			}
		};
		const sendIpcEventToRenderer = (windowId, channel, args) => {
			if (typeof windowId !== "number") {
				appendRuntimeDiag(
					`[main] no-window-for-send windowId=${String(windowId)} channel=${String(channel)}`,
				);
				return;
			}
			const payload = {
				type: "event",
				channel,
				args: Array.isArray(args)
					? args.map(serializeIpcArgForRenderer)
					: [],
			};
			enqueueRendererEvent(windowId, payload);
		};
		const rendererVirtualPorts = new Map();
		let nextRendererVirtualPortId = 1;
		const disposeRendererVirtualPort = (portId) => {
			const entry = rendererVirtualPorts.get(portId);
			if (!entry) {
				return;
			}
			rendererVirtualPorts.delete(portId);
			try {
				entry.port?.removeListener?.("message", entry.onMessage);
			} catch {}
			try {
				entry.port?.removeListener?.("close", entry.onClose);
			} catch {}
			try {
				entry.port?.close?.();
			} catch {}
		};
		const registerRendererVirtualPort = (windowId, port) => {
			if (typeof windowId !== "number" || !port) {
				return undefined;
			}
			const portId = `vp-${windowId}-${nextRendererVirtualPortId++}`;
			const onMessage = (eventOrData) => {
				const payload =
					eventOrData && typeof eventOrData === "object" && "data" in eventOrData
						? eventOrData.data
						: eventOrData;
				sendIpcEventToRenderer(windowId, "vscode:__virtualPortMessage", [
					portId,
					payload,
				]);
			};
			const onClose = () => {
				sendIpcEventToRenderer(windowId, "vscode:__virtualPortClose", [portId]);
				disposeRendererVirtualPort(portId);
			};
			rendererVirtualPorts.set(portId, { windowId, port, onMessage, onClose });
			try {
				port.start?.();
			} catch {}
			try {
				port.on?.("message", onMessage);
			} catch {}
			try {
				port.on?.("close", onClose);
			} catch {}
			return portId;
		};
			rendererEventBridge.send = sendIpcEventToRenderer;
			rendererEventBridge.registerTransferPort = registerRendererVirtualPort;
			const sendInvokeResponseToRenderer = (windowId, requestId, success, payload) => {
			if (typeof windowId !== "number" || typeof requestId !== "string") {
				return;
			}
			const nativeWebview =
				browserWindows.get(windowId)?._nativeWindow?.webview;
			if (
				!nativeWebview?.executeJavascript &&
				typeof nativeWebview?.sendInternalMessageViaExecute !== "function"
			) {
				return;
			}
			try {
				const responsePayload = {
					type: "response",
					id: requestId,
					success: Boolean(success),
					payload: serializeIpcArgForRenderer(payload),
				};
				if (typeof nativeWebview.sendInternalMessageViaExecute === "function") {
					nativeWebview.sendInternalMessageViaExecute(responsePayload);
					return;
				}
				nativeWebview.executeJavascript(
					`window.__electrobun?.receiveInternalMessageFromBun(${JSON.stringify(responsePayload)});`,
				);
			} catch (error) {
				console.error(
					"[electrobun-runtime-shim] Failed to send IPC invoke response to renderer",
					requestId,
					error,
				);
			}
		};
			const createRendererEventSender = (windowId, hostWebviewId) => ({
				id: typeof windowId === "number" ? windowId : -1,
				send(channel, ...eventArgs) {
					sendIpcEventToRenderer(windowId, channel, eventArgs);
				},
			postMessage(channel, message, transfer) {
				const eventArgs = [message];
				if (Array.isArray(transfer) && transfer.length > 0) {
					const portTokens = transfer
						.map((port) => registerRendererVirtualPort(windowId, port))
						.filter((token) => typeof token === "string");
					if (portTokens.length > 0) {
						eventArgs.push({ __vscodePortTokens: portTokens });
					}
					}
					sendIpcEventToRenderer(windowId, channel, eventArgs);
				},
				isDestroyed() {
					return false;
				},
				getURL() {
					return "";
				},
				getOSProcessId() {
					return process.pid;
				},
				reload() {},
				openDevTools() {},
				toggleDevTools() {},
			});
			const resolveRendererEventSender = (windowId, hostWebviewId) => {
				if (typeof windowId === "number") {
					const webContents = browserWindows.get(windowId)?.webContents;
					if (webContents) {
						return webContents;
					}
				}
				return createRendererEventSender(windowId, hostWebviewId);
			};
			internalRpcHandlers.request.vscodeIpcInvoke = (params = {}) => {
			const { requestId, channel, args = [], windowId, hostWebviewId } = params;
			const isWindowConfigChannel =
				typeof channel === "string" &&
				/^vscode:[0-9a-f-]{36}$/i.test(channel);
			appendRuntimeDiag(
				`[main] invoke channel=${String(channel)} windowId=${String(windowId)} args=${Array.isArray(args) ? args.length : 0}`,
			);
			if (
				typeof windowId === "number" &&
				typeof hostWebviewId === "number"
			) {
				rendererHostWebviewIds.set(windowId, hostWebviewId);
			}
				const sender = resolveRendererEventSender(windowId, hostWebviewId);

			// Startup critical: preload requests shell env very early.
			if (channel === "vscode:fetchShellEnv") {
				return {};
			}

			// Window configuration handler in VS Code main is async and Electrobun internal
			// RPC request path currently expects synchronous payloads.
			if (isWindowConfigChannel) {
				const config =
					vscodeWindowConfigurationsByChannel.get(channel) ||
					(typeof windowId === "number"
						? vscodeWindowConfigurations.get(windowId)
						: undefined);
				if (config && typeof config === "object") {
					appendRuntimeDiag(
						`[main] config-hit channel=${channel} windowId=${String(windowId)}`,
					);
					return config;
				}
				appendRuntimeDiag(
					`[main] config-miss channel=${channel} windowId=${String(windowId)}`,
				);
			}

			const handler = ipcHandlers.get(channel);
			if (handler) {
				try {
					const result = handler({ sender }, ...args);
					if (result && typeof result.then === "function") {
						const asyncRequestId =
							typeof requestId === "string" && requestId.length > 0
								? requestId
								: `vscode-ipc-async-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
						Promise.resolve(result).then(
							(resolved) => {
								sendInvokeResponseToRenderer(
									windowId,
									asyncRequestId,
									true,
									resolved,
								);
							},
							(error) => {
								sendInvokeResponseToRenderer(
									windowId,
									asyncRequestId,
									false,
									error?.stack || String(error),
								);
							},
						);
						return { __vscodeAsyncInvoke: true, requestId: asyncRequestId };
					}
					return result;
				} catch (error) {
					console.error(
						"[electrobun-runtime-shim] vscodeIpcInvoke handler failed",
						channel,
						error,
					);
					return undefined;
				}
			}

			// Fallback for window config channels when renderer argv channel does
			// not exactly match the registered handler name.
			if (isWindowConfigChannel) {
				return (
					vscodeWindowConfigurationsByChannel.get(channel) ||
					vscodeWindowConfigurations.get(windowId)
				);
			}

			if (typeof channel === "string" && channel.startsWith("vscode:")) {
				appendRuntimeDiag(
					`[main] invoke-miss channel=${channel} windowId=${String(windowId)}`,
				);
			}

			return undefined;
		};

		internalRpcHandlers.message.vscodeIpcSend = (params = {}) => {
			const { channel, args = [], windowId, hostWebviewId } = params;
			appendRuntimeDiag(
				`[main] send channel=${String(channel)} args=${Array.isArray(args) ? args.length : 0}`,
			);
			if (
				typeof windowId === "number" &&
				typeof hostWebviewId === "number"
			) {
				rendererHostWebviewIds.set(windowId, hostWebviewId);
			}
				const sender = resolveRendererEventSender(windowId, hostWebviewId);
			const normalizedArgs = Array.isArray(args)
				? args.map(reviveSerializedIpcArg)
				: [];

			// IPC `vscode:message` expects a binary payload in args[0]. Skip malformed emissions.
			if (channel === "vscode:message" && normalizedArgs[0] === undefined) {
				return;
			}

			ipcMainEmitter.emit(channel, { sender }, ...normalizedArgs);
		};
		internalRpcHandlers.message.vscodeVirtualPortPost = (params = {}) => {
			const { portId, data, windowId } = params;
			if (typeof portId !== "string") {
				return;
			}
			const entry = rendererVirtualPorts.get(portId);
			if (!entry) {
				return;
			}
			if (typeof windowId === "number" && entry.windowId !== windowId) {
				return;
			}
			try {
				entry.port?.postMessage?.(reviveSerializedIpcArg(data));
			} catch (error) {
				console.warn(
					"[electrobun-runtime-shim] Failed to post to renderer virtual port",
					portId,
					error,
				);
			}
		};
	} catch (error) {
		console.warn(
			"[electrobun-runtime-shim] Failed to register internal bridge IPC handlers.",
			error,
		);
	}
}

await registerElectrobunInternalBridgeHandlers();

export const contextBridge = {
	exposeInMainWorld(name, value) {
		globalThis[name] = value;
	},
};

export const webFrame = {
	setZoomLevel: noop,
	setZoomFactor: noop,
};

export const webUtils = {
	getPathForFile(file) {
		return file?.path ?? "";
	},
};

export const utilityProcess = {
	fork(modulePath, args = [], options = {}) {
		const forkOptions = { ...options };
		forkOptions.env = {
			...(process.env ?? {}),
			...(forkOptions.env ?? {}),
			VSCODE_ELECTROBUN_PARENT_PORT: "1",
		};
		const stdioOption = forkOptions.stdio;
		if (!stdioOption || stdioOption === "pipe") {
			forkOptions.stdio = ["pipe", "pipe", "pipe", "ipc"];
		} else if (Array.isArray(stdioOption) && !stdioOption.includes("ipc")) {
			forkOptions.stdio = [...stdioOption, "ipc"];
		}

		const child = forkChildProcess(modulePath, args, forkOptions);
		const bridgedTransferPorts = new Map();
		let nextTransferPortId = 1;
		const disposeBridgedTransferPort = (portId) => {
			const entry = bridgedTransferPorts.get(portId);
			if (!entry) {
				return;
			}
			bridgedTransferPorts.delete(portId);
			try {
				entry.port?.removeListener?.("message", entry.onMessage);
			} catch {}
			try {
				entry.port?.removeListener?.("close", entry.onClose);
			} catch {}
			try {
				entry.port?.close?.();
			} catch {}
		};
		const registerBridgedTransferPort = (port) => {
			if (!port) {
				return undefined;
			}
			const portId = `cp-port-${nextTransferPortId++}`;
			const onMessage = (eventOrData) => {
				const data =
					eventOrData && typeof eventOrData === "object" && "data" in eventOrData
						? eventOrData.data
						: eventOrData;
				child.send?.({
					__vscodeParentPortPortMessage: true,
					id: portId,
					data: serializeIpcArgForRenderer(data),
				});
			};
			const onClose = () => {
				child.send?.({ __vscodeParentPortPortClose: true, id: portId });
				disposeBridgedTransferPort(portId);
			};
			bridgedTransferPorts.set(portId, { port, onMessage, onClose });
			try {
				port.start?.();
			} catch {}
			try {
				port.on?.("message", onMessage);
			} catch {}
			try {
				port.on?.("close", onClose);
			} catch {}
			return portId;
		};
		const handleChildBridgeMessage = (message) => {
			if (!message || typeof message !== "object") {
				return;
			}
			if (
				message.__vscodeParentPortPortPost === true &&
				typeof message.id === "string"
			) {
				const entry = bridgedTransferPorts.get(message.id);
				if (entry?.port?.postMessage) {
					entry.port.postMessage(reviveSerializedIpcArg(message.data));
				}
				return;
			}
			if (
				message.__vscodeParentPortPortClose === true &&
				typeof message.id === "string"
			) {
				disposeBridgedTransferPort(message.id);
			}
		};
		child.on("message", handleChildBridgeMessage);
		child.once("exit", () => {
			child.removeListener("message", handleChildBridgeMessage);
			for (const portId of Array.from(bridgedTransferPorts.keys())) {
				disposeBridgedTransferPort(portId);
			}
		});
		child.postMessage = (message, transfer) => {
			if (message === undefined || typeof child.send !== "function") {
				return false;
			}
			if (Array.isArray(transfer) && transfer.length > 0) {
				const transferIds = transfer
					.map((port) => registerBridgedTransferPort(port))
					.filter((id) => typeof id === "string");
				return child.send({
					__vscodeParentPortMessage: true,
					data: serializeIpcArgForRenderer(message),
					transferIds,
				});
			}
			return child.send(message);
		};
		return child;
	},
};

export class TouchBar {
	constructor(options = {}) {
		this.items = options.items ?? [];
	}
}

TouchBar.TouchBarSegmentedControl = class TouchBarSegmentedControl {
	constructor(options = {}) {
		this.segments = options.segments ?? [];
		this.mode = options.mode;
		this.segmentStyle = options.segmentStyle;
		this.change = options.change ?? noop;
	}
};

export const nativeImage = {
	createFromPath(path) {
		return {
			path,
			isEmpty() {
				return false;
			},
		};
	},
};

export const safeStorage = {
	isEncryptionAvailable() {
		return true;
	},
	encryptString(value) {
		return Buffer.from(String(value), "utf8");
	},
	decryptString(value) {
		return Buffer.from(value).toString("utf8");
	},
};

export const net = {
	request() {
		const request = new EventEmitter();
		request.setHeader = noop;
		request.removeHeader = noop;
		request.write = noop;
		request.end = () => request.emit("finish");
		request.abort = () => request.emit("abort");
		return request;
	},
	fetch: globalThis.fetch?.bind(globalThis),
};

// Runtime placeholders for imported symbols that are used primarily as types.
export const AuthInfo = Object;
export const AuthenticationResponseDetails = Object;
export const BaseWindow = BrowserWindow;
export const BeforeSendResponse = Object;
export const BrowserWindowConstructorOptions = Object;
export const Details = Object;
export const Display = Object;
export const Event = Object;
export const GPUFeatureStatus = Object;
export const HandlerDetails = Object;
export const HeadersReceivedResponse = Object;
export const IpcMainEvent = Object;
export const JumpListCategory = Object;
export const JumpListItem = Object;
export const KeyboardEvent = Object;
export const MenuItemConstructorOptions = Object;
export const MessageBoxOptions = Object;
export const MessageBoxReturnValue = Object;
export const OnBeforeSendHeadersListenerDetails = Object;
export const OnHeadersReceivedListenerDetails = Object;
export const OpenDevToolsOptions = Object;
export const OpenDialogOptions = Object;
export const OpenDialogReturnValue = Object;
export const Rectangle = Object;
export const SaveDialogOptions = Object;
export const SaveDialogReturnValue = Object;
export const UtilityProcess = Object;
export const WebContents = Object;
export const WebFrameMain = Object;

const defaultExport = {
	app,
	protocol,
	crashReporter,
	Menu,
	MenuItem,
	contentTracing,
	dialog,
	session,
	Session,
	powerMonitor,
	systemPreferences,
	BrowserWindow,
	WebContentsView,
	webContents,
	WebContents,
	WebFrameMain,
	screen,
	shell,
	clipboard,
	Notification,
	powerSaveBlocker,
	utilityProcess,
	UtilityProcess,
	MessageChannelMain,
	MessagePortMain,
	ipcMain,
	ipcRenderer,
	contextBridge,
	webFrame,
	webUtils,
	safeStorage,
	TouchBar,
	nativeImage,
	net,
	AuthInfo,
	AuthenticationResponseDetails,
	BaseWindow,
	BeforeSendResponse,
	BrowserWindowConstructorOptions,
	Details,
	Display,
	Event,
	GPUFeatureStatus,
	HandlerDetails,
	HeadersReceivedResponse,
	IpcMainEvent,
	JumpListCategory,
	JumpListItem,
	KeyboardEvent,
	MenuItemConstructorOptions,
	MessageBoxOptions,
	MessageBoxReturnValue,
	OnBeforeSendHeadersListenerDetails,
	OnHeadersReceivedListenerDetails,
	OpenDevToolsOptions,
	OpenDialogOptions,
	OpenDialogReturnValue,
	Rectangle,
	SaveDialogOptions,
	SaveDialogReturnValue,
};

globalThis.__electrobunRuntimeShimDefault = defaultExport;

export default new Proxy(defaultExport, {
	get(target, key) {
		if (key in target) {
			return target[key];
		}

		// Return a tolerant no-op callable proxy for anything not yet implemented.
		const fallback = new Proxy(() => undefined, {
			get(_t, innerKey) {
				if (innerKey === "then") {
					return undefined;
				}
				return fallback;
			},
			apply() {
				return undefined;
			},
			construct() {
				return {};
			},
		});

		return fallback;
	},
});
