/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEncryptionService, KnownStorageProvider } from '../../../../platform/encryption/common/encryptionService.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

class TauriEncryptionService implements IEncryptionService {

	declare readonly _serviceBrand: undefined;

	encrypt(value: string): Promise<string> {
		return Promise.resolve(value);
	}

	decrypt(value: string): Promise<string> {
		return Promise.resolve(value);
	}

	isEncryptionAvailable(): Promise<boolean> {
		return Promise.resolve(false);
	}

	getKeyStorageProvider(): Promise<KnownStorageProvider> {
		return Promise.resolve(KnownStorageProvider.basicText);
	}

	setUsePlainTextEncryption(): Promise<void> {
		return Promise.resolve(undefined);
	}
}

const desktopRuntime = (globalThis as typeof globalThis & {
	vscode?: {
		process?: {
			env?: Record<string, string | undefined>;
		};
	};
}).vscode?.process?.env?.VSCODE_DESKTOP_RUNTIME;

if (desktopRuntime === 'electrobun') {
	registerSingleton(IEncryptionService, TauriEncryptionService, InstantiationType.Delayed);
} else {
	registerMainProcessRemoteService(IEncryptionService, 'encryption');
}
