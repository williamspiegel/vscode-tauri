/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../base/common/async.js';
import { DisposableStore, dispose } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { isEqual } from '../../../base/common/resources.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { EditorActivation } from '../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { getCodeEditor } from '../../../editor/browser/editorBrowser.js';
import { getNotebookEditorFromEditorPane, INotebookEditor, INotebookEditorOptions } from '../../contrib/notebook/browser/notebookBrowser.js';
import { INotebookEditorService } from '../../contrib/notebook/browser/services/notebookEditorService.js';
import { NotebookEditorInput } from '../../contrib/notebook/common/notebookEditorInput.js';
import { ICellRange } from '../../contrib/notebook/common/notebookRange.js';
import { EditorResourceAccessor, IEditorPane, SideBySideEditor } from '../../common/editor.js';
import { columnToEditorGroup, editorGroupToColumn } from '../../services/editor/common/editorGroupColumn.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, ExtHostNotebookEditorsShape, INotebookDocumentShowOptions, INotebookEditorViewColumnInfo, MainThreadNotebookEditorsShape, NotebookEditorRevealType } from '../common/extHost.protocol.js';
import { parse as parseNotebookCellUri } from '../../services/notebook/common/notebookDocumentService.js';
import { getMainThreadEditorLocator } from './mainThreadDocumentsAndEditors.js';

const isTauriIntegration = typeof process !== 'undefined' && process.env?.VSCODE_TAURI_INTEGRATION === '1';

class MainThreadNotebook {

	constructor(
		readonly editor: INotebookEditor,
		readonly disposables: DisposableStore
	) { }

	dispose() {
		this.disposables.dispose();
	}
}

export class MainThreadNotebookEditors implements MainThreadNotebookEditorsShape {
	private static readonly _editorSettleAttempts = 300;
	private static readonly _groupSettleTimeout = 250;

	private readonly _disposables = new DisposableStore();

	private readonly _proxy: ExtHostNotebookEditorsShape;
	private readonly _mainThreadEditors = new Map<string, MainThreadNotebook>();

	private _currentViewColumnInfo?: INotebookEditorViewColumnInfo;

	constructor(
		extHostContext: IExtHostContext,
		@IEditorService private readonly _editorService: IEditorService,
		@INotebookEditorService private readonly _notebookEditorService: INotebookEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostNotebookEditors);

		this._editorService.onDidActiveEditorChange(() => this._updateEditorViewColumns(), this, this._disposables);
		this._editorGroupService.onDidRemoveGroup(() => this._updateEditorViewColumns(), this, this._disposables);
		this._editorGroupService.onDidMoveGroup(() => this._updateEditorViewColumns(), this, this._disposables);
	}

	dispose(): void {
		this._disposables.dispose();
		dispose(this._mainThreadEditors.values());
	}

	handleEditorsAdded(editors: readonly INotebookEditor[]): void {

		for (const editor of editors) {

			const editorDisposables = new DisposableStore();
			const notifyEditorPropertiesChanged = () => {
				this._proxy.$acceptEditorPropertiesChanged(editor.getId(), {
					visibleRanges: { ranges: editor.visibleRanges },
					selections: { selections: editor.getSelections() }
				});
			};
			editorDisposables.add(editor.onDidChangeVisibleRanges(() => {
				this._proxy.$acceptEditorPropertiesChanged(editor.getId(), { visibleRanges: { ranges: editor.visibleRanges } });
			}));

			editorDisposables.add(editor.onDidChangeSelection(() => {
				this._proxy.$acceptEditorPropertiesChanged(editor.getId(), { selections: { selections: editor.getSelections() } });
			}));

			const wrapper = new MainThreadNotebook(editor, editorDisposables);
			this._mainThreadEditors.set(editor.getId(), wrapper);
			notifyEditorPropertiesChanged();
			void (async () => {
				for (let attempt = 0; attempt < 40; attempt++) {
					if (!this._mainThreadEditors.has(editor.getId())) {
						return;
					}
					if (editor.visibleRanges.length > 0) {
						notifyEditorPropertiesChanged();
						return;
					}
					await timeout(50);
				}
			})();
		}
	}

	handleEditorsRemoved(editorIds: readonly string[]): void {
		for (const id of editorIds) {
			this._mainThreadEditors.get(id)?.dispose();
			this._mainThreadEditors.delete(id);
		}
	}

	private _updateEditorViewColumns(): void {
		const result: INotebookEditorViewColumnInfo = Object.create(null);
		for (const { editorPane, notebookEditor: candidate } of this._getVisibleNotebookEditorAssignments()) {
			if (candidate && this._mainThreadEditors.has(candidate.getId())) {
				result[candidate.getId()] = editorGroupToColumn(this._editorGroupService, editorPane.group);
			}
		}
		if (!equals(result, this._currentViewColumnInfo)) {
			this._currentViewColumnInfo = result;
			this._proxy.$acceptEditorViewColumns(result);
		}
	}

	async $tryShowNotebookDocument(resource: UriComponents, viewType: string, options: INotebookDocumentShowOptions): Promise<string> {
		const revivedResource = URI.revive(resource);
		const knownMatchingEditorIds = new Set(
			this._notebookEditorService.listNotebookEditors()
				.filter(notebookEditor => notebookEditor.textModel && isEqual(notebookEditor.textModel.uri, revivedResource))
				.map(notebookEditor => notebookEditor.getId())
		);
		const editorOptions: INotebookEditorOptions = {
			cellSelections: options.selections,
			preserveFocus: options.preserveFocus,
			pinned: options.pinned,
			// selection: options.selection,
			// preserve pre 1.38 behaviour to not make group active when preserveFocus: true
			// but make sure to restore the editor to fix https://github.com/microsoft/vscode/issues/79633
			activation: options.preserveFocus ? EditorActivation.RESTORE : undefined,
			label: options.label,
			override: viewType
		};

		const targetGroup = columnToEditorGroup(this._editorGroupService, this._configurationService, options.position);
		const needsNewGroup = typeof targetGroup === 'number'
			&& (targetGroup < 0 || !this._editorGroupService.getGroups(GroupsOrder.GRID_APPEARANCE)[targetGroup]);
		const groupAdd = needsNewGroup ? this._waitForNextGroupAdd() : undefined;
		const editorInput = NotebookEditorInput.getOrCreate(this._instantiationService, revivedResource, undefined, viewType, {});
		if (!isTauriIntegration) {
			await editorInput.resolve();
		} else {
			void editorInput.resolve().catch(() => undefined);
		}
		const editorPane = await this._withTauriNotebookStageTimeout(
			`openEditor(${revivedResource.toString()})`,
			this._editorService.openEditor(editorInput, editorOptions, targetGroup),
			() => this._describeNotebookOpenState(revivedResource, undefined, targetGroup)
		);
		if (groupAdd) {
			await groupAdd;
		}
		const resolvedTargetGroup = (editorPane as IEditorPane | undefined)?.group ?? targetGroup;
		const notebookEditor = await this._withTauriNotebookStageTimeout(
			`waitForNotebookEditor(${revivedResource.toString()})`,
			this._waitForNotebookEditor(editorPane, revivedResource, resolvedTargetGroup, knownMatchingEditorIds),
			() => this._describeNotebookOpenState(revivedResource, editorPane, resolvedTargetGroup)
		);

		if (notebookEditor) {
			if (!options.preserveFocus) {
				const targetNotebookGroup = this._getVisibleNotebookEditorPane(notebookEditor)?.group ?? resolvedTargetGroup;
				await this._withTauriNotebookStageTimeout(
					`waitForActiveNotebookEditor(${revivedResource.toString()})`,
					this._waitForActiveNotebookEditor(notebookEditor.getId(), revivedResource, targetNotebookGroup),
					() => this._describeNotebookOpenState(revivedResource, this._editorService.activeEditorPane, targetNotebookGroup)
				);
				await this._ensureNotebookCellEditorFocus(notebookEditor);
				await this._ensureActiveTextEditorMirror(revivedResource, notebookEditor);
			}
			return notebookEditor.getId();
		} else {
			throw new Error([
				`Notebook Editor creation failure for document ${JSON.stringify(resource)}`,
				this._describeNotebookOpenState(revivedResource, editorPane, resolvedTargetGroup)
			].join('\n'));
		}
	}

	private _describeNotebookOpenState(resource: URI, editorPane: unknown, targetGroup: IEditorGroup | number): string {
		const candidateEditorPane = editorPane as IEditorPane | undefined;
		const directNotebookEditor = this._getNotebookEditorFromPaneOrResource(candidateEditorPane);
		const directPaneResource = candidateEditorPane?.input
			? EditorResourceAccessor.getCanonicalUri(candidateEditorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY })?.toString()
			: undefined;
		const serviceEditors = this._notebookEditorService.listNotebookEditors().map(editor => ({
			id: editor.getId(),
			hasModel: editor.hasModel(),
			resource: editor.textModel?.uri.toString() ?? 'undefined'
		}));
		const visibleEditors = this._editorService.visibleEditorPanes.map(visibleEditorPane => {
			const visibleNotebookEditor = this._getNotebookEditorFromPaneOrResource(visibleEditorPane);
			return {
				groupId: visibleEditorPane.group.id,
				editorId: visibleNotebookEditor?.getId() ?? 'undefined',
				hasModel: visibleNotebookEditor?.hasModel() ?? false,
				resource: visibleNotebookEditor?.textModel?.uri.toString() ?? 'undefined',
				input: visibleEditorPane.input
					? EditorResourceAccessor.getCanonicalUri(visibleEditorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY })?.toString() ?? 'undefined'
					: 'undefined'
			};
		});

		return [
			`requested=${resource.toString()}`,
			`targetGroup=${typeof targetGroup === 'number' ? targetGroup : targetGroup.id}`,
			`directPaneInput=${directPaneResource ?? 'undefined'}`,
			`directNotebookEditor=${directNotebookEditor ? JSON.stringify({ id: directNotebookEditor.getId(), hasModel: directNotebookEditor.hasModel(), resource: directNotebookEditor.textModel?.uri.toString() ?? 'undefined' }) : 'undefined'}`,
			`serviceEditors=${JSON.stringify(serviceEditors)}`,
			`visibleEditors=${JSON.stringify(visibleEditors)}`
		].join(' ');
	}

	private async _waitForNotebookEditor(editorPane: unknown, resource: URI, targetGroup: IEditorGroup | number, knownMatchingEditorIds: ReadonlySet<string>): Promise<INotebookEditor | undefined> {
		for (let attempt = 0; attempt < MainThreadNotebookEditors._editorSettleAttempts; attempt++) {
			const notebookEditor = this._resolveNotebookEditor(editorPane, resource, targetGroup, knownMatchingEditorIds);
			if (notebookEditor) {
				return notebookEditor;
			}

			await timeout(50);
		}

		return undefined;
	}

	private async _waitForActiveNotebookEditor(editorId: string, resource: URI, targetGroup: IEditorGroup | number): Promise<void> {
		for (let attempt = 0; attempt < MainThreadNotebookEditors._editorSettleAttempts; attempt++) {
			const activeEditorPane = this._editorService.activeEditorPane;
			const activeNotebookEditor = this._getNotebookEditorFromPaneOrResource(activeEditorPane);
			if (activeNotebookEditor?.getId() === editorId) {
				return;
			}

			const visibleTargetNotebookEditors = this._getVisibleNotebookEditorsFor(resource, targetGroup);
			if (visibleTargetNotebookEditors.some(visibleEditor => visibleEditor.getId() === editorId)) {
				return;
			}

			if (activeEditorPane && this._isInTargetGroup(activeEditorPane, targetGroup)) {
				const activeResource = activeNotebookEditor?.textModel?.uri
					?? EditorResourceAccessor.getOriginalUri(activeEditorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY });
				if (activeResource && isEqual(activeResource, resource)) {
					return;
				}
			}

			if (isTauriIntegration) {
				const matchingNotebookEditors = this._notebookEditorService.listNotebookEditors().filter(notebookEditor =>
					notebookEditor.textModel && isEqual(notebookEditor.textModel.uri, resource)
				);
				if (matchingNotebookEditors.length > 1) {
					const visibleTargetPaneHasResource = this._editorService.visibleEditorPanes.some(visibleEditorPane =>
						this._isInTargetGroup(visibleEditorPane, targetGroup)
						&& !!visibleEditorPane.input
						&& !!EditorResourceAccessor.getCanonicalUri(visibleEditorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY })
						&& isEqual(EditorResourceAccessor.getCanonicalUri(visibleEditorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY })!, resource)
					);
					if (visibleTargetPaneHasResource) {
						return;
					}
				}
			}

			await timeout(50);
		}
	}

	private _resolveNotebookEditor(editorPane: unknown, resource: URI, targetGroup: IEditorGroup | number, knownMatchingEditorIds: ReadonlySet<string>): INotebookEditor | undefined {
		const candidateEditorPane = editorPane as IEditorPane | undefined;
		const directNotebookEditor = this._getNotebookEditorFromPaneOrResource(candidateEditorPane);
		const directNotebookResource = this._getNotebookResource(candidateEditorPane, directNotebookEditor);
		if (directNotebookEditor
			&& directNotebookResource
			&& isEqual(directNotebookResource, resource)
			&& (knownMatchingEditorIds.size === 0 || !knownMatchingEditorIds.has(directNotebookEditor.getId()))
			&& (!candidateEditorPane || this._isInTargetGroup(candidateEditorPane, targetGroup))) {
			return directNotebookEditor;
		}

		const matchingNotebookEditors = this._notebookEditorService.listNotebookEditors().filter(notebookEditor =>
			notebookEditor.textModel && isEqual(notebookEditor.textModel.uri, resource)
		);
		const newlyAddedMatchingNotebookEditors = matchingNotebookEditors.filter(notebookEditor => !knownMatchingEditorIds.has(notebookEditor.getId()));
		const visibleTargetNotebookEditors = this._getVisibleNotebookEditorsFor(resource, targetGroup);
		const visibleNewTargetNotebookEditors = visibleTargetNotebookEditors.filter(notebookEditor => !knownMatchingEditorIds.has(notebookEditor.getId()));
		if (visibleNewTargetNotebookEditors.length === 1) {
			return visibleNewTargetNotebookEditors[0];
		}
		if (visibleNewTargetNotebookEditors.length > 1) {
			return visibleNewTargetNotebookEditors.at(-1);
		}

		const newlyAddedVisibleTargetNotebookEditors = newlyAddedMatchingNotebookEditors.filter(notebookEditor =>
			visibleTargetNotebookEditors.some(visibleNotebookEditor => visibleNotebookEditor.getId() === notebookEditor.getId())
		);
		if (newlyAddedVisibleTargetNotebookEditors.length === 1) {
			return newlyAddedVisibleTargetNotebookEditors[0];
		}
		if (newlyAddedVisibleTargetNotebookEditors.length > 1) {
			return newlyAddedVisibleTargetNotebookEditors.at(-1);
		}

		if (newlyAddedMatchingNotebookEditors.length === 1) {
			return newlyAddedMatchingNotebookEditors[0];
		}
		if (newlyAddedMatchingNotebookEditors.length > 1) {
			return newlyAddedMatchingNotebookEditors.at(-1);
		}

		if (typeof targetGroup === 'number' && targetGroup < 0 && candidateEditorPane?.group) {
			const sideGroupNotebookEditors = this._getVisibleNotebookEditorAssignments()
				.filter(({ editorPane: visibleEditorPane }) => visibleEditorPane.group !== candidateEditorPane.group)
				.map(({ notebookEditor }) => notebookEditor)
				.filter(visibleNotebookEditor =>
					visibleNotebookEditor.hasModel() && !!visibleNotebookEditor.textModel && isEqual(visibleNotebookEditor.textModel.uri, resource)
				);

			if (sideGroupNotebookEditors.length === 1) {
				return sideGroupNotebookEditors[0];
			}
		}

		for (const { editorPane: visibleEditorPane, notebookEditor: visibleNotebookEditor } of this._getVisibleNotebookEditorAssignments()) {
			if (!this._isInTargetGroup(visibleEditorPane, targetGroup)) {
				continue;
			}

			const visibleNotebookResource = this._getNotebookResource(visibleEditorPane, visibleNotebookEditor);
			if (visibleNotebookEditor && visibleNotebookResource && isEqual(visibleNotebookResource, resource)) {
				return visibleNotebookEditor;
			}
		}

		const unseenMatchingNotebookEditors = matchingNotebookEditors.filter(notebookEditor => !this._mainThreadEditors.has(notebookEditor.getId()));
		if (unseenMatchingNotebookEditors.length === 1) {
			return unseenMatchingNotebookEditors[0];
		}
		if (knownMatchingEditorIds.size === 0 && matchingNotebookEditors.length === 1) {
			return matchingNotebookEditors[0];
		}
		if (isTauriIntegration && matchingNotebookEditors.length > 0) {
			return matchingNotebookEditors.at(-1);
		}

		return undefined;
	}

	private _getVisibleNotebookEditorsFor(resource: URI, targetGroup: IEditorGroup | number): INotebookEditor[] {
		const result: INotebookEditor[] = [];
		const seenEditorIds = new Set<string>();
		for (const { editorPane: visibleEditorPane, notebookEditor: visibleNotebookEditor } of this._getVisibleNotebookEditorAssignments()) {
			if (!this._isInTargetGroup(visibleEditorPane, targetGroup)) {
				continue;
			}

			const visibleNotebookResource = this._getNotebookResource(visibleEditorPane, visibleNotebookEditor);
			if (visibleNotebookEditor && (!visibleNotebookResource || isEqual(visibleNotebookResource, resource))) {
				if (!seenEditorIds.has(visibleNotebookEditor.getId())) {
					seenEditorIds.add(visibleNotebookEditor.getId());
					result.push(visibleNotebookEditor);
				}
				continue;
			}

			if (visibleNotebookResource && isEqual(visibleNotebookResource, resource)) {
				for (const candidate of this._notebookEditorService.listNotebookEditors()) {
					if (!candidate.textModel || !isEqual(candidate.textModel.uri, resource) || seenEditorIds.has(candidate.getId())) {
						continue;
					}

					seenEditorIds.add(candidate.getId());
					result.push(candidate);
				}
			}
		}

		return result;
	}

	private _getNotebookResource(editorPane: IEditorPane | undefined, notebookEditor: INotebookEditor | undefined): URI | undefined {
		if (notebookEditor?.textModel) {
			return notebookEditor.textModel.uri;
		}

		if (editorPane?.input) {
			return EditorResourceAccessor.getCanonicalUri(editorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY });
		}

		return undefined;
	}

	private _getVisibleNotebookEditorPane(notebookEditor: INotebookEditor): IEditorPane | undefined {
		return this._getVisibleNotebookEditorAssignments().find(({ notebookEditor: visibleNotebookEditor }) =>
			visibleNotebookEditor.getId() === notebookEditor.getId()
		)?.editorPane;
	}

	private _getNotebookEditorFromPaneOrResource(editorPane: IEditorPane | undefined): INotebookEditor | undefined {
		if (!editorPane) {
			return undefined;
		}

		const visibleAssignment = this._getVisibleNotebookEditorAssignments().find(candidate => candidate.editorPane === editorPane);
		if (visibleAssignment) {
			return visibleAssignment.notebookEditor;
		}

		const notebookEditor = getNotebookEditorFromEditorPane(editorPane);
		if (notebookEditor?.hasModel()) {
			return notebookEditor;
		}

		if (!editorPane.input) {
			return undefined;
		}

		const resource = EditorResourceAccessor.getCanonicalUri(editorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (!resource) {
			return undefined;
		}

		return this._notebookEditorService.listNotebookEditors().find(candidate =>
			candidate.textModel && isEqual(candidate.textModel.uri, resource)
		);
	}

	private _getVisibleNotebookEditorAssignments(): Array<{ editorPane: IEditorPane; notebookEditor: INotebookEditor }> {
		const result: Array<{ editorPane: IEditorPane; notebookEditor: INotebookEditor }> = [];
		const usedEditorIds = new Set<string>();

		for (const editorPane of this._editorService.visibleEditorPanes) {
			let notebookEditor = getNotebookEditorFromEditorPane(editorPane);
			if (!notebookEditor?.hasModel() || usedEditorIds.has(notebookEditor.getId())) {
				const resource = editorPane.input
					? EditorResourceAccessor.getCanonicalUri(editorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY })
					: undefined;
				if (resource) {
					notebookEditor = this._notebookEditorService.listNotebookEditors().find(candidate =>
						candidate.hasModel()
						&& !!candidate.textModel
						&& isEqual(candidate.textModel.uri, resource)
						&& !usedEditorIds.has(candidate.getId())
					);
				}
			}

			if (!notebookEditor?.hasModel()) {
				continue;
			}

			usedEditorIds.add(notebookEditor.getId());
			result.push({ editorPane, notebookEditor });
		}

		return result;
	}

	private _isInTargetGroup(editorPane: IEditorPane, targetGroup: IEditorGroup | number): boolean {
		if (typeof targetGroup === 'number') {
			return editorPane.group.id === targetGroup;
		}

		return editorPane.group === targetGroup || editorPane.group.id === targetGroup.id;
	}

	private async _waitForNextGroupAdd(): Promise<void> {
		let resolved = false;
		let resolvePromise: (() => void) | undefined;
		const eventPromise = new Promise<void>(resolve => {
			resolvePromise = resolve;
		});
		const listener = this._editorGroupService.onDidAddGroup(() => {
			if (!resolved) {
				resolved = true;
				listener.dispose();
				resolvePromise?.();
			}
		});

		await Promise.race([eventPromise, timeout(MainThreadNotebookEditors._groupSettleTimeout)]);

		if (!resolved) {
			resolved = true;
			listener.dispose();
		}
	}

	private async _ensureActiveTextEditorMirror(resource: URI, notebookEditor: INotebookEditor): Promise<void> {
		for (let attempt = 0; attempt < 40; attempt++) {
			const activeCodeEditor = getCodeEditor(this._editorService.activeTextEditorControl)
				?? notebookEditor.activeCodeEditor
				?? notebookEditor.activeCellAndCodeEditor?.[1]
				?? notebookEditor.codeEditors[0]?.[1];
			const activeModel = activeCodeEditor?.getModel();
			if (activeCodeEditor && activeModel) {
				const activeNotebook = parseNotebookCellUri(activeModel.uri)?.notebook;
				if (isEqual(activeModel.uri, resource) || (activeNotebook && isEqual(activeNotebook, resource))) {
					activeCodeEditor.focus();
					getMainThreadEditorLocator()?.ensureTextEditorForCodeEditor(activeCodeEditor);
					await this._commandService.executeCommand('_workbench.ensureActiveTextEditorMirror');

					const mirroredCodeEditor = getCodeEditor(this._editorService.activeTextEditorControl);
					const mirroredModel = mirroredCodeEditor?.getModel();
					const mirroredNotebook = mirroredModel ? parseNotebookCellUri(mirroredModel.uri)?.notebook : undefined;
					if (mirroredModel && (isEqual(mirroredModel.uri, resource) || (mirroredNotebook && isEqual(mirroredNotebook, resource)))) {
						return;
					}
				}
			}

			await timeout(50);
		}
	}

	private async _ensureNotebookCellEditorFocus(notebookEditor: INotebookEditor): Promise<void> {
		const focusRange = notebookEditor.getSelections()[0] ?? notebookEditor.getFocus();
		const cell = notebookEditor.getActiveCell() ?? notebookEditor.cellAt(focusRange.start);
		if (!cell) {
			return;
		}

		for (let attempt = 0; attempt < 40; attempt++) {
			const activeCodeEditor = notebookEditor.activeCodeEditor
				?? notebookEditor.activeCellAndCodeEditor?.[1]
				?? notebookEditor.codeEditors.find(([candidate]) => candidate === cell)?.[1]
				?? notebookEditor.codeEditors[0]?.[1];
			const activeModel = activeCodeEditor?.getModel();
			const activeNotebook = activeModel ? parseNotebookCellUri(activeModel.uri)?.notebook : undefined;
			if (activeCodeEditor && activeModel && (isEqual(activeModel.uri, cell.uri) || (activeNotebook && notebookEditor.textModel && isEqual(activeNotebook, notebookEditor.textModel.uri)))) {
				activeCodeEditor.focus();
				return;
			}

			notebookEditor.focus();
			await notebookEditor.focusNotebookCell(cell, 'editor', { skipReveal: attempt > 0 });
			await timeout(50);
		}
	}

	private async _withTauriNotebookStageTimeout<T>(label: string, promise: Promise<T>, getState: () => string, timeoutMs = 15000): Promise<T> {
		if (!isTauriIntegration) {
			return promise;
		}

		let handle: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<T>((_, reject) => {
					handle = setTimeout(() => reject(new Error([
						`Tauri notebook stage timed out: ${label}`,
						getState()
					].join('\n'))), timeoutMs);
				})
			]);
		} finally {
			if (handle) {
				clearTimeout(handle);
			}
		}
	}

	async $tryRevealRange(id: string, range: ICellRange, revealType: NotebookEditorRevealType): Promise<void> {
		const editor = this._notebookEditorService.getNotebookEditor(id);
		if (!editor) {
			return;
		}
		const notebookEditor = editor;
		if (!notebookEditor.hasModel()) {
			return;
		}

		if (range.start >= notebookEditor.getLength()) {
			return;
		}

		const cell = notebookEditor.cellAt(range.start);

		switch (revealType) {
			case NotebookEditorRevealType.Default:
				return notebookEditor.revealCellRangeInView(range);
			case NotebookEditorRevealType.InCenter:
				return notebookEditor.revealInCenter(cell);
			case NotebookEditorRevealType.InCenterIfOutsideViewport:
				return notebookEditor.revealInCenterIfOutsideViewport(cell);
			case NotebookEditorRevealType.AtTop:
				return notebookEditor.revealInViewAtTop(cell);
		}
	}

	$trySetSelections(id: string, ranges: ICellRange[]): void {
		const editor = this._notebookEditorService.getNotebookEditor(id);
		if (!editor) {
			return;
		}

		editor.setSelections(ranges);

		if (ranges.length) {
			editor.setFocus({ start: ranges[0].start, end: ranges[0].start + 1 });
		}
	}
}
