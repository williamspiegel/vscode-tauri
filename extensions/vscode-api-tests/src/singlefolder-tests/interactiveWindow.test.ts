/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import 'mocha';
import * as vscode from 'vscode';
import { asPromise, disposeAll, poll } from '../utils';
import { Kernel, saveAllFilesAndCloseAll } from './notebookTestUtils';

export type INativeInteractiveWindow = { notebookUri: vscode.Uri; inputUri: vscode.Uri; notebookEditor: vscode.NotebookEditor };
const isTauriIntegration = process.env.VSCODE_TAURI_INTEGRATION === '1';

async function createInteractiveWindow(kernel: Kernel) {
	if (isTauriIntegration) {
		const existingInteractiveNotebookUris = new Set(
			vscode.window.visibleNotebookEditors
				.filter(editor => editor.notebook.notebookType === 'interactive')
				.map(editor => editor.notebook.uri.toString())
		);
		const openPromise = vscode.commands.executeCommand(
			'interactive.open',
			// Keep focus on the owning file if there is one
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			undefined,
			`vscode.vscode-api-tests/${kernel.controller.id}`,
			undefined
		) as Thenable<INativeInteractiveWindow>;
		void Promise.resolve(openPromise).catch(() => undefined);

		const openResult = await Promise.race<INativeInteractiveWindow | undefined>([
			openPromise,
			new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 30000))
		]);
		if (openResult?.notebookEditor) {
			return { notebookEditor: openResult.notebookEditor, inputUri: openResult.inputUri };
		}
		const expectedNotebookUri = openResult?.notebookUri?.toString();
		if (openResult?.notebookUri) {
			try {
				const notebookDocument = await Promise.race([
					vscode.workspace.openNotebookDocument(openResult.notebookUri),
					new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5000))
				]);
				if (notebookDocument) {
					const shownEditor = await Promise.race([
						vscode.window.showNotebookDocument(notebookDocument, {
							viewColumn: vscode.ViewColumn.Beside,
							preserveFocus: false
						}),
						new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5000))
					]);
					if (shownEditor) {
						return { notebookEditor: shownEditor, inputUri: openResult.inputUri };
					}
				}
			} catch {
				// Fall through to visibility polling.
			}
		}

		const resolvedNotebookEditor = await poll(
			() => {
				const matchingEditor = vscode.window.visibleNotebookEditors.find(editor =>
					editor.notebook.notebookType === 'interactive'
					&& (
						(expectedNotebookUri && editor.notebook.uri.toString() === expectedNotebookUri)
						|| (!expectedNotebookUri && !existingInteractiveNotebookUris.has(editor.notebook.uri.toString()))
					)
				);
				if (matchingEditor) {
					return Promise.resolve(matchingEditor);
				}

				const activeNotebookEditor = vscode.window.activeNotebookEditor;
				if (activeNotebookEditor
					&& activeNotebookEditor.notebook.notebookType === 'interactive'
					&& (
						(expectedNotebookUri && activeNotebookEditor.notebook.uri.toString() === expectedNotebookUri)
						|| (!expectedNotebookUri && !existingInteractiveNotebookUris.has(activeNotebookEditor.notebook.uri.toString()))
					)) {
					return Promise.resolve(activeNotebookEditor);
				}

				throw new Error('Interactive Window notebook editor not available yet');
			},
			(editor): editor is vscode.NotebookEditor => !!editor,
			'Interactive Window notebook editor should become visible in Tauri integration',
			600,
			50
		);

		return { notebookEditor: resolvedNotebookEditor, inputUri: openResult?.inputUri ?? resolvedNotebookEditor.notebook.uri };
	}

	const { notebookEditor, inputUri } = (await vscode.commands.executeCommand(
		'interactive.open',
		// Keep focus on the owning file if there is one
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
		undefined,
		`vscode.vscode-api-tests/${kernel.controller.id}`,
		undefined
	)) as unknown as INativeInteractiveWindow;
	if (notebookEditor) {
		return { notebookEditor, inputUri };
	}

	assert.ok(notebookEditor, 'Interactive Window was not created successfully');
	return { notebookEditor, inputUri };
}

async function addCell(code: string, notebook: vscode.NotebookDocument) {
	const initialCellCount = notebook.cellCount;
	const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'typescript');
	const edit = vscode.NotebookEdit.insertCells(notebook.cellCount, [cell]);
	const workspaceEdit = new vscode.WorkspaceEdit();
	workspaceEdit.set(notebook.uri, [edit]);
	const event = !isTauriIntegration ? asPromise(vscode.workspace.onDidChangeNotebookDocument) : undefined;
	if (isTauriIntegration) {
		// Tauri can intermittently leave applyEdit unresolved; rely on model-state polling.
		void vscode.workspace.applyEdit(workspaceEdit);
			await poll(
				() => Promise.resolve(notebook.cellCount),
				value => value > initialCellCount,
				'Interactive window inserted cell should become visible in Tauri integration',
				120,
				50
			);
	} else {
		await vscode.workspace.applyEdit(workspaceEdit);
		await event;
	}
	return notebook.cellAt(notebook.cellCount - 1);
}

async function addCellAndRun(code: string, notebook: vscode.NotebookDocument) {
	const initialCellCount = notebook.cellCount;
	const cell = await addCell(code, notebook);

	if (isTauriIntegration) {
		const executePromise = vscode.commands.executeCommand('notebook.cell.execute', { start: initialCellCount, end: initialCellCount + 1 }, notebook.uri);
		await Promise.race([executePromise, new Promise(resolve => setTimeout(resolve, 1000))]);
			await poll(
				() => {
					const result = notebook.cellAt(notebook.cellCount - 1);
				if (result.outputs.length > 0) {
					return Promise.resolve(true);
				}

				throw new Error(`Executed cell has no output yet. Initial Cell count: ${initialCellCount}. Current cell count: ${notebook.cellCount}. execution summary: ${JSON.stringify(result.executionSummary)}`);
				},
				value => value === true,
				'Interactive window cell execution should produce output in Tauri integration',
				120,
				50
			);
	} else {
		const event = asPromise(vscode.workspace.onDidChangeNotebookDocument);
		await vscode.commands.executeCommand('notebook.cell.execute', { start: initialCellCount, end: initialCellCount + 1 }, notebook.uri);
		try {
			await event;
		} catch {
			const result = notebook.cellAt(notebook.cellCount - 1);
			assert.fail(`Notebook change event was not triggered after executing newly added cell. Initial Cell count: ${initialCellCount}. Current cell count: ${notebook.cellCount}. execution summary: ${JSON.stringify(result.executionSummary)}`);
		}
	}
	assert.strictEqual(cell.outputs.length, 1, `Executed cell has no output. Initial Cell count: ${initialCellCount}. Current cell count: ${notebook.cellCount}. execution summary: ${JSON.stringify(cell.executionSummary)}`);
	return cell;
}


(vscode.env.uiKind === vscode.UIKind.Web ? suite.skip : suite)('Interactive Window', function () {

	const testDisposables: vscode.Disposable[] = [];
	let defaultKernel: Kernel;
	let secondKernel: Kernel;

	setup(async function () {
		defaultKernel = new Kernel('mainKernel', 'Notebook Default Kernel', 'interactive');
		secondKernel = new Kernel('secondKernel', 'Notebook Secondary Kernel', 'interactive');
		testDisposables.push(defaultKernel.controller);
		testDisposables.push(secondKernel.controller);
		await saveAllFilesAndCloseAll();
	});

	teardown(async function () {
		disposeAll(testDisposables);
		testDisposables.length = 0;
		await saveAllFilesAndCloseAll();
	});

	test.skip('Can open an interactive window and execute from input box', async () => {
		assert.ok(vscode.workspace.workspaceFolders);
		const { notebookEditor, inputUri } = await createInteractiveWindow(defaultKernel);

		const inputBox = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.path === inputUri.path
		);
		await inputBox!.edit((editBuilder) => {
			editBuilder.insert(new vscode.Position(0, 0), 'print foo');
		});
		await vscode.commands.executeCommand('interactive.execute', notebookEditor.notebook.uri);

		assert.strictEqual(notebookEditor.notebook.cellCount, 1);
		assert.strictEqual(notebookEditor.notebook.cellAt(0).kind, vscode.NotebookCellKind.Code);
	});

	test('Interactive window scrolls after execute', async function () {
		if (isTauriIntegration) {
			this.timeout(240000);
		}

			assert.ok(vscode.workspace.workspaceFolders);
			const { notebookEditor } = await createInteractiveWindow(defaultKernel);

			// Run and add a bunch of cells
			const executionCount = isTauriIntegration ? 6 : 10;
			for (let i = 0; i < executionCount; i++) {
				await addCellAndRun(`print ${i}`, notebookEditor.notebook);
			}

		// Verify visible range has the last cell
		if (!lastCellIsVisible(notebookEditor)) {
			// scroll happens async, so give it some time to scroll
			await new Promise<void>((resolve) => setTimeout(() => {
				assert.ok(lastCellIsVisible(notebookEditor), `Last cell is not visible (${describeNotebookVisibility(notebookEditor)})`);
				resolve();
			}, 1000));
		}
	});

	// https://github.com/microsoft/vscode/issues/266229
	test.skip('Interactive window has the correct kernel', async function () {
		// Extend timeout a bit as kernel association can be async & occasionally slow on CI
		this.timeout(20000);
		assert.ok(vscode.workspace.workspaceFolders);
		await createInteractiveWindow(defaultKernel);

		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

		// Create a new interactive window with a different kernel
		const { notebookEditor } = await createInteractiveWindow(secondKernel);
		assert.ok(notebookEditor);

		// Run a cell to ensure the kernel is actually exercised
		await addCellAndRun(`print`, notebookEditor.notebook);

		await poll(
			() => Promise.resolve(secondKernel.associatedNotebooks.has(notebookEditor.notebook.uri.toString())),
			v => v,
			'Secondary kernel was not set as the kernel for the interactive window'
		);
		assert.strictEqual(secondKernel.associatedNotebooks.has(notebookEditor.notebook.uri.toString()), true, `Secondary kernel was not set as the kernel for the interactive window`);
	});
});

function lastCellIsVisible(notebookEditor: vscode.NotebookEditor) {
	const editorForVisibilityCheck = getNotebookEditorForVisibilityCheck(notebookEditor);

	if (!editorForVisibilityCheck.visibleRanges.length) {
		return false;
	}
	const lastVisibleCell = editorForVisibilityCheck.visibleRanges[editorForVisibilityCheck.visibleRanges.length - 1].end;
	return editorForVisibilityCheck.notebook.cellCount === lastVisibleCell;
}

function getNotebookEditorForVisibilityCheck(notebookEditor: vscode.NotebookEditor): vscode.NotebookEditor {
	return isTauriIntegration
		? vscode.window.visibleNotebookEditors.find(editor => editor.notebook.uri.toString() === notebookEditor.notebook.uri.toString())
			?? (vscode.window.activeNotebookEditor?.notebook.uri.toString() === notebookEditor.notebook.uri.toString() ? vscode.window.activeNotebookEditor : undefined)
			?? notebookEditor
		: notebookEditor;
}

function describeNotebookVisibility(notebookEditor: vscode.NotebookEditor): string {
	const editor = getNotebookEditorForVisibilityCheck(notebookEditor);
	const ranges = editor.visibleRanges.map(range => `[${range.start},${range.end})`).join(',') || 'none';
	return `cellCount=${editor.notebook.cellCount},visibleRanges=${ranges}`;
}
