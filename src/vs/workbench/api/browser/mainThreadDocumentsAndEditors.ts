/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { combinedDisposable, DisposableStore, DisposableMap } from '../../../base/common/lifecycle.js';
import { ICodeEditor, isCodeEditor, isDiffEditor, IActiveCodeEditor, getCodeEditor } from '../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { IEditor } from '../../../editor/common/editorCommon.js';
import { ITextModel, shouldSynchronizeModel } from '../../../editor/common/model.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { extHostCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { MainThreadDocuments } from './mainThreadDocuments.js';
import { MainThreadTextEditor } from './mainThreadEditor.js';
import { IMainThreadEditorLocator, MainThreadTextEditors } from './mainThreadEditors.js';
import { ExtHostContext, ExtHostDocumentsAndEditorsShape, IDocumentsAndEditorsDelta, IModelAddedData, ITextEditorAddData, MainContext } from '../common/extHost.protocol.js';
import { AbstractTextEditor } from '../../browser/parts/editor/textEditor.js';
import { IEditorPane } from '../../common/editor.js';
import { EditorGroupColumn, editorGroupToColumn } from '../../services/editor/common/editorGroupColumn.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { ITextFileService } from '../../services/textfile/common/textfiles.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';
import { IWorkingCopyFileService } from '../../services/workingCopy/common/workingCopyFileService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { IPathService } from '../../services/path/common/pathService.js';
import { diffSets, diffMaps } from '../../../base/common/collections.js';
import { IPaneCompositePartService } from '../../services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../common/views.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IQuickDiffModelService } from '../../contrib/scm/browser/quickDiffModel.js';
import { getNotebookEditorFromEditorPane } from '../../contrib/notebook/browser/notebookBrowser.js';
import { INotebookService } from '../../contrib/notebook/common/notebookService.js';
import { parse as parseNotebookCellUri } from '../../services/notebook/common/notebookDocumentService.js';
class TextEditorSnapshot {

	readonly id: string;

	constructor(
		readonly editor: IActiveCodeEditor,
	) {
		this.id = `${editor.getId()},${editor.getModel().id}`;
	}
}

class DocumentAndEditorStateDelta {

	readonly isEmpty: boolean;

	constructor(
		readonly removedDocuments: ITextModel[],
		readonly addedDocuments: ITextModel[],
		readonly removedEditors: TextEditorSnapshot[],
		readonly addedEditors: TextEditorSnapshot[],
		readonly oldActiveEditor: string | null | undefined,
		readonly newActiveEditor: string | null | undefined,
	) {
		this.isEmpty = this.removedDocuments.length === 0
			&& this.addedDocuments.length === 0
			&& this.removedEditors.length === 0
			&& this.addedEditors.length === 0
			&& oldActiveEditor === newActiveEditor;
	}

	toString(): string {
		let ret = 'DocumentAndEditorStateDelta\n';
		ret += `\tRemoved Documents: [${this.removedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tAdded Documents: [${this.addedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tRemoved Editors: [${this.removedEditors.map(e => e.id).join(', ')}]\n`;
		ret += `\tAdded Editors: [${this.addedEditors.map(e => e.id).join(', ')}]\n`;
		ret += `\tNew Active Editor: ${this.newActiveEditor}\n`;
		return ret;
	}
}

class DocumentAndEditorState {

	static compute(before: DocumentAndEditorState | undefined, after: DocumentAndEditorState): DocumentAndEditorStateDelta {
		if (!before) {
			return new DocumentAndEditorStateDelta(
				[], [...after.documents.values()],
				[], [...after.textEditors.values()],
				undefined, after.activeEditor
			);
		}
		const documentDelta = diffSets(before.documents, after.documents);
		const editorDelta = diffMaps(before.textEditors, after.textEditors);
		const oldActiveEditor = before.activeEditor !== after.activeEditor ? before.activeEditor : undefined;
		const newActiveEditor = before.activeEditor !== after.activeEditor ? after.activeEditor : undefined;

		return new DocumentAndEditorStateDelta(
			documentDelta.removed, documentDelta.added,
			editorDelta.removed, editorDelta.added,
			oldActiveEditor, newActiveEditor
		);
	}

	constructor(
		readonly documents: Set<ITextModel>,
		readonly textEditors: Map<string, TextEditorSnapshot>,
		readonly activeEditor: string | null | undefined,
	) {
		//
	}
}

const enum ActiveEditorOrder {
	Editor, Panel
}

class MainThreadDocumentAndEditorStateComputer {

	private readonly _toDispose = new DisposableStore();
	private readonly _toDisposeOnEditorRemove = new DisposableMap<string>();
	private readonly _toDisposeOnGroupModelChange = new DisposableMap<number>();
	private _currentState?: DocumentAndEditorState;
	private _activeEditorOrder: ActiveEditorOrder = ActiveEditorOrder.Editor;

	constructor(
		private readonly _onDidChangeState: (delta: DocumentAndEditorStateDelta) => void,
		@IModelService private readonly _modelService: IModelService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IPaneCompositePartService private readonly _paneCompositeService: IPaneCompositePartService,
	) {
		this._modelService.onModelAdded(this._updateStateOnModelAdd, this, this._toDispose);
		this._modelService.onModelRemoved(_ => this._updateState(), this, this._toDispose);
		this._editorService.onDidActiveEditorChange(_ => this._updateState(), this, this._toDispose);
		this._editorService.onDidEditorsChange(_ => this._updateState(), this, this._toDispose);
		this._editorGroupService.onDidAddGroup(this._onDidAddGroup, this, this._toDispose);
		this._editorGroupService.onDidRemoveGroup(this._onDidRemoveGroup, this, this._toDispose);
		this._editorGroupService.groups.forEach(this._onDidAddGroup, this);

		this._codeEditorService.onCodeEditorAdd(this._onDidAddEditor, this, this._toDispose);
		this._codeEditorService.onCodeEditorRemove(this._onDidRemoveEditor, this, this._toDispose);
		this._codeEditorService.listCodeEditors().forEach(this._onDidAddEditor, this);

		Event.filter(this._paneCompositeService.onDidPaneCompositeOpen, event => event.viewContainerLocation === ViewContainerLocation.Panel)(_ => this._activeEditorOrder = ActiveEditorOrder.Panel, undefined, this._toDispose);
		Event.filter(this._paneCompositeService.onDidPaneCompositeClose, event => event.viewContainerLocation === ViewContainerLocation.Panel)(_ => this._activeEditorOrder = ActiveEditorOrder.Editor, undefined, this._toDispose);
		this._editorService.onDidVisibleEditorsChange(() => {
			this._activeEditorOrder = ActiveEditorOrder.Editor;
			this._updateState();
		}, undefined, this._toDispose);

		this._updateState();
	}

	dispose(): void {
		this._toDispose.dispose();
		this._toDisposeOnEditorRemove.dispose();
		this._toDisposeOnGroupModelChange.dispose();
	}

	private _onDidAddGroup(group: IEditorGroup): void {
		if (this._toDisposeOnGroupModelChange.has(group.id)) {
			return;
		}

		this._toDisposeOnGroupModelChange.set(group.id, group.onDidModelChange(() => this._updateState()));
	}

	private _onDidRemoveGroup(group: IEditorGroup): void {
		this._toDisposeOnGroupModelChange.deleteAndDispose(group.id);
		this._updateState();
	}

	private _onDidAddEditor(e: ICodeEditor): void {
		this._toDisposeOnEditorRemove.set(e.getId(), combinedDisposable(
			e.onDidChangeModel(() => this._updateState()),
			e.onDidFocusEditorText(() => this._updateState()),
			e.onDidFocusEditorWidget(() => this._updateState(e))
		));
		this._updateState();
	}

	private _onDidRemoveEditor(e: ICodeEditor): void {
		const id = e.getId();
		if (this._toDisposeOnEditorRemove.has(id)) {
			this._toDisposeOnEditorRemove.deleteAndDispose(id);
			this._updateState();
		}
	}

	private _updateStateOnModelAdd(model: ITextModel): void {
		if (!shouldSynchronizeModel(model)) {
			// ignore
			return;
		}

		// Model-add timing differs more under Tauri; recompute the full state so
		// documents and nested editors stay in sync instead of relying on the
		// fast-path delta.
		this._updateState();
	}

	private _updateState(widgetFocusCandidate?: ICodeEditor): void {

		// models: ignore too large models
		const models = new Set<ITextModel>();
		for (const model of this._modelService.getModels()) {
			if (shouldSynchronizeModel(model)) {
				models.add(model);
			}
		}

		const visiblePaneCodeEditors = new Set<ICodeEditor>();
		const hasOpenedWorkbenchEditors = this._editorGroupService.groups.some(group => group.count > 0);
		const candidateEditors: ICodeEditor[] = [...this._codeEditorService.listCodeEditors()];
		for (const editorPane of this._editorService.visibleEditorPanes) {
			if (!editorPane.input || editorPane.group.count === 0 || !editorPane.group.contains(editorPane.input)) {
				continue;
			}

			const codeEditor = getCodeEditor(editorPane.getControl());
			if (codeEditor) {
				if (!visiblePaneCodeEditors.has(codeEditor)) {
					visiblePaneCodeEditors.add(codeEditor);
					if (!candidateEditors.includes(codeEditor)) {
						candidateEditors.push(codeEditor);
					}
				}
			}
		}
		const activeEditorPane = this._editorService.activeEditorPane;
		const hasActiveEditorPaneInput = !!activeEditorPane?.input && activeEditorPane.group.count > 0 && activeEditorPane.group.contains(activeEditorPane.input);
		const activeCodeEditor = getCodeEditor(this._editorService.activeTextEditorControl);
		if (activeCodeEditor && !visiblePaneCodeEditors.has(activeCodeEditor)) {
			const shouldTrackActiveCodeEditor = hasActiveEditorPaneInput || activeCodeEditor.hasTextFocus() || activeCodeEditor.hasWidgetFocus();
			if (shouldTrackActiveCodeEditor) {
				visiblePaneCodeEditors.add(activeCodeEditor);
				if (!candidateEditors.includes(activeCodeEditor)) {
					candidateEditors.push(activeCodeEditor);
				}
			}
		}

		// editor: only take those that have a not too large model
		const editors = new Map<string, TextEditorSnapshot>();
		let activeEditor: string | null = null; // Strict null work. This doesn't like being undefined!

		for (const editor of candidateEditors) {
			const model = editor.getModel();
			const isNotebookBackedWidget = model?.uri.scheme === Schemas.vscodeNotebookCell || model?.uri.scheme === Schemas.vscodeInteractiveInput;
			const isVisibleOrActiveEditor = visiblePaneCodeEditors.has(editor) || editor === activeCodeEditor;
			if (!hasOpenedWorkbenchEditors && !isNotebookBackedWidget && !isVisibleOrActiveEditor) {
				continue;
			}

			if (!isVisibleOrActiveEditor && !isNotebookBackedWidget) {
				continue;
			}

			if (editor.isSimpleWidget && model?.isForSimpleWidget && !isNotebookBackedWidget && !visiblePaneCodeEditors.has(editor)) {
				continue;
			}
			if (editor.hasModel() && model && shouldSynchronizeModel(model)
				&& !model.isDisposed() // model disposed
				&& (isNotebookBackedWidget || Boolean(this._modelService.getModel(model.uri)) || isVisibleOrActiveEditor) // active editor models can exist before they settle in the shared model service
			) {
				models.add(model);
				const apiEditor = new TextEditorSnapshot(editor);
				editors.set(apiEditor.id, apiEditor);
				if (editor.hasTextFocus() || (widgetFocusCandidate === editor && editor.hasWidgetFocus())) {
					// text focus has priority, widget focus is tricky because multiple
					// editors might claim widget focus at the same time. therefore we use a
					// candidate (which is the editor that has raised an widget focus event)
					// in addition to the widget focus check
					activeEditor = apiEditor.id;
				}
			}
		}

		// active editor: if none of the previous editors had focus we try
		// to match output panels or the active workbench editor with
		// one of editor we have just computed
		if (!activeEditor) {
			let candidate: IEditor | undefined;
			if (this._activeEditorOrder === ActiveEditorOrder.Editor) {
				candidate = this._getActiveEditorFromEditorPart() || this._getActiveEditorFromPanel();
			} else {
				candidate = this._getActiveEditorFromPanel() || this._getActiveEditorFromEditorPart();
			}

			if (candidate) {
				for (const snapshot of editors.values()) {
					if (candidate === snapshot.editor) {
						activeEditor = snapshot.id;
					}
				}
			}
		}

		if (!activeEditor) {
			const activeNotebookEditor = getNotebookEditorFromEditorPane(this._editorService.activeEditorPane);
			if (activeNotebookEditor?.textModel) {
				for (const snapshot of editors.values()) {
					const notebookCell = parseNotebookCellUri(snapshot.editor.getModel().uri);
					if (notebookCell && notebookCell.notebook.toString() === activeNotebookEditor.textModel.uri.toString()) {
						activeEditor = snapshot.id;
						break;
					}
				}
			}
		}

		// compute new state and compare against old
		const newState = new DocumentAndEditorState(models, editors, activeEditor);
		const delta = DocumentAndEditorState.compute(this._currentState, newState);
		if (!delta.isEmpty) {
			this._currentState = newState;
			this._onDidChangeState(delta);
		}
	}

	private _getActiveEditorFromPanel(): IEditor | undefined {
		const panel = this._paneCompositeService.getActivePaneComposite(ViewContainerLocation.Panel);
		if (panel instanceof AbstractTextEditor) {
			const control = panel.getControl();
			if (isCodeEditor(control)) {
				return control;
			}
		}

		return undefined;
	}

	private _getActiveEditorFromEditorPart(): IEditor | undefined {
		if (!this._editorService.activeEditorPane?.input || this._editorService.activeEditorPane.group.count === 0 || !this._editorService.activeEditorPane.group.contains(this._editorService.activeEditorPane.input)) {
			return undefined;
		}

		let activeTextEditorControl = this._editorService.activeTextEditorControl;
		if (isDiffEditor(activeTextEditorControl)) {
			activeTextEditorControl = activeTextEditorControl.getModifiedEditor();
		}
		return activeTextEditorControl;
	}
}

@extHostCustomer
export class MainThreadDocumentsAndEditors implements IMainThreadEditorLocator {

	private readonly _toDispose = new DisposableStore();
	private readonly _proxy: ExtHostDocumentsAndEditorsShape;
	private readonly _mainThreadDocuments: MainThreadDocuments;
	private readonly _mainThreadEditors: MainThreadTextEditors;
	private readonly _textEditors = new Map<string, MainThreadTextEditor>();

	constructor(
		extHostContext: IExtHostContext,
		@IModelService private readonly _modelService: IModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IFileService fileService: IFileService,
		@ITextModelService textModelResolverService: ITextModelService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IPaneCompositePartService paneCompositeService: IPaneCompositePartService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IWorkingCopyFileService workingCopyFileService: IWorkingCopyFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IPathService pathService: IPathService,
		@IConfigurationService configurationService: IConfigurationService,
		@IQuickDiffModelService quickDiffModelService: IQuickDiffModelService,
		@INotebookService notebookService: INotebookService
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostDocumentsAndEditors);

		this._mainThreadDocuments = this._toDispose.add(new MainThreadDocuments(extHostContext, this._modelService, this._textFileService, fileService, textModelResolverService, environmentService, uriIdentityService, workingCopyFileService, pathService));
		extHostContext.set(MainContext.MainThreadDocuments, this._mainThreadDocuments);

		this._mainThreadEditors = this._toDispose.add(new MainThreadTextEditors(this, extHostContext, codeEditorService, this._editorService, this._editorGroupService, configurationService, quickDiffModelService, uriIdentityService, notebookService));
		extHostContext.set(MainContext.MainThreadTextEditors, this._mainThreadEditors);

		// It is expected that the ctor of the state computer calls our `_onDelta`.
		this._toDispose.add(new MainThreadDocumentAndEditorStateComputer(delta => this._onDelta(delta), _modelService, codeEditorService, this._editorService, this._editorGroupService, paneCompositeService));
	}

	dispose(): void {
		this._toDispose.dispose();
	}

	private _onDelta(delta: DocumentAndEditorStateDelta): void {

		const removedEditors: string[] = [];
		const addedEditors: MainThreadTextEditor[] = [];
		const syntheticAddedDocuments: ITextModel[] = [];
		let newActiveEditor = delta.newActiveEditor;

		// removed models
		const removedDocuments = delta.removedDocuments.map(m => m.uri);

		// added editors
		for (const apiEditor of delta.addedEditors) {
			if (this._textEditors.has(apiEditor.id)) {
				continue;
			}

			const mainThreadEditor = new MainThreadTextEditor(apiEditor.id, apiEditor.editor.getModel(),
				apiEditor.editor, { onGainedFocus() { }, onLostFocus() { } }, this._mainThreadDocuments, this._modelService, this._clipboardService);

			this._textEditors.set(apiEditor.id, mainThreadEditor);
			addedEditors.push(mainThreadEditor);
		}

		if (addedEditors.length > 0) {
			const knownAddedDocumentUris = new Set(delta.addedDocuments.map(model => model.uri.toString()));
			for (const editor of addedEditors) {
				const model = editor.getModel();
				const modelUri = model.uri.toString();
				if (knownAddedDocumentUris.has(modelUri) || this._mainThreadDocuments.hasTrackedModel(model.uri)) {
					continue;
				}

				knownAddedDocumentUris.add(modelUri);
				syntheticAddedDocuments.push(model);
			}
		}

		const allAddedDocuments = syntheticAddedDocuments.length > 0
			? [...delta.addedDocuments, ...syntheticAddedDocuments]
			: delta.addedDocuments;

		// removed editors
		for (const { id } of delta.removedEditors) {
			const mainThreadEditor = this._textEditors.get(id);
			if (mainThreadEditor) {
				mainThreadEditor.dispose();
				this._textEditors.delete(id);
				removedEditors.push(id);
			}
		}

		if (newActiveEditor === undefined && this._editorService.activeEditorPane) {
			const activeAddedEditor = addedEditors.find(editor => editor.matches(this._editorService.activeEditorPane!));
			if (activeAddedEditor) {
				newActiveEditor = activeAddedEditor.getId();
			}
		}
		if (newActiveEditor === undefined && addedEditors.length === 1 && delta.removedEditors.length > 0) {
			newActiveEditor = addedEditors[0].getId();
		}

		const extHostDelta: IDocumentsAndEditorsDelta = Object.create(null);
		let empty = true;
		if (newActiveEditor !== undefined) {
			empty = false;
			extHostDelta.newActiveEditor = newActiveEditor;
		}
		if (removedDocuments.length > 0) {
			empty = false;
			extHostDelta.removedDocuments = removedDocuments;
		}
		if (removedEditors.length > 0) {
			empty = false;
			extHostDelta.removedEditors = removedEditors;
		}
		if (allAddedDocuments.length > 0) {
			empty = false;
			extHostDelta.addedDocuments = allAddedDocuments.map(m => this._toModelAddData(m));
		}
		if (delta.addedEditors.length > 0) {
			empty = false;
			extHostDelta.addedEditors = addedEditors.map(e => this._toTextEditorAddData(e));
		}

		if (!empty) {
			// first update ext host
			this._proxy.$acceptDocumentsAndEditorsDelta(extHostDelta);

			// second update dependent document/editor states
			removedDocuments.forEach(this._mainThreadDocuments.handleModelRemoved, this._mainThreadDocuments);
			delta.addedDocuments.forEach(this._mainThreadDocuments.handleModelAdded, this._mainThreadDocuments);
			syntheticAddedDocuments.forEach(this._mainThreadDocuments.handleModelAdded, this._mainThreadDocuments);

			removedEditors.forEach(this._mainThreadEditors.handleTextEditorRemoved, this._mainThreadEditors);
			addedEditors.forEach(this._mainThreadEditors.handleTextEditorAdded, this._mainThreadEditors);
		}
	}

	private _toModelAddData(model: ITextModel): IModelAddedData {
		return {
			uri: model.uri,
			versionId: model.getVersionId(),
			lines: model.getLinesContent(),
			EOL: model.getEOL(),
			languageId: model.getLanguageId(),
			isDirty: this._textFileService.untitled.get(model.uri)?.isDirty() ?? this._textFileService.isDirty(model.uri),
			encoding: this._textFileService.getEncoding(model.uri)
		};
	}

	private _toTextEditorAddData(textEditor: MainThreadTextEditor): ITextEditorAddData {
		const props = textEditor.getProperties();
		return {
			id: textEditor.getId(),
			documentUri: textEditor.getModel().uri,
			options: props.options,
			selections: props.selections,
			visibleRanges: props.visibleRanges,
			editorPosition: this._findEditorPosition(textEditor)
		};
	}

	private _findEditorPosition(editor: MainThreadTextEditor): EditorGroupColumn | undefined {
		for (const editorPane of this._editorService.visibleEditorPanes) {
			if (editor.matches(editorPane)) {
				return editorGroupToColumn(this._editorGroupService, editorPane.group);
			}
		}
		return undefined;
	}

	findTextEditorIdFor(editorPane: IEditorPane): string | undefined {
		for (const [id, editor] of this._textEditors) {
			if (editor.matches(editorPane)) {
				return id;
			}
		}
		return undefined;
	}

	getIdOfCodeEditor(codeEditor: ICodeEditor): string | undefined {
		for (const [id, editor] of this._textEditors) {
			if (editor.getCodeEditor() === codeEditor) {
				return id;
			}
		}
		return undefined;
	}

	ensureTextEditorForCodeEditor(codeEditor: ICodeEditor): string | undefined {
		const model = codeEditor.getModel();
		if (!model || !shouldSynchronizeModel(model) || model.isDisposed()) {
			return undefined;
		}

		const existingId = this.getIdOfCodeEditor(codeEditor);
		if (existingId) {
			return existingId;
		}

		const id = `${codeEditor.getId()},${model.id}`;
		if (this._textEditors.has(id)) {
			return id;
		}

		const mainThreadEditor = new MainThreadTextEditor(id, model, codeEditor,
			{ onGainedFocus() { }, onLostFocus() { } },
			this._mainThreadDocuments,
			this._modelService,
			this._clipboardService);

		this._textEditors.set(id, mainThreadEditor);

		const extHostDelta: IDocumentsAndEditorsDelta = {
			addedEditors: [this._toTextEditorAddData(mainThreadEditor)]
		};
		const needsDocumentSync = !this._mainThreadDocuments.hasTrackedModel(model.uri);
		if (needsDocumentSync) {
			extHostDelta.addedDocuments = [this._toModelAddData(model)];
		}
		if (this._editorService.activeEditorPane && mainThreadEditor.matches(this._editorService.activeEditorPane)) {
			extHostDelta.newActiveEditor = id;
		}

		this._proxy.$acceptDocumentsAndEditorsDelta(extHostDelta);
		if (needsDocumentSync) {
			this._mainThreadDocuments.handleModelAdded(model);
		}
		this._mainThreadEditors.handleTextEditorAdded(mainThreadEditor);
		return id;
	}

	getEditor(id: string): MainThreadTextEditor | undefined {
		return this._textEditors.get(id);
	}
}
