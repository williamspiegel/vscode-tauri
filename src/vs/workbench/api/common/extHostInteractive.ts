/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../base/common/async.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ExtHostInteractiveShape, IMainContext } from './extHost.protocol.js';
import { ExtHostCommands } from './extHostCommands.js';
import { ExtHostDocumentsAndEditors } from './extHostDocumentsAndEditors.js';
import { ExtHostNotebookController } from './extHostNotebook.js';
import { NotebookEditor } from 'vscode';

export class ExtHostInteractive implements ExtHostInteractiveShape {
	constructor(
		mainContext: IMainContext,
		private _extHostNotebooks: ExtHostNotebookController,
		private _textDocumentsAndEditors: ExtHostDocumentsAndEditors,
		private _commands: ExtHostCommands,
		_logService: ILogService
	) {
		this._commands.registerCommand(false, 'interactive.open', async (
			showOptions?: number | { viewColumn?: number; preserveFocus?: boolean },
			resource?: URI,
			controllerId?: string,
			title?: string
		): Promise<{ notebookUri: URI; inputUri: URI; notebookEditor?: NotebookEditor }> => {
			const result = await this._commands.executeCommand<{ notebookUri: UriComponents; inputUri: UriComponents; notebookEditorId?: string }>(
				'_interactive.open',
				showOptions,
				resource,
				controllerId,
				title
			);

			_logService.debug('[ExtHostInteractive] open iw with notebook editor id', result.notebookEditorId);

			const notebookUri = URI.revive(result.notebookUri);
			const inputUri = URI.revive(result.inputUri);
			const isTauriIntegration = process.env.VSCODE_TAURI_INTEGRATION === '1';
			const showNotebookOptions = typeof showOptions === 'number' ? { viewColumn: showOptions } : showOptions;
			const notebookEditor = await this._resolveNotebookEditor(result.notebookEditorId, notebookUri, isTauriIntegration ? 40 : 200);

			if (notebookEditor) {
				_logService.debug('[ExtHostInteractive] notebook editor found', notebookEditor.id);
				if (isTauriIntegration && notebookEditor.apiEditor.visibleRanges.length === 0) {
					try {
						const notebookDocument = await this._extHostNotebooks.openNotebookDocument(notebookUri);
						const recoveredNotebookEditor = await this._extHostNotebooks.showNotebookDocument(notebookDocument, showNotebookOptions);
						_logService.debug('[ExtHostInteractive] notebook editor had no visible ranges, recovered via showNotebookDocument', notebookUri.toString());
						return { notebookUri, inputUri, notebookEditor: recoveredNotebookEditor };
					} catch (error) {
						_logService.debug('[ExtHostInteractive] failed to recover notebook editor with visible ranges', notebookUri.toString(), error);
					}
				}

				return { notebookUri, inputUri, notebookEditor: notebookEditor.apiEditor };
			}

			for (let attempt = 0; attempt < (isTauriIntegration ? 80 : 200); attempt++) {
				try {
					const notebookDocument = await this._extHostNotebooks.openNotebookDocument(notebookUri);
					const notebookEditor = await this._extHostNotebooks.showNotebookDocument(
						notebookDocument,
						showNotebookOptions
					);
					_logService.debug('[ExtHostInteractive] notebook editor recovered via showNotebookDocument', notebookUri.toString());
					return { notebookUri, inputUri, notebookEditor };
				} catch (error) {
					if (attempt === 199) {
						_logService.debug('[ExtHostInteractive] failed to recover notebook editor via showNotebookDocument', notebookUri.toString(), error);
						break;
					}
					await timeout(50);
				}
			}

			_logService.debug('[ExtHostInteractive] notebook editor not found, uris for the interactive document', result.notebookUri, result.inputUri);
			return { notebookUri, inputUri };
		});
	}

	private async _resolveNotebookEditor(editorId: string | undefined, notebookUri: URI, maxAttempts = 200): Promise<ReturnType<ExtHostNotebookController['getEditorById']> | undefined> {
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (editorId) {
				try {
					return this._extHostNotebooks.getEditorById(editorId);
				} catch {
					// Wait for delayed notebook editor registration on the ext-host side.
				}
			}

			const visibleNotebookEditor = this._extHostNotebooks.visibleNotebookEditors.find(editor => editor.notebook.uri.toString() === notebookUri.toString());
			if (visibleNotebookEditor) {
				const visibleEditorId = this._extHostNotebooks.getIdByEditor(visibleNotebookEditor);
				if (visibleEditorId) {
					return this._extHostNotebooks.getEditorById(visibleEditorId);
				}
			}

			const activeNotebookEditor = this._extHostNotebooks.activeNotebookEditor;
			if (activeNotebookEditor && activeNotebookEditor.notebook.uri.toString() === notebookUri.toString()) {
				const activeEditorId = this._extHostNotebooks.getIdByEditor(activeNotebookEditor);
				if (activeEditorId) {
					return this._extHostNotebooks.getEditorById(activeEditorId);
				}
			}

			await timeout(50);
		}

		return undefined;
	}

	$willAddInteractiveDocument(uri: UriComponents, eol: string, languageId: string, notebookUri: UriComponents) {
		this._textDocumentsAndEditors.acceptDocumentsAndEditorsDelta({
			addedDocuments: [{
				EOL: eol,
				lines: [''],
				languageId: languageId,
				uri: uri,
				isDirty: false,
				versionId: 1,
				encoding: 'utf8'
			}]
		});
	}

	$willRemoveInteractiveDocument(uri: UriComponents, notebookUri: UriComponents) {
		this._textDocumentsAndEditors.acceptDocumentsAndEditorsDelta({
			removedDocuments: [uri]
		});
	}
}
