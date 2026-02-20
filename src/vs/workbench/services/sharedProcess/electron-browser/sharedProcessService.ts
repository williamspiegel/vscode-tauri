/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Client as MessagePortClient } from '../../../../base/parts/ipc/common/ipc.mp.js';
import { IChannel, IServerChannel, getDelayedChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { SharedProcessChannelConnection, SharedProcessRawConnection } from '../../../../platform/sharedProcess/common/sharedProcess.js';
import { mark } from '../../../../base/common/performance.js';
import { Barrier, timeout } from '../../../../base/common/async.js';
import { acquirePort } from '../../../../base/parts/ipc/electron-browser/ipc.mp.js';
import { Event } from '../../../../base/common/event.js';

type ISharedProcessConnection = Pick<MessagePortClient, 'getChannel' | 'registerChannel'>;

const noopSharedProcessChannel: IChannel = {
	listen: () => Event.None,
	call: async () => undefined
};

export class SharedProcessService extends Disposable implements ISharedProcessService {

	declare readonly _serviceBrand: undefined;

	private readonly withSharedProcessConnection: Promise<ISharedProcessConnection>;

	private readonly restoredBarrier = new Barrier();
	private readonly isElectrobunRuntime = process.env['VSCODE_DESKTOP_RUNTIME'] === 'electrobun';

	constructor(
		readonly windowId: number,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.withSharedProcessConnection = this.connect();
	}

	private async connect(): Promise<ISharedProcessConnection> {
		this.logService.trace('Renderer->SharedProcess#connect');
		if (this.isElectrobunRuntime) {
			this.logService.warn('Renderer->SharedProcess#connect: MessagePort transport unavailable on Electrobun runtime, using no-op shared process connection.');
			try {
				void fetch(`${globalThis.location.origin}/DIAGNOSTICS?data=${encodeURIComponent('SHARED_PROCESS_DISABLED_ELECTROBUN')}`);
			} catch {
				// ignore diagnostic failures
			}
			return {
				getChannel: () => noopSharedProcessChannel,
				registerChannel: () => undefined
			};
		}

		// Our performance tests show that a connection to the shared
		// process can have significant overhead to the startup time
		// of the window because the shared process could be created
		// as a result. As such, make sure we await the `Restored`
		// phase before making a connection attempt, but also add a
		// timeout to be safe against possible deadlocks.

		await Promise.race([this.restoredBarrier.wait(), timeout(2000)]);

		// Acquire a message port connected to the shared process
		mark('code/willConnectSharedProcess');
		this.logService.trace('Renderer->SharedProcess#connect: before acquirePort');
		const port = await Promise.race<MessagePort | undefined>([
			acquirePort(SharedProcessChannelConnection.request, SharedProcessChannelConnection.response).catch(() => undefined),
			timeout(4000).then(() => undefined)
		]);
		mark('code/didConnectSharedProcess');
		if (!port) {
			this.logService.warn('Renderer->SharedProcess#connect: timed out waiting for MessagePort, using no-op shared process connection.');
			try {
				void fetch(`${globalThis.location.origin}/DIAGNOSTICS?data=${encodeURIComponent('SHARED_PROCESS_CONNECT_TIMEOUT')}`);
			} catch {
				// ignore diagnostic failures
			}
			return {
				getChannel: () => noopSharedProcessChannel,
				registerChannel: () => undefined
			};
		}
		this.logService.trace('Renderer->SharedProcess#connect: connection established');

		return this._register(new MessagePortClient(port, `window:${this.windowId}`));
	}

	notifyRestored(): void {
		if (!this.restoredBarrier.isOpen()) {
			this.restoredBarrier.open();
		}
	}

	getChannel(channelName: string): IChannel {
		return getDelayedChannel(this.withSharedProcessConnection.then(connection => connection.getChannel(channelName)));
	}

	registerChannel(channelName: string, channel: IServerChannel<string>): void {
		this.withSharedProcessConnection.then(connection => connection.registerChannel(channelName, channel));
	}

	async createRawConnection(): Promise<MessagePort> {
		if (this.isElectrobunRuntime) {
			const fallbackChannel = new MessageChannel();
			return fallbackChannel.port1;
		}

		// Await initialization of the shared process
		await this.withSharedProcessConnection;

		// Create a new port to the shared process
		this.logService.trace('Renderer->SharedProcess#createRawConnection: before acquirePort');
		const port = await Promise.race<MessagePort | undefined>([
			acquirePort(SharedProcessRawConnection.request, SharedProcessRawConnection.response).catch(() => undefined),
			timeout(4000).then(() => undefined)
		]);
		if (port) {
			this.logService.trace('Renderer->SharedProcess#createRawConnection: connection established');
			return port;
		}

		this.logService.warn('Renderer->SharedProcess#createRawConnection: timed out waiting for MessagePort, returning local fallback port.');
		try {
			void fetch(`${globalThis.location.origin}/DIAGNOSTICS?data=${encodeURIComponent('SHARED_PROCESS_RAW_TIMEOUT')}`);
		} catch {
			// ignore diagnostic failures
		}
		const fallbackChannel = new MessageChannel();
		return fallbackChannel.port1;
	}
}
