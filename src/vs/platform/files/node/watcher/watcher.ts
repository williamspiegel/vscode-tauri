/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogMessage, isRecursiveWatchRequest, IUniversalWatcher, IUniversalWatchRequest } from '../../common/watcher.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import type { ParcelWatcher } from './parcel/parcelWatcher.js';
import { NodeJSWatcher } from './nodejs/nodejsWatcher.js';
import { Promises } from '../../../../base/common/async.js';
import { computeStats } from './watcherStats.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export class UniversalWatcher extends Disposable implements IUniversalWatcher {

	private readonly _onDidLogMessage = this._register(new Emitter<ILogMessage>());
	readonly onDidLogMessage = this._onDidLogMessage.event;

	private readonly recursiveWatcher = this.createRecursiveWatcher();
	private readonly nonRecursiveWatcher = this._register(new NodeJSWatcher(this.recursiveWatcher));

	readonly onDidChangeFile = this.recursiveWatcher ? Event.any(this.recursiveWatcher.onDidChangeFile, this.nonRecursiveWatcher.onDidChangeFile) : this.nonRecursiveWatcher.onDidChangeFile;
	readonly onDidError = this.recursiveWatcher ? Event.any(this.recursiveWatcher.onDidError, this.nonRecursiveWatcher.onDidError) : this.nonRecursiveWatcher.onDidError;

	private requests: IUniversalWatchRequest[] = [];
	private failedRecursiveRequests = 0;

	constructor() {
		super();

		if (this.recursiveWatcher) {
			this._register(this.recursiveWatcher.onDidError(e => {
				if (e.request) {
					this.failedRecursiveRequests++;
				}
			}));
			this._register(this.recursiveWatcher.onDidLogMessage(msg => this._onDidLogMessage.fire(msg)));
		}

		this._register(this.nonRecursiveWatcher.onDidLogMessage(msg => this._onDidLogMessage.fire(msg)));
	}

	private createRecursiveWatcher(): ParcelWatcher | undefined {
		try {
			const parcelWatcherModule = require('./parcel/parcelWatcher.js') as { ParcelWatcher: new () => ParcelWatcher };
			return this._register(new parcelWatcherModule.ParcelWatcher());
		} catch (error) {
			this._onDidLogMessage.fire({
				type: 'warn',
				message: `[File Watcher] Recursive watcher unavailable, falling back to node.js watcher only (${toErrorMessage(error)}).`
			});

			return undefined;
		}
	}

	async watch(requests: IUniversalWatchRequest[]): Promise<void> {
		this.requests = requests;
		this.failedRecursiveRequests = 0;

		// Watch recursively first to give recursive watchers a chance
		// to step in for non-recursive watch requests, thus reducing
		// watcher duplication.

		let error: Error | undefined;
		if (this.recursiveWatcher) {
			try {
				await this.recursiveWatcher.watch(requests.filter(request => isRecursiveWatchRequest(request)));
			} catch (e) {
				error = e;
			}
		}

		try {
			await this.nonRecursiveWatcher.watch(requests.filter(request => !isRecursiveWatchRequest(request)));
		} catch (e) {
			if (!error) {
				error = e;
			}
		}

		if (error) {
			throw error;
		}
	}

	async setVerboseLogging(enabled: boolean): Promise<void> {

		// Log stats
		if (enabled && this.requests.length > 0) {
			this._onDidLogMessage.fire({ type: 'trace', message: computeStats(this.requests, this.failedRecursiveRequests, this.recursiveWatcher, this.nonRecursiveWatcher) });
		}

		// Forward to watchers
		const tasks: Promise<void>[] = [this.nonRecursiveWatcher.setVerboseLogging(enabled)];
		if (this.recursiveWatcher) {
			tasks.push(this.recursiveWatcher.setVerboseLogging(enabled));
		}

		await Promises.settled(tasks);
	}

	async stop(): Promise<void> {
		const tasks: Promise<void>[] = [this.nonRecursiveWatcher.stop()];
		if (this.recursiveWatcher) {
			tasks.push(this.recursiveWatcher.stop());
		}

		await Promises.settled(tasks);
	}
}
