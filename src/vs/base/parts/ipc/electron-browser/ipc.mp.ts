/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../browser/window.js';
import { timeout } from '../../../common/async.js';
import { Event } from '../../../common/event.js';
import { generateUuid } from '../../../common/uuid.js';
import { ipcMessagePort, ipcRenderer } from '../../sandbox/electron-browser/globals.js';

interface IMessageChannelResult {
	nonce: string;
	port: MessagePort;
	source: unknown;
}

export async function acquirePort(requestChannel: string | undefined, responseChannel: string, nonce = generateUuid()): Promise<MessagePort> {

	// Get ready to acquire the message port from the
	// provided `responseChannel` via preload helper.
	ipcMessagePort.acquire(responseChannel, nonce);

	// If a `requestChannel` is provided, we are in charge
	// to trigger acquisition of the message port from main
	if (typeof requestChannel === 'string') {
		ipcRenderer.send(requestChannel, nonce);
	}

	// Wait until the main side has returned the `MessagePort`
	// We need to filter by the `nonce` to ensure we listen
	// to the right response.
	const onMessageChannelResult = Event.fromDOMEventEmitter<IMessageChannelResult>(mainWindow, 'message', (e: MessageEvent) => ({ nonce: e.data, port: e.ports[0], source: e.source }));
	const result = await Promise.race<IMessageChannelResult | undefined>([
		Event.toPromise(Event.once(Event.filter(onMessageChannelResult, e => e.nonce === nonce))),
		timeout(10000).then(() => undefined)
	]);

	if (!result?.port) {
		throw new Error(`MessagePort acquisition failed for channel '${responseChannel}' (nonce: ${nonce}).`);
	}

	return result.port;
}
