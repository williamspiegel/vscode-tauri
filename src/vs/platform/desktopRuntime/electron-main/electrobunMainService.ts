/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electrobun from 'electrobun';
import { IDesktopRuntimeMainModule, IDesktopRuntimeMainService } from '../common/desktopRuntime.js';

export class ElectrobunMainService implements IDesktopRuntimeMainService {
	declare readonly _serviceBrand: undefined;
	readonly module = electrobun as unknown as IDesktopRuntimeMainModule;
}
