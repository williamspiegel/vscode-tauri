/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as performance from './vs/base/common/performance.js';
import { EventEmitter } from 'node:events';
import { removeGlobalNodeJsModuleLookupPaths, devInjectNodeModuleLookupPath } from './bootstrap-node.js';
import { bootstrapESM } from './bootstrap-esm.js';

performance.mark('code/fork/start');

//#region Helpers

function pipeLoggingToParent(): void {
	const MAX_STREAM_BUFFER_LENGTH = 1024 * 1024;
	const MAX_LENGTH = 100000;

	/**
	 * Prevent circular stringify and convert arguments to real array
	 */
	function safeToString(args: ArrayLike<unknown>): string {
		const seen: unknown[] = [];
		const argsArray: unknown[] = [];

		// Massage some arguments with special treatment
		if (args.length) {
			for (let i = 0; i < args.length; i++) {
				let arg = args[i];

				// Any argument of type 'undefined' needs to be specially treated because
				// JSON.stringify will simply ignore those. We replace them with the string
				// 'undefined' which is not 100% right, but good enough to be logged to console
				if (typeof arg === 'undefined') {
					arg = 'undefined';
				}

				// Any argument that is an Error will be changed to be just the error stack/message
				// itself because currently cannot serialize the error over entirely.
				else if (arg instanceof Error) {
					const errorObj = arg;
					if (errorObj.stack) {
						arg = errorObj.stack;
					} else {
						arg = errorObj.toString();
					}
				}

				argsArray.push(arg);
			}
		}

		try {
			const res = JSON.stringify(argsArray, function (key, value: unknown) {

				// Objects get special treatment to prevent circles
				if (isObject(value) || Array.isArray(value)) {
					if (seen.indexOf(value) !== -1) {
						return '[Circular]';
					}

					seen.push(value);
				}

				return value;
			});

			if (res.length > MAX_LENGTH) {
				return 'Output omitted for a large object that exceeds the limits';
			}

			return res;
		} catch (error) {
			return `Output omitted for an object that cannot be inspected ('${error.toString()}')`;
		}
	}

	function safeSend(arg: { type: string; severity: string; arguments: string }): void {
		try {
			if (process.send) {
				process.send(arg);
			}
		} catch (error) {
			// Can happen if the parent channel is closed meanwhile
		}
	}

	function isObject(obj: unknown): boolean {
		return typeof obj === 'object'
			&& obj !== null
			&& !Array.isArray(obj)
			&& !(obj instanceof RegExp)
			&& !(obj instanceof Date);
	}

	function safeSendConsoleMessage(severity: 'log' | 'warn' | 'error', args: string): void {
		safeSend({ type: '__$console', severity, arguments: args });
	}

	/**
	 * Wraps a console message so that it is transmitted to the renderer.
	 *
	 * The wrapped property is not defined with `writable: false` to avoid
	 * throwing errors, but rather a no-op setting. See https://github.com/microsoft/vscode-extension-telemetry/issues/88
	 */
	function wrapConsoleMethod(method: 'log' | 'info' | 'warn' | 'error', severity: 'log' | 'warn' | 'error'): void {
		Object.defineProperty(console, method, {
			set: () => { },
			get: () => function () { safeSendConsoleMessage(severity, safeToString(arguments)); },
		});
	}

	/**
	 * Wraps process.stderr/stdout.write() so that it is transmitted to the
	 * renderer or CLI. It both calls through to the original method as well
	 * as to console.log with complete lines so that they're made available
	 * to the debugger/CLI.
	 */
	function wrapStream(streamName: 'stdout' | 'stderr', severity: 'log' | 'warn' | 'error'): void {
		const stream = process[streamName];
		const original = stream.write;

		let buf = '';

		Object.defineProperty(stream, 'write', {
			set: () => { },
			get: () => (chunk: string | Buffer | Uint8Array, encoding: BufferEncoding | undefined, callback: ((err?: Error | null) => void) | undefined) => {
				buf += chunk.toString(encoding);
				const eol = buf.length > MAX_STREAM_BUFFER_LENGTH ? buf.length : buf.lastIndexOf('\n');
				if (eol !== -1) {
					console[severity](buf.slice(0, eol));
					buf = buf.slice(eol + 1);
				}

				original.call(stream, chunk, encoding, callback);
			},
		});
	}

	// Pass console logging to the outside so that we have it in the main side if told so
	if (process.env['VSCODE_VERBOSE_LOGGING'] === 'true') {
		wrapConsoleMethod('info', 'log');
		wrapConsoleMethod('log', 'log');
		wrapConsoleMethod('warn', 'warn');
		wrapConsoleMethod('error', 'error');
	} else {
		console.log = function () { /* ignore */ };
		console.warn = function () { /* ignore */ };
		console.info = function () { /* ignore */ };
		wrapConsoleMethod('error', 'error');
	}

	wrapStream('stderr', 'error');
	wrapStream('stdout', 'log');
}

function handleExceptions(): void {

	// Handle uncaught exceptions
	process.on('uncaughtException', function (err) {
		console.error('Uncaught Exception: ', err);
	});

	// Handle unhandled promise rejections
	process.on('unhandledRejection', function (reason) {
		console.error('Unhandled Promise Rejection: ', reason);
	});
}

function terminateWhenParentTerminates(): void {
	const parentPid = Number(process.env['VSCODE_PARENT_PID']);

	if (typeof parentPid === 'number' && !isNaN(parentPid)) {
		setInterval(function () {
			try {
				process.kill(parentPid, 0); // throws an exception if the main process doesn't exist anymore.
			} catch (e) {
				process.exit();
			}
		}, 5000);
	}
}

function configureCrashReporter(): void {
	const crashReporterProcessType = process.env['VSCODE_CRASH_REPORTER_PROCESS_TYPE'];
	if (crashReporterProcessType) {
		try {
			//@ts-expect-error
			if (process['crashReporter'] && typeof process['crashReporter'].addExtraParameter === 'function' /* Electron only */) {
				//@ts-expect-error
				process['crashReporter'].addExtraParameter('processType', crashReporterProcessType);
			}
		} catch (error) {
			console.error(error);
		}
	}
}

function serializeParentPortPayload(value: unknown): unknown {
	if (Buffer.isBuffer(value)) {
		return { type: 'Buffer', data: Array.from(value) };
	}
	if (value instanceof ArrayBuffer) {
		return { type: 'Buffer', data: Array.from(new Uint8Array(value)) };
	}
	if (ArrayBuffer.isView(value)) {
		return {
			type: 'Buffer',
			data: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
		};
	}
	return value;
}

function reviveParentPortPayload(value: unknown): unknown {
	if (value && typeof value === 'object') {
		const candidate = value as { type?: unknown; data?: unknown };
		if (candidate.type === 'Buffer' && Array.isArray(candidate.data)) {
			return Buffer.from(candidate.data);
		}
	}
	return value;
}

function installElectrobunParentPortPolyfill(): void {
	const utilityProcess = process as NodeJS.Process & { parentPort?: unknown };
	if (utilityProcess.parentPort || !process.send || process.env['VSCODE_ELECTROBUN_PARENT_PORT'] !== '1') {
		return;
	}

	interface IBridgedMessageEvent {
		data: unknown;
		ports: BridgedPort[];
	}

	interface IParentPortEnvelope {
		__vscodeParentPortMessage?: boolean;
		__vscodeParentPortPortMessage?: boolean;
		__vscodeParentPortPortClose?: boolean;
		id?: string;
		data?: unknown;
		transferIds?: string[];
	}

	class BridgedPort extends EventEmitter {
		constructor(private readonly id: string) {
			super();
		}

		postMessage(message: unknown): void {
			try {
				process.send?.({
					__vscodeParentPortPortPost: true,
					id: this.id,
					data: serializeParentPortPayload(message)
				});
			} catch {
				// ignore IPC send failures during shutdown
			}
		}

		start(): void {
			// no-op for compatibility
		}

		close(): void {
			try {
				process.send?.({
					__vscodeParentPortPortClose: true,
					id: this.id
				});
			} catch {
				// ignore IPC send failures during shutdown
			}
			this.emit('close');
		}
	}

	const bridgedPorts = new Map<string, BridgedPort>();
	const getOrCreatePort = (id: string): BridgedPort => {
		const existing = bridgedPorts.get(id);
		if (existing) {
			return existing;
		}
		const created = new BridgedPort(id);
		bridgedPorts.set(id, created);
		return created;
	};

	const parentPort = new EventEmitter() as EventEmitter & { postMessage: (message: unknown) => void };
	parentPort.postMessage = (message: unknown): void => {
		try {
			process.send?.(message);
		} catch {
			// ignore IPC send failures during shutdown
		}
	};

	process.on('message', (rawMessage: unknown) => {
		const envelope = rawMessage as IParentPortEnvelope;
		if (envelope?.__vscodeParentPortMessage) {
			const transferIds = Array.isArray(envelope.transferIds) ? envelope.transferIds : [];
			const ports = transferIds.map(id => getOrCreatePort(String(id)));
			const event: IBridgedMessageEvent = {
				data: reviveParentPortPayload(envelope.data),
				ports
			};
			parentPort.emit('message', event);
			return;
		}
		if (envelope?.__vscodeParentPortPortMessage && typeof envelope.id === 'string') {
			const port = getOrCreatePort(envelope.id);
			port.emit('message', {
				data: reviveParentPortPayload(envelope.data),
				ports: []
			});
			return;
		}
		if (envelope?.__vscodeParentPortPortClose && typeof envelope.id === 'string') {
			const port = bridgedPorts.get(envelope.id);
			if (port) {
				bridgedPorts.delete(envelope.id);
				port.emit('close');
			}
			return;
		}

		const event: IBridgedMessageEvent = {
			data: rawMessage,
			ports: []
		};
		parentPort.emit('message', event);
	});

	(utilityProcess as NodeJS.Process & { parentPort: typeof parentPort }).parentPort = parentPort;
}

//#endregion

// Crash reporter
configureCrashReporter();

// Install MessagePort compatibility for forked utility processes under Electrobun shim.
installElectrobunParentPortPolyfill();

// Remove global paths from the node module lookup (node.js only)
removeGlobalNodeJsModuleLookupPaths();

if (process.env['VSCODE_DEV_INJECT_NODE_MODULE_LOOKUP_PATH']) {
	devInjectNodeModuleLookupPath(process.env['VSCODE_DEV_INJECT_NODE_MODULE_LOOKUP_PATH']);
}

// Configure: pipe logging to parent process
if (!!process.send && process.env['VSCODE_PIPE_LOGGING'] === 'true') {
	pipeLoggingToParent();
}

// Handle Exceptions
if (!process.env['VSCODE_HANDLES_UNCAUGHT_ERRORS']) {
	handleExceptions();
}

// Terminate when parent terminates
if (process.env['VSCODE_PARENT_PID']) {
	terminateWhenParentTerminates();
}

// Bootstrap ESM
await bootstrapESM();

// Load ESM entry point
await import([`./${process.env['VSCODE_ESM_ENTRYPOINT']}.js`].join('/') /* workaround: esbuild prints some strange warnings when trying to inline? */);
