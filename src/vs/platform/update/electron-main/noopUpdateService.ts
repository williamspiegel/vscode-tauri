/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { DisablementReason, IUpdateService, State } from '../common/update.js';

export class NoopUpdateService implements IUpdateService {
	declare readonly _serviceBrand: undefined;

	readonly onStateChange = Event.None;
	readonly state = State.Disabled(DisablementReason.ManuallyDisabled);

	async checkForUpdates(_explicit: boolean): Promise<void> {
		// Updates are intentionally disabled for Electrobun during phase 1.
	}

	async downloadUpdate(_explicit: boolean): Promise<void> {
		// Updates are intentionally disabled for Electrobun during phase 1.
	}

	async applyUpdate(): Promise<void> {
		// Updates are intentionally disabled for Electrobun during phase 1.
	}

	async quitAndInstall(): Promise<void> {
		// Updates are intentionally disabled for Electrobun during phase 1.
	}

	async isLatestVersion(): Promise<boolean | undefined> {
		return undefined;
	}

	async _applySpecificUpdate(_packagePath: string): Promise<void> {
		// Updates are intentionally disabled for Electrobun during phase 1.
	}

	async disableProgressiveReleases(): Promise<void> {
		// Updates are intentionally disabled for Electrobun during phase 1.
	}
}
