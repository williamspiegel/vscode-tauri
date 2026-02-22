/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { newWriteableStream, ReadableStreamEventPayload, ReadableStreamEvents } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileAtomicReadOptions, IFileChange, IFileDeleteOptions, IFileOpenOptions, IFileOverwriteOptions, IFileReadStreamOptions, IFileSystemProviderWithFileAtomicReadCapability, IFileSystemProviderWithFileCloneCapability, IFileSystemProviderWithFileFolderCopyCapability, IFileSystemProviderWithFileReadStreamCapability, IFileSystemProviderWithFileReadWriteCapability, IFileSystemProviderWithOpenReadWriteCloseCapability, IFileWriteOptions, IStat, IWatchOptions, toFileSystemProviderErrorCode } from './files.js';
import { reviveFileChanges } from './watcher.js';

export const LOCAL_FILE_SYSTEM_CHANNEL_NAME = 'localFilesystem';

function decodeBase64ToBytes(value: string): Uint8Array | undefined {
	try {
		return decodeBase64(value);
	} catch {
		return undefined;
	}
}

function normalizeReadFileBytes(value: unknown): Uint8Array | undefined {
	if (value instanceof Uint8Array) {
		return value;
	}

	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}

	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}

	if (value instanceof VSBuffer) {
		return value.buffer;
	}

	if (Array.isArray(value)) {
		return Uint8Array.from(value.map(item => Number(item) & 0xff));
	}

	if (value && typeof value === 'object') {
		const objectValue = value as Record<string, unknown>;

		if (typeof objectValue.type === 'string' && objectValue.type === 'Buffer' && Array.isArray(objectValue.data)) {
			return Uint8Array.from(objectValue.data.map(item => Number(item) & 0xff));
		}

		if (Array.isArray(objectValue.data)) {
			return Uint8Array.from(objectValue.data.map(item => Number(item) & 0xff));
		}

		if (typeof objectValue.base64 === 'string' && objectValue.base64.length > 0) {
			const decoded = decodeBase64ToBytes(objectValue.base64);
			if (decoded) {
				return decoded;
			}
		}

		if (objectValue.buffer !== undefined) {
			const nested = normalizeReadFileBytes(objectValue.buffer);
			if (nested) {
				const requestedLength =
					typeof objectValue.byteLength === 'number' && Number.isFinite(objectValue.byteLength)
						? Math.max(0, Math.floor(objectValue.byteLength))
						: undefined;
				return typeof requestedLength === 'number' ? nested.slice(0, requestedLength) : nested;
			}
		}

		const numericEntries: [number, number][] = [];
		for (const key of Object.keys(objectValue)) {
			if (!/^\d+$/.test(key)) {
				continue;
			}

			const parsedIndex = Number(key);
			if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
				continue;
			}

			const candidate = objectValue[key];
			let parsedValue: number | undefined;
			if (typeof candidate === 'number') {
				parsedValue = candidate;
			} else if (typeof candidate === 'string' && candidate.length > 0) {
				const numeric = Number(candidate);
				if (Number.isFinite(numeric)) {
					parsedValue = numeric;
				}
			}

			if (typeof parsedValue === 'number' && Number.isFinite(parsedValue)) {
				numericEntries.push([parsedIndex, parsedValue & 0xff]);
			}
		}

		if (numericEntries.length > 0) {
			const maxIndexedLength = Math.max(...numericEntries.map(([index]) => index)) + 1;
			const declaredLength =
				typeof objectValue.length === 'number' && Number.isFinite(objectValue.length) && objectValue.length >= 0
					? Math.floor(objectValue.length)
					: maxIndexedLength;
			const length = Math.max(maxIndexedLength, declaredLength);
			const bytes = new Uint8Array(length);
			for (const [index, byte] of numericEntries) {
				bytes[index] = byte;
			}
			return bytes;
		}
	}

	return undefined;
}

function isTauriFsDebugEnabled(): boolean {
	try {
		const storage = (globalThis as { localStorage?: { getItem?: (key: string) => string | null } }).localStorage;
		return storage?.getItem?.('tauriHostDebug') === '1';
	} catch {
		return false;
	}
}

function isCancellationLikeError(error: Error): boolean {
	const message = error.message.toLowerCase();
	const name = error.name.toLowerCase();
	return message.includes('canceled') || message.includes('cancelled') || name.includes('canceled') || name.includes('cancelled');
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object') {
		return value as Record<string, unknown>;
	}

	return {};
}

function asFileSystemProviderErrorCode(value: unknown): FileSystemProviderErrorCode | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	switch (value) {
		case FileSystemProviderErrorCode.FileExists:
		case FileSystemProviderErrorCode.FileNotFound:
		case FileSystemProviderErrorCode.FileNotADirectory:
		case FileSystemProviderErrorCode.FileIsADirectory:
		case FileSystemProviderErrorCode.FileExceedsStorageQuota:
		case FileSystemProviderErrorCode.FileTooLarge:
		case FileSystemProviderErrorCode.FileWriteLocked:
		case FileSystemProviderErrorCode.NoPermissions:
		case FileSystemProviderErrorCode.Unavailable:
		case FileSystemProviderErrorCode.Unknown:
			return value;
		default:
			return undefined;
	}
}

function asFileSystemProviderErrorCodeFromName(value: unknown): FileSystemProviderErrorCode | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const match = /^(.+) \(FileSystemError\)$/.exec(value);
	if (!match) {
		return undefined;
	}

	return asFileSystemProviderErrorCode(match[1]);
}

function isEntryNotFoundLikeError(error: Error): boolean {
	if (toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
		return true;
	}

	const message = `${error.message ?? ''}`.toLowerCase();
	const name = `${error.name ?? ''}`.toLowerCase();
	return (
		message.includes('enoent') ||
		message.includes('no such file or directory') ||
		message.includes('(os error 2)') ||
		name.includes('entrynotfound')
	);
}

function isOptionalMissingResource(resourceLabel: string): boolean {
	const normalized = resourceLabel.toLowerCase();
	return (
		normalized.includes('/backups/file/') ||
		normalized.includes('/backups/workspaces/') ||
		normalized.includes('/workspacestorage/') ||
		normalized.includes('/chateditingsessions/') ||
		normalized.includes('/chatsessions/')
	);
}

/**
 * An implementation of a local disk file system provider
 * that is backed by a `IChannel` and thus implemented via
 * IPC on a different process.
 */
export class DiskFileSystemProviderClient extends Disposable implements
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithOpenReadWriteCloseCapability,
	IFileSystemProviderWithFileReadStreamCapability,
	IFileSystemProviderWithFileFolderCopyCapability,
	IFileSystemProviderWithFileAtomicReadCapability,
	IFileSystemProviderWithFileCloneCapability {

	constructor(
		private readonly channel: IChannel,
		private readonly extraCapabilities: { trash?: boolean; pathCaseSensitive?: boolean }
	) {
		super();

		this.registerFileChangeListeners();
	}

	//#region File Capabilities

	readonly onDidChangeCapabilities: Event<void> = Event.None;

	private _capabilities: FileSystemProviderCapabilities | undefined;
	get capabilities(): FileSystemProviderCapabilities {
		if (!this._capabilities) {
			this._capabilities =
				FileSystemProviderCapabilities.FileReadWrite |
				FileSystemProviderCapabilities.FileOpenReadWriteClose |
				FileSystemProviderCapabilities.FileReadStream |
				FileSystemProviderCapabilities.FileFolderCopy |
				FileSystemProviderCapabilities.FileWriteUnlock |
				FileSystemProviderCapabilities.FileAtomicRead |
				FileSystemProviderCapabilities.FileAtomicWrite |
				FileSystemProviderCapabilities.FileAtomicDelete |
				FileSystemProviderCapabilities.FileAppend |
				FileSystemProviderCapabilities.FileClone |
				FileSystemProviderCapabilities.FileRealpath;

			if (this.extraCapabilities.pathCaseSensitive) {
				this._capabilities |= FileSystemProviderCapabilities.PathCaseSensitive;
			}

			if (this.extraCapabilities.trash) {
				this._capabilities |= FileSystemProviderCapabilities.Trash;
			}
		}

		return this._capabilities;
	}

	//#endregion

	//#region File Metadata Resolving

	stat(resource: URI): Promise<IStat> {
		return this.channel.call('stat', [resource]);
	}

	realpath(resource: URI): Promise<string> {
		return this.channel.call('realpath', [resource]);
	}

	readdir(resource: URI): Promise<[string, FileType][]> {
		return this.channel.call('readdir', [resource]);
	}

	//#endregion

	//#region File Reading/Writing

	async readFile(resource: URI, opts?: IFileAtomicReadOptions): Promise<Uint8Array> {
		const result = await this.channel.call('readFile', [resource, opts]) as unknown;
		const normalized = normalizeReadFileBytes(result);
		if (normalized) {
			return normalized;
		}

		throw createFileSystemProviderError(
			`Invalid readFile payload for ${resource.toString()}`,
			FileSystemProviderErrorCode.Unknown
		);
	}

	readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		const stream = newWriteableStream<Uint8Array>(data => VSBuffer.concat(data.map(data => VSBuffer.wrap(data))).buffer);
		const disposables = new DisposableStore();
		const debugEnabled = isTauriFsDebugEnabled();
		const resourceLabel = resource.toString();
		let streamChunkCount = 0;
		let streamTotalBytes = 0;
		let streamEnded = false;

		// Reading as file stream goes through an event to the remote side
		disposables.add(this.channel.listen<ReadableStreamEventPayload<VSBuffer>>('readFileStream', [resource, opts])(dataOrErrorOrEnd => {
			if (streamEnded) {
				return;
			}

			// data
			if (dataOrErrorOrEnd instanceof VSBuffer) {
				streamChunkCount += 1;
				streamTotalBytes += dataOrErrorOrEnd.byteLength;
				if (debugEnabled) {
					console.debug('[diskfs.stream.chunk]', { resource: resourceLabel, bytes: dataOrErrorOrEnd.byteLength, chunks: streamChunkCount, totalBytes: streamTotalBytes });
				}
				try {
					stream.write(dataOrErrorOrEnd.buffer);
				} catch (error) {
					streamEnded = true;
					if (debugEnabled) {
						const message = error instanceof Error ? error.message : toErrorMessage(error);
						console.warn('[diskfs.stream.drop]', { resource: resourceLabel, reason: message });
					}
				}
				return;
			}

			const normalizedChunk = normalizeReadFileBytes(dataOrErrorOrEnd);
			if (normalizedChunk) {
				streamChunkCount += 1;
				streamTotalBytes += normalizedChunk.byteLength;
				if (debugEnabled) {
					console.debug('[diskfs.stream.chunk]', { resource: resourceLabel, bytes: normalizedChunk.byteLength, chunks: streamChunkCount, totalBytes: streamTotalBytes });
				}
				try {
					stream.write(normalizedChunk);
				} catch (error) {
					streamEnded = true;
					if (debugEnabled) {
						const message = error instanceof Error ? error.message : toErrorMessage(error);
						console.warn('[diskfs.stream.drop]', { resource: resourceLabel, reason: message });
					}
				}
				return;
			}

			// end or error
			if (dataOrErrorOrEnd === 'end') {
				streamEnded = true;
				if (debugEnabled) {
					console.debug('[diskfs.stream.end]', { resource: resourceLabel, chunks: streamChunkCount, totalBytes: streamTotalBytes });
				}
				stream.end();
			} else {
				streamEnded = true;
				let error: Error;

				// Take Error as is if type matches
				if (dataOrErrorOrEnd instanceof Error) {
					error = dataOrErrorOrEnd;
				}

				// Otherwise, try to deserialize into an error.
				// Since we communicate via IPC, we cannot be sure
				// that Error objects are properly serialized.
				else {
					const errorCandidate = asRecord(dataOrErrorOrEnd);
					const message = typeof errorCandidate.message === 'string' ? errorCandidate.message : toErrorMessage(dataOrErrorOrEnd);
					const code = asFileSystemProviderErrorCode(errorCandidate.code)
						?? asFileSystemProviderErrorCodeFromName(errorCandidate.name)
						?? FileSystemProviderErrorCode.Unknown;

					error = createFileSystemProviderError(message, code);
				}
				if (debugEnabled) {
					console.error('[diskfs.stream.error]', { resource: resourceLabel, message: error.message, name: error.name });
				}
				if (isEntryNotFoundLikeError(error) && isOptionalMissingResource(resourceLabel)) {
					if (debugEnabled) {
						console.warn('[diskfs.stream.optional-miss]', { resource: resourceLabel, message: error.message });
					}
					stream.end();
					disposables.dispose();
					return;
				}
				if (token.isCancellationRequested || isCancellationLikeError(error)) {
					stream.end();
					disposables.dispose();
					return;
				}

				stream.error(error);
				stream.end();
			}

			// Signal to the remote side that we no longer listen
			disposables.dispose();
		}));

		// Support cancellation
		disposables.add(token.onCancellationRequested(() => {
			streamEnded = true;
			stream.end();

			// Ensure to dispose the listener upon cancellation. This will
			// bubble through the remote side as event and allows to stop
			// reading the file.
			disposables.dispose();
		}));

		return stream;
	}

	writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		return this.channel.call('writeFile', [resource, VSBuffer.wrap(content), opts]);
	}

	open(resource: URI, opts: IFileOpenOptions): Promise<number> {
		return this.channel.call('open', [resource, opts]);
	}

	close(fd: number): Promise<void> {
		return this.channel.call('close', [fd]);
	}

	async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const result = await this.channel.call('read', [fd, pos, length]) as unknown;

		let rawBytes: unknown;
		let rawBytesRead: unknown;
		if (Array.isArray(result)) {
			rawBytes = result[0];
			rawBytesRead = result[1];
		} else if (result && typeof result === 'object') {
			const record = result as Record<string, unknown>;
			rawBytes = record.buffer ?? record.bytes ?? record.data;
			rawBytesRead = record.bytesRead;
		}

		const normalized = normalizeReadFileBytes(rawBytes);
		if (!normalized) {
			throw createFileSystemProviderError(
				`Invalid read payload for descriptor ${fd}`,
				FileSystemProviderErrorCode.Unknown
			);
		}

		const bytesRead = typeof rawBytesRead === 'number' && Number.isFinite(rawBytesRead)
			? Math.max(0, Math.min(normalized.byteLength, Math.floor(rawBytesRead)))
			: normalized.byteLength;
		const chunk = normalized.subarray(0, bytesRead);

		// copy back the data that was written into the buffer on the remote
		// side. we need to do this because buffers are not referenced by
		// pointer, but only by value and as such cannot be directly written
		// to from the other process.
		data.set(chunk, offset);

		return chunk.byteLength;
	}

	write(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		return this.channel.call('write', [fd, pos, VSBuffer.wrap(data), offset, length]);
	}

	//#endregion

	//#region Move/Copy/Delete/Create Folder

	mkdir(resource: URI): Promise<void> {
		return this.channel.call('mkdir', [resource]);
	}

	delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		return this.channel.call('delete', [resource, opts]);
	}

	rename(resource: URI, target: URI, opts: IFileOverwriteOptions): Promise<void> {
		return this.channel.call('rename', [resource, target, opts]);
	}

	copy(resource: URI, target: URI, opts: IFileOverwriteOptions): Promise<void> {
		return this.channel.call('copy', [resource, target, opts]);
	}

	//#endregion

	//#region Clone File

	cloneFile(resource: URI, target: URI): Promise<void> {
		return this.channel.call('cloneFile', [resource, target]);
	}

	//#endregion

	//#region File Watching

	private readonly _onDidChange = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChange.event;

	private readonly _onDidWatchError = this._register(new Emitter<string>());
	readonly onDidWatchError = this._onDidWatchError.event;

	// The contract for file watching via remote is to identify us
	// via a unique but readonly session ID. Since the remote is
	// managing potentially many watchers from different clients,
	// this helps the server to properly partition events to the right
	// clients.
	private readonly sessionId = generateUuid();

	private registerFileChangeListeners(): void {

		// The contract for file changes is that there is one listener
		// for both events and errors from the watcher. So we need to
		// unwrap the event from the remote and emit through the proper
		// emitter.
		this._register(this.channel.listen<IFileChange[] | string>('fileChange', [this.sessionId])(eventsOrError => {
			if (Array.isArray(eventsOrError)) {
				const events = eventsOrError;
				this._onDidChange.fire(reviveFileChanges(events));
			} else {
				const error = eventsOrError;
				this._onDidWatchError.fire(error);
			}
		}));
	}

	watch(resource: URI, opts: IWatchOptions): IDisposable {

		// Generate a request UUID to correlate the watcher
		// back to us when we ask to dispose the watcher later.
		const req = generateUuid();

		this.channel.call('watch', [this.sessionId, req, resource, opts]);

		return toDisposable(() => this.channel.call('unwatch', [this.sessionId, req]));
	}

	//#endregion
}
