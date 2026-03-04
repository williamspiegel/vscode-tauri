/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { illegalArgument } from '../../../base/common/errors.js';
import { timeout } from '../../../base/common/async.js';
import { IDisposable, dispose, DisposableStore } from '../../../base/common/lifecycle.js';
import { equals as objectEquals } from '../../../base/common/objects.js';
import { Schemas } from '../../../base/common/network.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { IRange } from '../../../editor/common/core/range.js';
import { ISelection } from '../../../editor/common/core/selection.js';
import { IDecorationOptions, IDecorationRenderOptions } from '../../../editor/common/editorCommon.js';
import { ISingleEditOperation } from '../../../editor/common/core/editOperation.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ITextEditorOptions, IResourceEditorInput, EditorActivation, EditorResolution, ITextEditorDiffInformation, isTextEditorDiffInformationEqual, ITextEditorChange } from '../../../platform/editor/common/editor.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { MainThreadTextEditor } from './mainThreadEditor.js';
import { ExtHostContext, ExtHostEditorsShape, IApplyEditsOptions, ITextDocumentShowOptions, ITextEditorConfigurationUpdate, ITextEditorPositionData, IUndoStopOptions, MainThreadTextEditorsShape, TextEditorRevealType } from '../common/extHost.protocol.js';
import { editorGroupToColumn, columnToEditorGroup, EditorGroupColumn } from '../../services/editor/common/editorGroupColumn.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { IEnvironmentService } from '../../../platform/environment/common/environment.js';
import { parse as parseNotebookCellUri } from '../../services/notebook/common/notebookDocumentService.js';
import { IWorkingCopyService } from '../../services/workingCopy/common/workingCopyService.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { IChange } from '../../../editor/common/diff/legacyLinesDiffComputer.js';
import { IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IEditorControl, IEditorPane } from '../../common/editor.js';
import { getCodeEditor, ICodeEditor } from '../../../editor/browser/editorBrowser.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IQuickDiffModelService } from '../../contrib/scm/browser/quickDiffModel.js';
import { getNotebookEditorFromEditorPane, INotebookEditor } from '../../contrib/notebook/browser/notebookBrowser.js';
import { INotebookService } from '../../contrib/notebook/common/notebookService.js';
import { autorun, constObservable, derived, derivedOpts, IObservable, observableFromEvent } from '../../../base/common/observable.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { isITextModel } from '../../../editor/common/model.js';
import { LineRangeMapping } from '../../../editor/common/diff/rangeMapping.js';
import { equals } from '../../../base/common/arrays.js';
import { Event } from '../../../base/common/event.js';
import { DiffAlgorithmName } from '../../../editor/common/services/editorWorker.js';

export interface IMainThreadEditorLocator {
	getEditor(id: string): MainThreadTextEditor | undefined;
	findTextEditorIdFor(editorControl: IEditorControl): string | undefined;
	getIdOfCodeEditor(codeEditor: ICodeEditor): string | undefined;
	ensureTextEditorForCodeEditor(codeEditor: ICodeEditor): string | undefined;
}

export class MainThreadTextEditors implements MainThreadTextEditorsShape {
	private static readonly _notebookCellEditorSettleAttempts = 300;
	private static readonly _editorChangeSettleTimeout = 250;

	private static INSTANCE_COUNT: number = 0;

	private readonly _instanceId: string;
	private readonly _proxy: ExtHostEditorsShape;
	private readonly _toDispose = new DisposableStore();
	private _textEditorsListenersMap: { [editorId: string]: IDisposable[] };
	private _editorPositionData: ITextEditorPositionData | null;
	private _registeredDecorationTypes: { [decorationType: string]: boolean };

	constructor(
		private readonly _editorLocator: IMainThreadEditorLocator,
		extHostContext: IExtHostContext,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IQuickDiffModelService private readonly _quickDiffModelService: IQuickDiffModelService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		private readonly _notebookService: INotebookService
	) {
		this._instanceId = String(++MainThreadTextEditors.INSTANCE_COUNT);
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostEditors);

		this._textEditorsListenersMap = Object.create(null);
		this._editorPositionData = null;

		this._toDispose.add(this._editorService.onDidVisibleEditorsChange(() => this._updateActiveAndVisibleTextEditors()));
		this._toDispose.add(this._editorGroupService.onDidRemoveGroup(() => this._updateActiveAndVisibleTextEditors()));
		this._toDispose.add(this._editorGroupService.onDidMoveGroup(() => this._updateActiveAndVisibleTextEditors()));

		this._registeredDecorationTypes = Object.create(null);
	}

	dispose(): void {
		Object.keys(this._textEditorsListenersMap).forEach((editorId) => {
			dispose(this._textEditorsListenersMap[editorId]);
		});
		this._textEditorsListenersMap = Object.create(null);
		this._toDispose.dispose();
		for (const decorationType in this._registeredDecorationTypes) {
			this._codeEditorService.removeDecorationType(decorationType);
		}
		this._registeredDecorationTypes = Object.create(null);
	}

	handleTextEditorAdded(textEditor: MainThreadTextEditor): void {
		const id = textEditor.getId();
		const toDispose: IDisposable[] = [];
		toDispose.push(textEditor.onPropertiesChanged((data) => {
			this._proxy.$acceptEditorPropertiesChanged(id, data);
		}));

		const diffInformationObs = this._getTextEditorDiffInformation(textEditor, toDispose);
		toDispose.push(autorun(reader => {
			const diffInformation = diffInformationObs.read(reader);
			this._proxy.$acceptEditorDiffInformation(id, diffInformation);
		}));

		this._textEditorsListenersMap[id] = toDispose;
	}

	handleTextEditorRemoved(id: string): void {
		dispose(this._textEditorsListenersMap[id]);
		delete this._textEditorsListenersMap[id];
	}

	private _updateActiveAndVisibleTextEditors(): void {

		// editor columns
		const editorPositionData = this._getTextEditorPositionData();
		if (!objectEquals(this._editorPositionData, editorPositionData)) {
			this._editorPositionData = editorPositionData;
			this._proxy.$acceptEditorPositionData(this._editorPositionData);
		}
	}

	private _getTextEditorPositionData(): ITextEditorPositionData {
		const result: ITextEditorPositionData = Object.create(null);
		for (const editorPane of this._editorService.visibleEditorPanes) {
			const id = this._editorLocator.findTextEditorIdFor(editorPane);
			if (id) {
				result[id] = editorGroupToColumn(this._editorGroupService, editorPane.group);
			}
		}
		return result;
	}

	private _getTextEditorDiffInformation(textEditor: MainThreadTextEditor, toDispose: IDisposable[]): IObservable<ITextEditorDiffInformation[] | undefined> {
		const codeEditor = textEditor.getCodeEditor();
		if (!codeEditor) {
			return constObservable(undefined);
		}

		// Check if the TextModel belongs to a DiffEditor
		const [diffEditor] = this._codeEditorService.listDiffEditors()
			.filter(d =>
				d.getOriginalEditor().getId() === codeEditor.getId() ||
				d.getModifiedEditor().getId() === codeEditor.getId());

		const editorModelObs = diffEditor
			? observableFromEvent(this, diffEditor.onDidChangeModel, () => diffEditor.getModel())
			: observableFromEvent(this, codeEditor.onDidChangeModel, () => codeEditor.getModel());

		const editorChangesObs = derived<IObservable<{ original: URI; modified: URI; changes: readonly LineRangeMapping[] }[] | undefined>>(reader => {
			const editorModel = editorModelObs.read(reader);
			if (!editorModel) {
				return constObservable(undefined);
			}

			// TextEditor
			if (isITextModel(editorModel)) {
				const quickDiffModelRef = this._quickDiffModelService.createQuickDiffModelReference(editorModel.uri);
				if (!quickDiffModelRef) {
					return constObservable(undefined);
				}

				toDispose.push(quickDiffModelRef);
				return observableFromEvent(this, quickDiffModelRef.object.onDidChange, () => {
					return quickDiffModelRef.object.getQuickDiffResults()
						.map(result => ({
							original: result.original,
							modified: result.modified,
							changes: result.changes2
						}));
				});
			}

			// DiffEditor - we create a quick diff model (using the diff algorithm used by the diff editor)
			// even for diff editor so that we can provide multiple "original resources" to diff with the original
			// and modified resources.
			const diffAlgorithm = this._configurationService.getValue<DiffAlgorithmName>('diffEditor.diffAlgorithm');
			const quickDiffModelRef = this._quickDiffModelService.createQuickDiffModelReference(editorModel.modified.uri, { algorithm: diffAlgorithm });
			if (!quickDiffModelRef) {
				return constObservable(undefined);
			}

			toDispose.push(quickDiffModelRef);
			return observableFromEvent(Event.any(quickDiffModelRef.object.onDidChange, diffEditor.onDidUpdateDiff), () => {
				const diffChanges = diffEditor.getDiffComputationResult()?.changes2 ?? [];
				const diffInformation = [{
					original: editorModel.original.uri,
					modified: editorModel.modified.uri,
					changes: diffChanges.map(change => change as LineRangeMapping)
				}];

				// Add quick diff information from secondary/contributed providers
				const quickDiffInformation = quickDiffModelRef.object.getQuickDiffResults()
					.filter(result => result.providerKind !== 'primary')
					.map(result => ({
						original: result.original,
						modified: result.modified,
						changes: result.changes2
					}));

				// Combine diff and quick diff information
				return diffInformation.concat(quickDiffInformation);
			});
		});

		return derivedOpts({
			owner: this,
			equalsFn: (diff1, diff2) => equals(diff1, diff2, (a, b) =>
				isTextEditorDiffInformationEqual(this._uriIdentityService, a, b))
		}, reader => {
			const editorModel = editorModelObs.read(reader);
			const editorChanges = editorChangesObs.read(reader).read(reader);
			if (!editorModel || !editorChanges) {
				return undefined;
			}

			const documentVersion = isITextModel(editorModel)
				? editorModel.getVersionId()
				: editorModel.modified.getVersionId();

			return editorChanges.map(change => {
				const changes: ITextEditorChange[] = change.changes
					.map(change => [
						change.original.startLineNumber,
						change.original.endLineNumberExclusive,
						change.modified.startLineNumber,
						change.modified.endLineNumberExclusive
					]);

				return {
					documentVersion,
					original: change.original,
					modified: change.modified,
					changes
				};
			});
		});
	}

	// --- from extension host process

	async $tryShowTextDocument(resource: UriComponents, options: ITextDocumentShowOptions): Promise<string | undefined> {
		const uri = URI.revive(resource);
		const notebookUri = uri.scheme === Schemas.vscodeNotebookCell ? (parseNotebookCellUri(uri)?.notebook ?? uri) : uri;
		const openResource = uri.scheme === Schemas.vscodeNotebookCell ? notebookUri : uri;

		const editorOptions: ITextEditorOptions = {
			preserveFocus: options.preserveFocus,
			pinned: options.pinned,
			selection: options.selection,
			// preserve pre 1.38 behaviour to not make group active when preserveFocus: true
			// but make sure to restore the editor to fix https://github.com/microsoft/vscode/issues/79633
			activation: options.preserveFocus ? EditorActivation.RESTORE : undefined,
			override: EditorResolution.EXCLUSIVE_ONLY
		};
		if (uri.scheme === Schemas.vscodeNotebookCell) {
			const notebookEditors = this._notebookService.getContributedNotebookTypes(notebookUri);
			if (notebookEditors.length === 1) {
				editorOptions.override = notebookEditors[0].id;
			}
		}

		const input: IResourceEditorInput = {
			resource: openResource,
			options: editorOptions
		};

		const editorChange = this._waitForNextEditorChange();
		const editor = await this._editorService.openEditor(input, columnToEditorGroup(this._editorGroupService, this._configurationService, options.position));
		await editorChange;
		if (!editor) {
			return undefined;
		}
		if (uri.scheme === Schemas.vscodeNotebookCell) {
			const directNotebookCodeEditorId = this._findNotebookCellCodeEditorId(getNotebookEditorFromEditorPane(editor), uri);
			if (directNotebookCodeEditorId) {
				return directNotebookCodeEditorId;
			}

			await this._focusNotebookCellEditor(editor, uri);
			await this._focusNotebookCellOwner(notebookUri, uri);
			return this._waitForNotebookCellCodeEditor(editor, uri);
		}

		// Composite editors are made up of many editors so we return the active one at the time of opening
		const editorControl = editor.getControl();
		const codeEditor = getCodeEditor(editorControl);
		const codeEditorId = codeEditor && this._editorLocator.getIdOfCodeEditor(codeEditor);
		if (codeEditorId) {
			return codeEditorId;
		}
		const untrackedCodeEditorId = this._ensureTextEditorId(codeEditor, uri);
		if (untrackedCodeEditorId) {
			return untrackedCodeEditorId;
		}

		const editorPaneId = this._editorLocator.findTextEditorIdFor(editor);
		if (editorPaneId) {
			return editorPaneId;
		}

		return this._waitForTextEditorCodeEditor(editor, uri);
	}

	private async _waitForTextEditorCodeEditor(editor: IEditorPane, resource: URI): Promise<string | undefined> {
		for (let attempt = 0; attempt < MainThreadTextEditors._notebookCellEditorSettleAttempts; attempt++) {
			const directEditorId = this._editorLocator.findTextEditorIdFor(editor);
			if (directEditorId) {
				return directEditorId;
			}

			const directCodeEditor = getCodeEditor(editor.getControl());
			const directCodeEditorId = directCodeEditor && this._editorLocator.getIdOfCodeEditor(directCodeEditor);
			if (directCodeEditorId) {
				return directCodeEditorId;
			}
			const untrackedDirectCodeEditorId = this._ensureTextEditorId(directCodeEditor, resource);
			if (untrackedDirectCodeEditorId) {
				return untrackedDirectCodeEditorId;
			}

			const trackedCodeEditorId = this._findTrackedCodeEditorIdForResource(resource);
			if (trackedCodeEditorId) {
				return trackedCodeEditorId;
			}

			const activeCodeEditor = getCodeEditor(this._editorService.activeTextEditorControl);
			const activeModel = activeCodeEditor?.getModel();
			if (activeCodeEditor && activeModel && isITextModel(activeModel) && this._uriIdentityService.extUri.isEqual(activeModel.uri, resource)) {
				const activeCodeEditorId = this._editorLocator.getIdOfCodeEditor(activeCodeEditor);
				if (activeCodeEditorId) {
					return activeCodeEditorId;
				}
				const untrackedActiveCodeEditorId = this._ensureTextEditorId(activeCodeEditor, resource);
				if (untrackedActiveCodeEditorId) {
					return untrackedActiveCodeEditorId;
				}
			}

			for (const visibleEditorPane of this._editorService.visibleEditorPanes) {
				const candidateCodeEditor = getCodeEditor(visibleEditorPane.getControl());
				const candidateModel = candidateCodeEditor?.getModel();
				if (!candidateCodeEditor || !isITextModel(candidateModel) || !this._uriIdentityService.extUri.isEqual(candidateModel.uri, resource)) {
					continue;
				}

				const candidateCodeEditorId = this._editorLocator.getIdOfCodeEditor(candidateCodeEditor);
				if (candidateCodeEditorId) {
					return candidateCodeEditorId;
				}
				const untrackedCandidateCodeEditorId = this._ensureTextEditorId(candidateCodeEditor, resource);
				if (untrackedCandidateCodeEditorId) {
					return untrackedCandidateCodeEditorId;
				}
			}

			await timeout(50);
		}

		return undefined;
	}

	private _ensureTextEditorId(codeEditor: ICodeEditor | null, resource: URI): string | undefined {
		const model = codeEditor?.getModel();
		if (!codeEditor || !model || !isITextModel(model) || !this._uriIdentityService.extUri.isEqual(model.uri, resource)) {
			return undefined;
		}

		return this._editorLocator.ensureTextEditorForCodeEditor(codeEditor);
	}

	private async _focusNotebookCellEditor(editor: IEditorPane, resource: URI): Promise<void> {
		const notebookEditor = getNotebookEditorFromEditorPane(editor);
		const parsedCellUri = parseNotebookCellUri(resource);
		if (!notebookEditor || !parsedCellUri?.notebook || !notebookEditor.textModel || !this._uriIdentityService.extUri.isEqual(notebookEditor.textModel.uri, parsedCellUri.notebook)) {
			return;
		}

		const cellIndex = notebookEditor.textModel.cells.findIndex(cell => cell.handle === parsedCellUri.handle);
		if (cellIndex < 0) {
			return;
		}

		const focusRange = { start: cellIndex, end: cellIndex + 1 };
		notebookEditor.setSelections([focusRange]);
		notebookEditor.setFocus(focusRange);
		notebookEditor.revealCellRangeInView(focusRange);

		const cell = notebookEditor.cellAt(cellIndex);
		if (!cell) {
			return;
		}

		const focusPromise = notebookEditor.focusNotebookCell(cell, 'editor').catch(() => undefined);
		await Promise.race([focusPromise, timeout(500)]);
	}

	private async _waitForNotebookCellCodeEditor(editor: IEditorPane, resource: URI): Promise<string | undefined> {
		for (let attempt = 0; attempt < MainThreadTextEditors._notebookCellEditorSettleAttempts; attempt++) {
			const editorControl = editor.getControl();
			const directCodeEditor = getCodeEditor(editorControl);
			const directCodeEditorId = directCodeEditor && this._editorLocator.getIdOfCodeEditor(directCodeEditor);
			if (directCodeEditorId) {
				return directCodeEditorId;
			}

			const directNotebookCodeEditorId = this._findNotebookCellCodeEditorId(getNotebookEditorFromEditorPane(editor), resource);
			if (directNotebookCodeEditorId) {
				return directNotebookCodeEditorId;
			}

			const trackedCodeEditorId = this._findTrackedCodeEditorIdForResource(resource);
			if (trackedCodeEditorId) {
				return trackedCodeEditorId;
			}

			const activeCodeEditor = getCodeEditor(this._editorService.activeTextEditorControl);
			const activeModel = activeCodeEditor?.getModel();
			if (activeCodeEditor && activeModel && isITextModel(activeModel)) {
				const activeCodeEditorId = this._editorLocator.getIdOfCodeEditor(activeCodeEditor);
				if (this._uriIdentityService.extUri.isEqual(activeModel.uri, resource) && activeCodeEditorId) {
					return activeCodeEditorId;
				}
				if (this._uriIdentityService.extUri.isEqual(activeModel.uri, resource)) {
					const untrackedActiveCodeEditorId = this._ensureTextEditorId(activeCodeEditor, resource);
					if (untrackedActiveCodeEditorId) {
						return untrackedActiveCodeEditorId;
					}
				}

				const requestedNotebook = parseNotebookCellUri(resource)?.notebook;
				const activeNotebook = parseNotebookCellUri(activeModel.uri)?.notebook;
				if (requestedNotebook && activeNotebook && this._uriIdentityService.extUri.isEqual(activeNotebook, requestedNotebook)) {
					if (activeCodeEditorId) {
						return activeCodeEditorId;
					}
					const adoptedActiveNotebookEditorId = this._editorLocator.ensureTextEditorForCodeEditor(activeCodeEditor);
					if (adoptedActiveNotebookEditorId) {
						return adoptedActiveNotebookEditorId;
					}
				}
			}

			for (const visibleEditorPane of this._editorService.visibleEditorPanes) {
				const visibleNotebookCodeEditorId = this._findNotebookCellCodeEditorId(getNotebookEditorFromEditorPane(visibleEditorPane), resource);
				if (visibleNotebookCodeEditorId) {
					return visibleNotebookCodeEditorId;
				}

				const candidateCodeEditor = getCodeEditor(visibleEditorPane.getControl());
				const candidateModel = candidateCodeEditor?.getModel();
				if (!candidateCodeEditor || !isITextModel(candidateModel) || !this._uriIdentityService.extUri.isEqual(candidateModel.uri, resource)) {
					continue;
				}

				const candidateCodeEditorId = this._editorLocator.getIdOfCodeEditor(candidateCodeEditor);
				if (candidateCodeEditorId) {
					return candidateCodeEditorId;
				}
				const untrackedCandidateCodeEditorId = this._ensureTextEditorId(candidateCodeEditor, resource);
				if (untrackedCandidateCodeEditorId) {
					return untrackedCandidateCodeEditorId;
				}
			}

			await timeout(50);
		}

		return undefined;
	}

	private _findNotebookCellCodeEditorId(notebookEditor: INotebookEditor | undefined, resource: URI): string | undefined {
		if (!notebookEditor) {
			return undefined;
		}

		const targetNotebook = parseNotebookCellUri(resource)?.notebook;
		let fallbackCodeEditorId: string | undefined;
		const candidateCodeEditors = notebookEditor.activeCodeEditor
			? [notebookEditor.activeCodeEditor, ...notebookEditor.codeEditors.map(([, codeEditor]) => codeEditor).filter(codeEditor => codeEditor !== notebookEditor.activeCodeEditor)]
			: notebookEditor.codeEditors.map(([, codeEditor]) => codeEditor);

		for (const candidateCodeEditor of candidateCodeEditors) {
			const candidateModel = candidateCodeEditor.getModel();
			if (!candidateModel || !isITextModel(candidateModel)) {
				continue;
			}

			let candidateCodeEditorId = this._editorLocator.getIdOfCodeEditor(candidateCodeEditor);

			if (this._uriIdentityService.extUri.isEqual(candidateModel.uri, resource)) {
				if (!candidateCodeEditorId) {
					candidateCodeEditorId = this._editorLocator.ensureTextEditorForCodeEditor(candidateCodeEditor);
				}
				return candidateCodeEditorId;
			}

			if (!fallbackCodeEditorId && targetNotebook) {
				const candidateNotebook = parseNotebookCellUri(candidateModel.uri)?.notebook;
				if (candidateNotebook && this._uriIdentityService.extUri.isEqual(candidateNotebook, targetNotebook)) {
					fallbackCodeEditorId = candidateCodeEditorId ?? this._editorLocator.ensureTextEditorForCodeEditor(candidateCodeEditor);
				}
			}
		}

		return fallbackCodeEditorId;
	}

	private _findTrackedCodeEditorIdForResource(resource: URI): string | undefined {
		const targetNotebook = parseNotebookCellUri(resource)?.notebook;
		let fallbackCodeEditorId: string | undefined;

		for (const codeEditor of this._codeEditorService.listCodeEditors()) {
			const model = codeEditor.getModel();
			if (!model || !isITextModel(model)) {
				continue;
			}

			const editorId = this._editorLocator.getIdOfCodeEditor(codeEditor);
			if (!editorId) {
				continue;
			}

			if (this._uriIdentityService.extUri.isEqual(model.uri, resource)) {
				return editorId;
			}

			if (!fallbackCodeEditorId && targetNotebook) {
				const candidateNotebook = parseNotebookCellUri(model.uri)?.notebook;
				if (candidateNotebook && this._uriIdentityService.extUri.isEqual(candidateNotebook, targetNotebook)) {
					fallbackCodeEditorId = editorId;
				}
			}
		}

		return fallbackCodeEditorId;
	}

	private async _waitForNotebookCellOwner(resource: URI): Promise<void> {
		for (let attempt = 0; attempt < MainThreadTextEditors._notebookCellEditorSettleAttempts; attempt++) {
			const activeNotebookEditor = getNotebookEditorFromEditorPane(this._editorService.activeEditorPane);
			if (activeNotebookEditor?.textModel && this._uriIdentityService.extUri.isEqual(activeNotebookEditor.textModel.uri, resource)) {
				return;
			}

			for (const visibleEditorPane of this._editorService.visibleEditorPanes) {
				const visibleNotebookEditor = getNotebookEditorFromEditorPane(visibleEditorPane);
				if (visibleNotebookEditor?.textModel && this._uriIdentityService.extUri.isEqual(visibleNotebookEditor.textModel.uri, resource)) {
					return;
				}
			}

			await timeout(50);
		}
	}

	private async _focusNotebookCellOwner(ownerResource: URI, cellResource: URI): Promise<void> {
		if (this._uriIdentityService.extUri.isEqual(parseNotebookCellUri(cellResource)?.notebook ?? cellResource, ownerResource)) {
			await this._focusNotebookCellEditorInPane(this._editorService.activeEditorPane, cellResource);
			for (const visibleEditorPane of this._editorService.visibleEditorPanes) {
				if (visibleEditorPane === this._editorService.activeEditorPane) {
					continue;
				}
				await this._focusNotebookCellEditorInPane(visibleEditorPane, cellResource);
			}
		}
	}

	private async _waitForActiveNotebookCellOwner(resource: URI): Promise<void> {
		for (let attempt = 0; attempt < MainThreadTextEditors._notebookCellEditorSettleAttempts; attempt++) {
			const activeNotebookEditor = getNotebookEditorFromEditorPane(this._editorService.activeEditorPane);
			if (activeNotebookEditor?.textModel && this._uriIdentityService.extUri.isEqual(activeNotebookEditor.textModel.uri, resource)) {
				return;
			}

			const activeCodeEditor = getCodeEditor(this._editorService.activeTextEditorControl);
			const activeModel = activeCodeEditor?.getModel();
			if (activeModel && isITextModel(activeModel)) {
				const activeNotebook = parseNotebookCellUri(activeModel.uri)?.notebook;
				if (activeNotebook && this._uriIdentityService.extUri.isEqual(activeNotebook, resource)) {
					return;
				}
			}

			await timeout(50);
		}
	}

	private async _focusNotebookCellEditorInPane(editorPane: IEditorPane | undefined, resource: URI): Promise<void> {
		if (!editorPane) {
			return;
		}

		const notebookEditor = getNotebookEditorFromEditorPane(editorPane);
		const targetNotebook = parseNotebookCellUri(resource)?.notebook;
		if (!notebookEditor?.textModel || !targetNotebook || !this._uriIdentityService.extUri.isEqual(notebookEditor.textModel.uri, targetNotebook)) {
			return;
		}

		await this._focusNotebookCellEditor(editorPane, resource);
	}

	private async _waitForNextEditorChange(): Promise<void> {
		let resolved = false;
		let resolvePromise: (() => void) | undefined;
		const eventPromise = new Promise<void>(resolve => {
			resolvePromise = resolve;
		});
		const listener = this._editorService.onDidVisibleEditorsChange(() => {
			if (!resolved) {
				resolved = true;
				listener.dispose();
				resolvePromise?.();
			}
		});

		await Promise.race([eventPromise, timeout(MainThreadTextEditors._editorChangeSettleTimeout)]);

		if (!resolved) {
			resolved = true;
			listener.dispose();
		}
	}

	async $tryShowEditor(id: string, position?: EditorGroupColumn): Promise<void> {
		const mainThreadEditor = this._editorLocator.getEditor(id);
		if (mainThreadEditor) {
			const model = mainThreadEditor.getModel();
			await this._editorService.openEditor({
				resource: model.uri,
				options: { preserveFocus: false }
			}, columnToEditorGroup(this._editorGroupService, this._configurationService, position));
			return;
		}
	}

	async $tryHideEditor(id: string): Promise<void> {
		const mainThreadEditor = this._editorLocator.getEditor(id);
		if (mainThreadEditor) {
			const editorPanes = this._editorService.visibleEditorPanes;
			for (const editorPane of editorPanes) {
				if (mainThreadEditor.matches(editorPane)) {
					await editorPane.group.closeEditor(editorPane.input);
					return;
				}
			}
		}
	}

	$trySetSelections(id: string, selections: ISelection[]): Promise<void> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.setSelections(selections);
		return Promise.resolve(undefined);
	}

	$trySetDecorations(id: string, key: string, ranges: IDecorationOptions[]): Promise<void> {
		key = `${this._instanceId}-${key}`;
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.setDecorations(key, ranges);
		return Promise.resolve(undefined);
	}

	$trySetDecorationsFast(id: string, key: string, ranges: number[]): Promise<void> {
		key = `${this._instanceId}-${key}`;
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.setDecorationsFast(key, ranges);
		return Promise.resolve(undefined);
	}

	$tryRevealRange(id: string, range: IRange, revealType: TextEditorRevealType): Promise<void> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.revealRange(range, revealType);
		return Promise.resolve();
	}

	$trySetOptions(id: string, options: ITextEditorConfigurationUpdate): Promise<void> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		editor.setConfiguration(options);
		return Promise.resolve(undefined);
	}

	$tryApplyEdits(id: string, modelVersionId: number, edits: ISingleEditOperation[], opts: IApplyEditsOptions): Promise<boolean> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		return Promise.resolve(editor.applyEdits(modelVersionId, edits, opts));
	}

	$tryInsertSnippet(id: string, modelVersionId: number, template: string, ranges: readonly IRange[], opts: IUndoStopOptions): Promise<boolean> {
		const editor = this._editorLocator.getEditor(id);
		if (!editor) {
			return Promise.reject(illegalArgument(`TextEditor(${id})`));
		}
		return Promise.resolve(editor.insertSnippet(modelVersionId, template, ranges, opts));
	}

	$registerTextEditorDecorationType(extensionId: ExtensionIdentifier, key: string, options: IDecorationRenderOptions): void {
		key = `${this._instanceId}-${key}`;
		this._registeredDecorationTypes[key] = true;
		this._codeEditorService.registerDecorationType(`exthost-api-${extensionId}`, key, options);
	}

	$removeTextEditorDecorationType(key: string): void {
		key = `${this._instanceId}-${key}`;
		delete this._registeredDecorationTypes[key];
		this._codeEditorService.removeDecorationType(key);
	}

	$getDiffInformation(id: string): Promise<IChange[]> {
		const editor = this._editorLocator.getEditor(id);

		if (!editor) {
			return Promise.reject(new Error('No such TextEditor'));
		}

		const codeEditor = editor.getCodeEditor();
		if (!codeEditor) {
			return Promise.reject(new Error('No such CodeEditor'));
		}

		const codeEditorId = codeEditor.getId();
		const diffEditors = this._codeEditorService.listDiffEditors();
		const [diffEditor] = diffEditors.filter(d => d.getOriginalEditor().getId() === codeEditorId || d.getModifiedEditor().getId() === codeEditorId);

		if (diffEditor) {
			return Promise.resolve(diffEditor.getLineChanges() || []);
		}

		if (!codeEditor.hasModel()) {
			return Promise.resolve([]);
		}

		const quickDiffModelRef = this._quickDiffModelService.createQuickDiffModelReference(codeEditor.getModel().uri);
		if (!quickDiffModelRef) {
			return Promise.resolve([]);
		}

		try {
			const primaryQuickDiff = quickDiffModelRef.object.quickDiffs.find(quickDiff => quickDiff.kind === 'primary');
			const primaryQuickDiffChanges = quickDiffModelRef.object.changes.filter(change => change.providerId === primaryQuickDiff?.id);

			return Promise.resolve(primaryQuickDiffChanges.map(change => change.change) ?? []);
		} finally {
			quickDiffModelRef.dispose();
		}
	}
}

// --- commands

CommandsRegistry.registerCommand('_workbench.revertAllDirty', async function (accessor: ServicesAccessor) {
	const environmentService = accessor.get(IEnvironmentService);
	if (!environmentService.extensionTestsLocationURI) {
		throw new Error('Command is only available when running extension tests.');
	}

	const workingCopyService = accessor.get(IWorkingCopyService);
	for (const workingCopy of workingCopyService.dirtyWorkingCopies) {
		await workingCopy.revert({ soft: workingCopy.resource.scheme !== Schemas.untitled });
	}
});
