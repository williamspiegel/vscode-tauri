/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electrobun from 'electrobun';
import { IDesktopRuntimeBrowserModule, IDesktopRuntimeBrowserService } from '../common/desktopRuntime.js';

export class ElectrobunBrowserService implements IDesktopRuntimeBrowserService {
	declare readonly _serviceBrand: undefined;
	readonly module = electrobun as unknown as IDesktopRuntimeBrowserModule;
}
