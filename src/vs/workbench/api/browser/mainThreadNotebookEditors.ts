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
import { EditorActivation } from '../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
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
		@IInstantiationService private readonly _instantiationService: IInstantiationService
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
		for (const editorPane of this._editorService.visibleEditorPanes) {
			const candidate = getNotebookEditorFromEditorPane(editorPane);
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
		await editorInput.resolve();
		const editorPane = await this._editorService.openEditor(editorInput, editorOptions, targetGroup);
		if (groupAdd) {
			await groupAdd;
		}
		const resolvedTargetGroup = typeof targetGroup === 'number' && targetGroup < 0
			? targetGroup
			: (editorPane as IEditorPane | undefined)?.group ?? targetGroup;
		const notebookEditor = await this._waitForNotebookEditor(editorPane, revivedResource, resolvedTargetGroup, knownMatchingEditorIds);

		if (notebookEditor) {
			if (!options.preserveFocus) {
				const targetNotebookGroup = this._getVisibleNotebookEditorPane(notebookEditor)?.group ?? resolvedTargetGroup;
				await this._waitForActiveNotebookEditor(notebookEditor.getId(), revivedResource, targetNotebookGroup);
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
		const directNotebookEditor = getNotebookEditorFromEditorPane(editorPane);
		const directPaneResource = candidateEditorPane?.input
			? EditorResourceAccessor.getCanonicalUri(candidateEditorPane.input, { supportSideBySide: SideBySideEditor.PRIMARY })?.toString()
			: undefined;
		const serviceEditors = this._notebookEditorService.listNotebookEditors().map(editor => ({
			id: editor.getId(),
			hasModel: editor.hasModel(),
			resource: editor.textModel?.uri.toString() ?? 'undefined'
		}));
		const visibleEditors = this._editorService.visibleEditorPanes.map(visibleEditorPane => {
			const visibleNotebookEditor = getNotebookEditorFromEditorPane(visibleEditorPane);
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
			const activeNotebookEditor = getNotebookEditorFromEditorPane(activeEditorPane);
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

			await timeout(50);
		}
	}

	private _resolveNotebookEditor(editorPane: unknown, resource: URI, targetGroup: IEditorGroup | number, knownMatchingEditorIds: ReadonlySet<string>): INotebookEditor | undefined {
		const candidateEditorPane = editorPane as IEditorPane | undefined;
		const directNotebookEditor = getNotebookEditorFromEditorPane(editorPane);
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
			const sideGroupNotebookEditors = this._editorService.visibleEditorPanes
				.filter(visibleEditorPane => visibleEditorPane.group !== candidateEditorPane.group)
				.map(visibleEditorPane => getNotebookEditorFromEditorPane(visibleEditorPane))
				.filter((visibleNotebookEditor): visibleNotebookEditor is INotebookEditor =>
					!!visibleNotebookEditor && visibleNotebookEditor.hasModel() && !!visibleNotebookEditor.textModel && isEqual(visibleNotebookEditor.textModel.uri, resource)
				);

			if (sideGroupNotebookEditors.length === 1) {
				return sideGroupNotebookEditors[0];
			}
		}

		for (const visibleEditorPane of this._editorService.visibleEditorPanes) {
			if (!this._isInTargetGroup(visibleEditorPane, targetGroup)) {
				continue;
			}

			const visibleNotebookEditor = getNotebookEditorFromEditorPane(visibleEditorPane);
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
		for (const visibleEditorPane of this._editorService.visibleEditorPanes) {
			if (!this._isInTargetGroup(visibleEditorPane, targetGroup)) {
				continue;
			}

			const visibleNotebookEditor = getNotebookEditorFromEditorPane(visibleEditorPane);
			const visibleNotebookResource = this._getNotebookResource(visibleEditorPane, visibleNotebookEditor);
			if (visibleNotebookEditor && (!visibleNotebookResource || isEqual(visibleNotebookResource, resource))) {
				result.push(visibleNotebookEditor);
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
		return this._editorService.visibleEditorPanes.find(visibleEditorPane => getNotebookEditorFromEditorPane(visibleEditorPane)?.getId() === notebookEditor.getId());
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
