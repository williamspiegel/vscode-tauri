/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../base/common/async.js';
import { URI } from '../../../base/common/uri.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { MainContext, MainThreadBulkEditsShape } from './extHost.protocol.js';
import { ExtHostDocumentsAndEditors } from './extHostDocumentsAndEditors.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { WorkspaceEdit } from './extHostTypeConverters.js';
import * as types from './extHostTypes.js';
import { SerializableObjectWithBuffers } from '../../services/extensions/common/proxyIdentifier.js';
import type * as vscode from 'vscode';

export class ExtHostBulkEdits {
	private static readonly _workspaceEditSettleAttempts = 200;
	private static readonly _workspaceEditSettleDelay = 10;

	private readonly _proxy: MainThreadBulkEditsShape;
	private readonly _versionInformationProvider: WorkspaceEdit.IVersionInformationProvider;
	private readonly _documentsAndEditors: ExtHostDocumentsAndEditors;

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		extHostDocumentsAndEditors: ExtHostDocumentsAndEditors,
	) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadBulkEdits);
		this._documentsAndEditors = extHostDocumentsAndEditors;

		this._versionInformationProvider = {
			getTextDocumentVersion: uri => extHostDocumentsAndEditors.getDocument(uri)?.version,
			getNotebookDocumentVersion: () => undefined
		};
	}

	async applyWorkspaceEdit(edit: vscode.WorkspaceEdit, extension: IExtensionDescription, metadata: vscode.WorkspaceEditMetadata | undefined): Promise<boolean> {
		const versionTargets = this._collectVersionTargets(edit);
		const dto = new SerializableObjectWithBuffers(WorkspaceEdit.from(edit, this._versionInformationProvider));
		const applied = await this._proxy.$tryApplyWorkspaceEdit(dto, undefined, metadata?.isRefactoring ?? false);
		if (applied && versionTargets.length > 0) {
			await this._waitForVersionTargets(versionTargets);
		}
		return applied;
	}

	private _collectVersionTargets(edit: vscode.WorkspaceEdit): { uri: URI; version: number }[] {
		if (!(edit instanceof types.WorkspaceEdit)) {
			return [];
		}

		const targets = new Map<string, { uri: URI; version: number }>();
		for (const entry of edit._allEntries()) {
			if (entry._type !== types.FileEditType.Text && entry._type !== types.FileEditType.Snippet) {
				continue;
			}

			const version = this._versionInformationProvider.getTextDocumentVersion(entry.uri);
			if (typeof version !== 'number') {
				continue;
			}

			targets.set(entry.uri.toString(), { uri: entry.uri, version: version + 1 });
		}

		return [...targets.values()];
	}

	private async _waitForVersionTargets(targets: { uri: URI; version: number }[]): Promise<void> {
		for (let attempt = 0; attempt < ExtHostBulkEdits._workspaceEditSettleAttempts; attempt++) {
			const allCaughtUp = targets.every(target => {
				const document = this._documentsAndEditors.getDocument(target.uri);
				return typeof document?.version === 'number' && document.version >= target.version;
			});
			if (allCaughtUp) {
				return;
			}

			await timeout(ExtHostBulkEdits._workspaceEditSettleDelay);
		}
	}
}
