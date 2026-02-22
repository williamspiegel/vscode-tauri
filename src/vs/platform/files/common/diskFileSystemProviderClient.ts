/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { canceled } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { newWriteableStream, ReadableStreamEventPayload, ReadableStreamEvents } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileAtomicReadOptions, IFileChange, IFileDeleteOptions, IFileOpenOptions, IFileOverwriteOptions, IFileReadStreamOptions, IFileSystemProviderError, IFileSystemProviderWithFileAtomicReadCapability, IFileSystemProviderWithFileCloneCapability, IFileSystemProviderWithFileFolderCopyCapability, IFileSystemProviderWithFileReadStreamCapability, IFileSystemProviderWithFileReadWriteCapability, IFileSystemProviderWithOpenReadWriteCloseCapability, IFileWriteOptions, IStat, IWatchOptions } from './files.js';
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

		// Reading as file stream goes through an event to the remote side
		disposables.add(this.channel.listen<ReadableStreamEventPayload<VSBuffer>>('readFileStream', [resource, opts])(dataOrErrorOrEnd => {

			// data
			if (dataOrErrorOrEnd instanceof VSBuffer) {
				stream.write(dataOrErrorOrEnd.buffer);
			}

			// end or error
			else {
				if (dataOrErrorOrEnd === 'end') {
					stream.end();
				} else {
					let error: Error;

					// Take Error as is if type matches
					if (dataOrErrorOrEnd instanceof Error) {
						error = dataOrErrorOrEnd;
					}

					// Otherwise, try to deserialize into an error.
					// Since we communicate via IPC, we cannot be sure
					// that Error objects are properly serialized.
					else {
						const errorCandidate = dataOrErrorOrEnd as IFileSystemProviderError;

						error = createFileSystemProviderError(errorCandidate.message ?? toErrorMessage(errorCandidate), errorCandidate.code ?? FileSystemProviderErrorCode.Unknown);
					}

					stream.error(error);
					stream.end();
				}

				// Signal to the remote side that we no longer listen
				disposables.dispose();
			}
		}));

		// Support cancellation
		disposables.add(token.onCancellationRequested(() => {

			// Ensure to end the stream properly with an error
			// to indicate the cancellation.
			stream.error(canceled());
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
		const [bytes, bytesRead]: [VSBuffer, number] = await this.channel.call('read', [fd, pos, length]);

		// copy back the data that was written into the buffer on the remote
		// side. we need to do this because buffers are not referenced by
		// pointer, but only by value and as such cannot be directly written
		// to from the other process.
		data.set(bytes.buffer.slice(0, bytesRead), offset);

		return bytesRead;
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
