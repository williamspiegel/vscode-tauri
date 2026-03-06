/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import 'mocha';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { asPromise, assertNoRpc, closeAllEditors, createRandomFile, DeferredPromise, disposeAll, poll, revertAllDirty, saveAllEditors } from '../utils';

const skipNotebookKernelSuiteForTauri =
	vscode.env.uiKind === vscode.UIKind.Web;
const isTauriIntegration =
	process.env.VSCODE_TAURI_INTEGRATION === '1';

async function createRandomNotebookFile() {
	return createRandomFile('', undefined, '.vsctestnb');
}

async function openRandomNotebookDocument() {
	const uri = await createRandomNotebookFile();
	if (isTauriIntegration) {
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await vscode.workspace.openNotebookDocument(uri);
			} catch (error) {
				lastError = error;
				await sleep(100);
			}
		}
		throw lastError instanceof Error ? lastError : new Error(`Failed to open notebook document: ${uri.toString()}`);
	}
	return vscode.workspace.openNotebookDocument(uri);
}

export async function saveAllFilesAndCloseAll() {
	await saveAllEditors();
	await closeAllEditors();
}

async function withEvent<T>(event: vscode.Event<T>, callback: (e: Promise<T>) => Promise<void>) {
	const e = asPromise<T>(event);
	await callback(e);
}

async function showNotebook(notebook: vscode.NotebookDocument): Promise<vscode.NotebookEditor> {
	if (!isTauriIntegration) {
		return vscode.window.showNotebookDocument(notebook);
	}

	const openPromise = vscode.commands.executeCommand('vscode.openWith', notebook.uri, notebook.notebookType);
	void Promise.resolve(openPromise).catch(() => undefined);

	const immediateEditor = await Promise.race<vscode.NotebookEditor | undefined>([
		Promise.resolve(openPromise).then(() => vscode.window.visibleNotebookEditors.find(editor => editor.notebook.uri.toString() === notebook.uri.toString()), () => undefined),
		new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1500))
	]);
	if (immediateEditor) {
		return immediateEditor;
	}

	return poll(
		() => {
			const matchingEditor = vscode.window.visibleNotebookEditors.find(editor => editor.notebook.uri.toString() === notebook.uri.toString());
			if (matchingEditor) {
				return Promise.resolve(matchingEditor);
			}

			if (vscode.window.activeNotebookEditor?.notebook.uri.toString() === notebook.uri.toString()) {
				return Promise.resolve(vscode.window.activeNotebookEditor);
			}

			throw new Error(`Notebook editor for ${notebook.uri.toString()} not visible yet`);
		},
		(editor): editor is vscode.NotebookEditor => !!editor,
		'Notebook editor should become visible in Tauri integration',
		120,
		50
	);
}

async function executeNotebook(notebook: vscode.NotebookDocument): Promise<void> {
	if (isTauriIntegration) {
		await vscode.commands.executeCommand('notebook.execute', notebook.uri);
		return;
	}

	await vscode.commands.executeCommand('notebook.execute');
}

async function executeFirstCell(notebook: vscode.NotebookDocument): Promise<void> {
	if (isTauriIntegration) {
		await vscode.commands.executeCommand('notebook.cell.execute', { start: 0, end: 1 }, notebook.uri);
		return;
	}

	await vscode.commands.executeCommand('notebook.cell.execute');
}

async function waitForOutputCount(cell: vscode.NotebookCell, outputCount: number): Promise<void> {
	if (!isTauriIntegration) {
		return;
	}

	await poll(
		() => Promise.resolve(cell.outputs.length),
		value => value === outputCount,
		`Notebook cell output count should become ${outputCount} in Tauri integration`,
		120,
		50
	);
}

async function clearCellOutputsDetached(notebook: vscode.NotebookDocument, cellIndex: number): Promise<void> {
	const existingCell = notebook.cellAt(cellIndex);
	const replacementCell = new vscode.NotebookCellData(
		existingCell.kind,
		existingCell.document.getText(),
		existingCell.document.languageId
	);
	replacementCell.outputs = [];
	replacementCell.metadata = existingCell.metadata;

	const edit = new vscode.WorkspaceEdit();
	edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cellIndex, cellIndex + 1), [replacementCell])]);
	await vscode.workspace.applyEdit(edit);
}


function sleep(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

export class Kernel {

	readonly controller: vscode.NotebookController;

	readonly associatedNotebooks = new Set<string>();

	constructor(id: string, label: string, viewType: string = 'notebookCoreTest') {
		this.controller = vscode.notebooks.createNotebookController(id, viewType, label);
		this.controller.executeHandler = this._execute.bind(this);
		this.controller.supportsExecutionOrder = true;
		this.controller.supportedLanguages = ['typescript', 'javascript'];
		this.controller.onDidChangeSelectedNotebooks(e => {
			if (e.selected) {
				this.associatedNotebooks.add(e.notebook.uri.toString());
			} else {
				this.associatedNotebooks.delete(e.notebook.uri.toString());
			}
		});
	}

	protected async _execute(cells: vscode.NotebookCell[]): Promise<void> {
		for (const cell of cells) {
			await this._runCell(cell);
		}
	}

	protected async _runCell(cell: vscode.NotebookCell) {
		// create a single output with exec order 1 and output is plain/text
		// of either the cell itself or (iff empty) the cell's document's uri
		const task = this.controller.createNotebookCellExecution(cell);
		task.start(Date.now());
		task.executionOrder = 1;
		await sleep(10); // Force to be take some time
		await task.replaceOutput([new vscode.NotebookCellOutput([
			vscode.NotebookCellOutputItem.text(cell.document.getText() || cell.document.uri.toString(), 'text/plain')
		])]);
		task.end(true);
	}
}


async function assertKernel(kernel: Kernel, notebook: vscode.NotebookDocument): Promise<void> {
	const notebookUri = notebook.uri.toString();
	if (isTauriIntegration) {
		kernel.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
		await sleep(50);
		return;
	}

	let success = false;
	for (let attempt = 0; attempt < 200; attempt++) {
		const commandArg: { extension: string; id: string; notebookEditor?: vscode.NotebookEditor } = {
			extension: 'vscode.vscode-api-tests',
			id: kernel.controller.id
		};

		const targetEditor = vscode.window.visibleNotebookEditors.find(editor => editor.notebook.uri.toString() === notebookUri);
		if (targetEditor) {
			commandArg.notebookEditor = targetEditor;
		}

		success = await vscode.commands.executeCommand('notebook.selectKernel', commandArg);
		if (success && kernel.associatedNotebooks.has(notebookUri)) {
			return;
		}

		await sleep(50);
	}

	assert.ok(success, `expected selected kernel to be ${kernel.controller.id}`);
	assert.ok(kernel.associatedNotebooks.has(notebookUri), `kernel ${kernel.controller.id} should be associated with ${notebookUri}`);
}

const apiTestSerializer: vscode.NotebookSerializer = {
	serializeNotebook(_data, _token) {
		return new Uint8Array();
	},
	deserializeNotebook(_content, _token) {
		const dto: vscode.NotebookData = {
			metadata: { testMetadata: false },
			cells: [
				{
					value: 'test',
					languageId: 'typescript',
					kind: vscode.NotebookCellKind.Code,
					outputs: [],
					metadata: { testCellMetadata: 123 },
					executionSummary: { timing: { startTime: 10, endTime: 20 } }
				},
				{
					value: 'test2',
					languageId: 'typescript',
					kind: vscode.NotebookCellKind.Code,
					outputs: [
						new vscode.NotebookCellOutput([
							vscode.NotebookCellOutputItem.text('Hello World', 'text/plain')
						],
							{
								testOutputMetadata: true,
								['text/plain']: { testOutputItemMetadata: true }
							})
					],
					executionSummary: { executionOrder: 5, success: true },
					metadata: { testCellMetadata: 456 }
				}
			]
		};
		return dto;
	}
};

(skipNotebookKernelSuiteForTauri ? suite.skip : suite)('Notebook Kernel API tests', function () {

	const testDisposables: vscode.Disposable[] = [];
	const suiteDisposables: vscode.Disposable[] = [];

	suiteTeardown(async function () {

		assertNoRpc();

		await revertAllDirty();
		await closeAllEditors();

		disposeAll(suiteDisposables);
		suiteDisposables.length = 0;
	});

	suiteSetup(() => {
		suiteDisposables.push(vscode.workspace.registerNotebookSerializer('notebookCoreTest', apiTestSerializer));
	});

	let defaultKernel: Kernel;

	setup(async function () {
		// there should be ONE default kernel in this suite
		defaultKernel = new Kernel('mainKernel', 'Notebook Default Kernel');
		testDisposables.push(defaultKernel.controller);
		await saveAllFilesAndCloseAll();
	});

	teardown(async function () {
		disposeAll(testDisposables);
		testDisposables.length = 0;
		await saveAllFilesAndCloseAll();
	});

	test('cell execute command takes arguments', async () => {
		const notebook = await openRandomNotebookDocument();
		if (!isTauriIntegration) {
			await showNotebook(notebook);
		}
		if (!isTauriIntegration) {
			assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		}
		let cell = notebook.cellAt(0);
		if (isTauriIntegration) {
			await assertKernel(defaultKernel, notebook);
		}

		if (isTauriIntegration) {
			await executeNotebook(notebook);
			await waitForOutputCount(cell, 1);
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
		} else {
			await withEvent(vscode.workspace.onDidChangeNotebookDocument, async event => {
				await executeNotebook(notebook);
				await event;
				assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			});
		}

		if (isTauriIntegration) {
			await clearCellOutputsDetached(notebook, 0);
			cell = notebook.cellAt(0);
			await waitForOutputCount(cell, 0);
			assert.strictEqual(cell.outputs.length, 0, 'should clear');
		} else {
			await withEvent(vscode.workspace.onDidChangeNotebookDocument, async event => {
				await vscode.commands.executeCommand('notebook.cell.clearOutputs');
				await event;
				assert.strictEqual(cell.outputs.length, 0, 'should clear');
			});
		}

		const secondResource = await createRandomNotebookFile();
		const secondDocument = await vscode.workspace.openNotebookDocument(secondResource);
		if (!isTauriIntegration) {
			await showNotebook(secondDocument);
		}

		if (isTauriIntegration) {
			await vscode.commands.executeCommand('notebook.cell.execute', { start: 0, end: 1 }, notebook.uri);
			await waitForOutputCount(cell, 1);
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
		} else {
			await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async event => {
				await vscode.commands.executeCommand('notebook.cell.execute', { start: 0, end: 1 }, notebook.uri);
				await event;
				assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
				assert.strictEqual(vscode.window.activeNotebookEditor?.notebook.uri.fsPath, secondResource.fsPath);
			});
		}
	});

	test('cell execute command takes arguments 2', async () => {
		const notebook = await openRandomNotebookDocument();
		if (!isTauriIntegration) {
			await showNotebook(notebook);
		}
		if (isTauriIntegration) {
			await assertKernel(defaultKernel, notebook);
		}

		let firstCellExecuted = false;
		let secondCellExecuted = false;

		const def = new DeferredPromise<void>();
		testDisposables.push(vscode.workspace.onDidChangeNotebookDocument(e => {
			e.cellChanges.forEach(change => {
				if (change.cell.index === 0 && change.executionSummary) {
					firstCellExecuted = true;
				}

				if (change.cell.index === 1 && change.executionSummary) {
					secondCellExecuted = true;
				}
			});

			if (firstCellExecuted && secondCellExecuted) {
				def.complete();
			}
		}));

		await vscode.commands.executeCommand('notebook.cell.execute', { document: notebook.uri, ranges: [{ start: 0, end: 1 }, { start: 1, end: 2 }] });

		await def.p;
		await saveAllFilesAndCloseAll();
	});

	test('document execute command takes arguments', async () => {
		const notebook = await openRandomNotebookDocument();
		if (!isTauriIntegration) {
			await showNotebook(notebook);
		}
		if (isTauriIntegration) {
			await assertKernel(defaultKernel, notebook);
		}
		if (!isTauriIntegration) {
			assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		}
		const cell = notebook.cellAt(0);
		
		if (isTauriIntegration) {
			await vscode.commands.executeCommand('notebook.execute', notebook.uri);
			await waitForOutputCount(cell, 1);
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
		} else {
			await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
				await vscode.commands.executeCommand('notebook.execute', notebook.uri);
				await event;
				assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			});
		}
	});

	test('cell execute and select kernel', async function () {
		const notebook = await openRandomNotebookDocument();
		if (!isTauriIntegration) {
			const editor = await showNotebook(notebook);
			assert.strictEqual(vscode.window.activeNotebookEditor === editor, true, 'notebook first');
		}

		const cell = notebook.cellAt(0);

		const alternativeKernel = new class extends Kernel {
			constructor() {
				super('secondaryKernel', 'Notebook Secondary Test Kernel');
				this.controller.supportsExecutionOrder = false;
			}

			override async _runCell(cell: vscode.NotebookCell) {
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my second output', 'text/plain')
				])]);
				task.end(true);
			}
		};
		testDisposables.push(alternativeKernel.controller);

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await assertKernel(defaultKernel, notebook);
			await executeFirstCell(notebook);
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(cell.outputs[0].items.length, 1);
			assert.strictEqual(cell.outputs[0].items[0].mime, 'text/plain');
			assert.deepStrictEqual(new TextDecoder().decode(cell.outputs[0].items[0].data), cell.document.getText());
		});

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await assertKernel(alternativeKernel, notebook);
			await executeFirstCell(notebook);
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(cell.outputs[0].items.length, 1);
			assert.strictEqual(cell.outputs[0].items[0].mime, 'text/plain');
			assert.deepStrictEqual(new TextDecoder().decode(cell.outputs[0].items[0].data), 'my second output');
		});
	});

	test('Output changes are applied once the promise resolves', async function () {

		let called = false;

		const verifyOutputSyncKernel = new class extends Kernel {

			constructor() {
				super('verifyOutputSyncKernel', '');
			}

			override async _execute(cells: vscode.NotebookCell[]) {
				const [cell] = cells;
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('Some output', 'text/plain')
				])]);
				assert.strictEqual(cell.notebook.cellAt(0).outputs.length, 1);
				assert.deepStrictEqual(new TextDecoder().decode(cell.notebook.cellAt(0).outputs[0].items[0].data), 'Some output');
				task.end(undefined);
				called = true;
			}
		};

		const notebook = await openRandomNotebookDocument();
		if (!isTauriIntegration) {
			await showNotebook(notebook);
		}
		await assertKernel(verifyOutputSyncKernel, notebook);
		await executeFirstCell(notebook);
		assert.strictEqual(called, true);
		verifyOutputSyncKernel.controller.dispose();
	});

	test('executionSummary', async () => {
		const notebook = await openRandomNotebookDocument();
		if (!isTauriIntegration) {
			await showNotebook(notebook);
		}
		const cell = notebook.cellAt(0);
		if (isTauriIntegration) {
			await assertKernel(defaultKernel, notebook);
		}

		assert.strictEqual(cell.executionSummary?.success, undefined);
		assert.strictEqual(cell.executionSummary?.executionOrder, undefined);
		await executeFirstCell(notebook);
		assert.strictEqual(cell.outputs.length, 1, 'should execute');
		assert.ok(cell.executionSummary);
		assert.strictEqual(cell.executionSummary!.success, true);
		assert.strictEqual(typeof cell.executionSummary!.executionOrder, 'number');
	});

	test('initialize executionSummary', async () => {

		const document = await openRandomNotebookDocument();
		const cell = document.cellAt(0);

		assert.strictEqual(cell.executionSummary?.success, undefined);
		assert.strictEqual(cell.executionSummary?.timing?.startTime, 10);
		assert.strictEqual(cell.executionSummary?.timing?.endTime, 20);

	});

	test('execution cancelled when delete while executing', async () => {
		const document = await openRandomNotebookDocument();
		const cell = document.cellAt(0);

		let executionWasCancelled = false;
		const cancelledKernel = new class extends Kernel {
			constructor() {
				super('cancelledKernel', '');
			}

			override async _execute(cells: vscode.NotebookCell[]) {
				const [cell] = cells;
				const exe = this.controller.createNotebookCellExecution(cell);
				exe.token.onCancellationRequested(() => executionWasCancelled = true);
			}
		};
		testDisposables.push(cancelledKernel.controller);

		if (!isTauriIntegration) {
			await showNotebook(document);
		}
		await assertKernel(cancelledKernel, document);
		await executeFirstCell(document);

		// Delete executing cell
		const edit = new vscode.WorkspaceEdit();
		edit.set(cell!.notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cell!.index, cell!.index + 1), [])]);
		await vscode.workspace.applyEdit(edit);

		assert.strictEqual(executionWasCancelled, true);
	});

	test('appendOutput to different cell', async function () {
		const notebook = await openRandomNotebookDocument();
		if (!isTauriIntegration) {
			await showNotebook(notebook);
		}
		const cell0 = notebook.cellAt(0);
		const notebookEdit = new vscode.NotebookEdit(new vscode.NotebookRange(1, 1), [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'test 2', 'javascript')]);
		const edit = new vscode.WorkspaceEdit();
		edit.set(notebook.uri, [notebookEdit]);
		await vscode.workspace.applyEdit(edit);
		const cell1 = notebook.cellAt(1);

		const nextCellKernel = new class extends Kernel {
			constructor() {
				super('nextCellKernel', 'Append to cell kernel');
			}

			override async _runCell(cell: vscode.NotebookCell) {
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.appendOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my output')
				])], cell1);
				await task.appendOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my output 2')
				])], cell1);
				task.end(true);
			}
		};
		testDisposables.push(nextCellKernel.controller);

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await assertKernel(nextCellKernel, notebook);
			await executeFirstCell(notebook);
			await event;
			assert.strictEqual(cell0.outputs.length, 0, 'should not change cell 0');
			assert.strictEqual(cell1.outputs.length, 2, 'should update cell 1');
			assert.strictEqual(cell1.outputs[0].items.length, 1);
			assert.deepStrictEqual(new TextDecoder().decode(cell1.outputs[0].items[0].data), 'my output');
		});
	});

	test('replaceOutput to different cell', async function () {
		const notebook = await openRandomNotebookDocument();
		if (!isTauriIntegration) {
			await showNotebook(notebook);
		}
		const cell0 = notebook.cellAt(0);
		const notebookEdit = new vscode.NotebookEdit(new vscode.NotebookRange(1, 1), [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'test 2', 'javascript')]);
		const edit = new vscode.WorkspaceEdit();
		edit.set(notebook.uri, [notebookEdit]);
		await vscode.workspace.applyEdit(edit);
		const cell1 = notebook.cellAt(1);

		const nextCellKernel = new class extends Kernel {
			constructor() {
				super('nextCellKernel', 'Replace to cell kernel');
			}

			override async _runCell(cell: vscode.NotebookCell) {
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my output')
				])], cell1);
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my output 2')
				])], cell1);
				task.end(true);
			}
		};
		testDisposables.push(nextCellKernel.controller);

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await assertKernel(nextCellKernel, notebook);
			await executeFirstCell(notebook);
			await event;
			assert.strictEqual(cell0.outputs.length, 0, 'should not change cell 0');
			assert.strictEqual(cell1.outputs.length, 1, 'should update cell 1');
			assert.strictEqual(cell1.outputs[0].items.length, 1);
			assert.deepStrictEqual(new TextDecoder().decode(cell1.outputs[0].items[0].data), 'my output 2');
		});
	});
});
