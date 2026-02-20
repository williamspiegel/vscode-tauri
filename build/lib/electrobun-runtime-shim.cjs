'use strict';

const { EventEmitter } = require('node:events');

const noop = () => undefined;

const sharedState = globalThis.__electrobunRuntimeSharedState ?? (globalThis.__electrobunRuntimeSharedState = {
	ipcHandlers: new Map(),
	ipcMainEmitter: new EventEmitter()
});

const ipcHandlers = sharedState.ipcHandlers;
const ipcMainEmitter = sharedState.ipcMainEmitter;

const ipcRenderer = Object.assign(new EventEmitter(), {
	send(channel, ...args) {
		if (typeof channel === 'string' && channel.startsWith('vscode:')) {
			console.log('[electrobun-runtime-shim.cjs] ipcRenderer.send', channel);
		}
		ipcMainEmitter.emit(channel, { sender: ipcRenderer }, ...args);
	},
	async invoke(channel, ...args) {
		if (typeof channel === 'string' && channel.startsWith('vscode:')) {
			console.log('[electrobun-runtime-shim.cjs] ipcRenderer.invoke', channel);
		}
		const handler = ipcHandlers.get(channel);
		if (!handler) {
			if (typeof channel === 'string' && channel.startsWith('vscode:')) {
				console.warn('[electrobun-runtime-shim.cjs] ipcRenderer.invoke missing handler', channel);
			}
			return undefined;
		}
		return handler({ sender: ipcRenderer }, ...args);
	},
	postMessage(channel, message, transfer) {
		ipcMainEmitter.emit(channel, { sender: ipcRenderer, ports: transfer ?? [] }, message);
	}
});

const fallback = {
	ipcRenderer,
	webFrame: {
		setZoomLevel: noop,
		setZoomFactor: noop
	},
	contextBridge: {
		exposeInMainWorld(name, value) {
			globalThis[name] = value;
		}
	},
	webUtils: {
		getPathForFile(file) {
			return file?.path ?? '';
		}
	}
};

const base = globalThis.__electrobunRuntimeShimDefault ?? {};
const exportsObject = { ...base, ...fallback };

module.exports = new Proxy(exportsObject, {
	get(target, key) {
		if (key in target) {
			return target[key];
		}
		return noop;
	}
});
