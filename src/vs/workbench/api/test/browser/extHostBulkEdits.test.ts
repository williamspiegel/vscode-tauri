/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import * as extHostTypes from '../../common/extHostTypes.js';
import { MainContext, IWorkspaceEditDto, MainThreadBulkEditsShape, IWorkspaceTextEditDto } from '../../common/extHost.protocol.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ExtHostDocumentsAndEditors } from '../../common/extHostDocumentsAndEditors.js';
import { SingleProxyRPCProtocol, TestRPCProtocol } from '../common/testRPCProtocol.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { ExtHostBulkEdits } from '../../common/extHostBulkEdits.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { SerializableObjectWithBuffers } from '../../../services/extensions/common/proxyIdentifier.js';
import { ExtHostDocuments } from '../../common/extHostDocuments.js';

suite('ExtHostBulkEdits.applyWorkspaceEdit', () => {

	const resource = URI.parse('foo:bar');
	let bulkEdits: ExtHostBulkEdits;
	let workspaceResourceEdits: IWorkspaceEditDto;
	let documentsAndEditors: ExtHostDocumentsAndEditors;
	let documents: ExtHostDocuments;

	setup(() => {
		workspaceResourceEdits = null!;
		documentsAndEditors = new ExtHostDocumentsAndEditors(SingleProxyRPCProtocol(null), new NullLogService());
		documents = new ExtHostDocuments(SingleProxyRPCProtocol(null), documentsAndEditors);
		const rpcProtocol = new TestRPCProtocol();
		rpcProtocol.set(MainContext.MainThreadBulkEdits, new class extends mock<MainThreadBulkEditsShape>() {
			override $tryApplyWorkspaceEdit(_workspaceResourceEdits: SerializableObjectWithBuffers<IWorkspaceEditDto>): Promise<boolean> {
				workspaceResourceEdits = _workspaceResourceEdits.value;
				return Promise.resolve(true);
			}
		});
		documentsAndEditors.$acceptDocumentsAndEditorsDelta({
			addedDocuments: [{
				isDirty: false,
				languageId: 'foo',
				uri: resource,
				versionId: 1337,
				lines: ['foo'],
				EOL: '\n',
				encoding: 'utf8'
			}]
		});
		bulkEdits = new ExtHostBulkEdits(rpcProtocol, documentsAndEditors);
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses version id if document available', async () => {
		const edit = new extHostTypes.WorkspaceEdit();
		edit.replace(resource, new extHostTypes.Range(0, 0, 0, 0), 'hello');
		await bulkEdits.applyWorkspaceEdit(edit, nullExtensionDescription, undefined);
		assert.strictEqual(workspaceResourceEdits.edits.length, 1);
		const [first] = workspaceResourceEdits.edits;
		assert.strictEqual((<IWorkspaceTextEditDto>first).versionId, 1337);
	});

	test('does not use version id if document is not available', async () => {
		const rpcProtocol = new TestRPCProtocol();
		rpcProtocol.set(MainContext.MainThreadBulkEdits, new class extends mock<MainThreadBulkEditsShape>() {
			override $tryApplyWorkspaceEdit(_workspaceResourceEdits: SerializableObjectWithBuffers<IWorkspaceEditDto>): Promise<boolean> {
				workspaceResourceEdits = _workspaceResourceEdits.value;
				return Promise.resolve(true);
			}
		});
		bulkEdits = new ExtHostBulkEdits(rpcProtocol, documentsAndEditors);

		const edit = new extHostTypes.WorkspaceEdit();
		edit.replace(URI.parse('foo:bar2'), new extHostTypes.Range(0, 0, 0, 0), 'hello');
		await bulkEdits.applyWorkspaceEdit(edit, nullExtensionDescription, undefined);
		assert.strictEqual(workspaceResourceEdits.edits.length, 1);
		const [first] = workspaceResourceEdits.edits;
		assert.ok(typeof (<IWorkspaceTextEditDto>first).versionId === 'undefined');
	});

	test('waits for ext host document version updates before resolving', async () => {
		const rpcProtocol = new TestRPCProtocol();
		rpcProtocol.set(MainContext.MainThreadBulkEdits, new class extends mock<MainThreadBulkEditsShape>() {
			override async $tryApplyWorkspaceEdit(_workspaceResourceEdits: SerializableObjectWithBuffers<IWorkspaceEditDto>): Promise<boolean> {
				workspaceResourceEdits = _workspaceResourceEdits.value;
				setTimeout(() => {
					documents.$acceptModelChanged(resource, {
						changes: [{
							range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
							rangeOffset: 0,
							rangeLength: 3,
							text: 'hello'
						}],
						isEolChange: false,
						versionId: 1338,
						isUndoing: false,
						isRedoing: false,
						isFlush: false,
						eol: '\n',
						detailedReason: undefined
					}, false);
				}, 10);
				return true;
			}
		});
		bulkEdits = new ExtHostBulkEdits(rpcProtocol, documentsAndEditors);

		const edit = new extHostTypes.WorkspaceEdit();
		edit.replace(resource, new extHostTypes.Range(0, 0, 0, 3), 'hello');

		let resolved = false;
		const promise = bulkEdits.applyWorkspaceEdit(edit, nullExtensionDescription, undefined).then(() => {
			resolved = true;
		});

		await timeout(1);
		assert.strictEqual(resolved, false);

		await promise;
		assert.strictEqual(documentsAndEditors.getDocument(resource)?.version, 1338);
		assert.strictEqual(workspaceResourceEdits.edits.length, 1);
	});

});
