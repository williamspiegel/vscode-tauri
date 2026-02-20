/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface IDesktopRuntimeLifecycle {
	readonly app: unknown;
}

export interface IDesktopRuntimeWindowing {
	readonly BrowserWindow: unknown;
	readonly webContents: unknown;
}

export interface IDesktopRuntimeIpc {
	readonly ipcMain: unknown;
	readonly ipcRenderer: unknown;
}

export interface IDesktopRuntimeProtocol {
	readonly protocol: unknown;
	readonly session: unknown;
}

export interface IDesktopRuntimeDialogs {
	readonly dialog: unknown;
}

export interface IDesktopRuntimeSystem {
	readonly shell: unknown;
	readonly nativeTheme: unknown;
	readonly clipboard: unknown;
	readonly powerMonitor: unknown;
}

export interface IDesktopRuntimeUtilityProcess {
	readonly utilityProcess: unknown;
	readonly MessageChannelMain: unknown;
}

export interface IDesktopRuntimeMainModule extends
	IDesktopRuntimeLifecycle,
	IDesktopRuntimeWindowing,
	IDesktopRuntimeIpc,
	IDesktopRuntimeProtocol,
	IDesktopRuntimeDialogs,
	IDesktopRuntimeSystem,
	IDesktopRuntimeUtilityProcess {
	readonly net: unknown;
}

export interface IDesktopRuntimeMainService {
	readonly _serviceBrand: undefined;
	readonly module: IDesktopRuntimeMainModule;
}

export const IDesktopRuntimeMainService = createDecorator<IDesktopRuntimeMainService>('desktopRuntimeMainService');

export interface IDesktopRuntimeBrowserModule {
	readonly ipcRenderer: unknown;
	readonly contextBridge: unknown;
	readonly webFrame: unknown;
	readonly webUtils: unknown;
}

export interface IDesktopRuntimeBrowserService {
	readonly _serviceBrand: undefined;
	readonly module: IDesktopRuntimeBrowserModule;
}

export const IDesktopRuntimeBrowserService = createDecorator<IDesktopRuntimeBrowserService>('desktopRuntimeBrowserService');
