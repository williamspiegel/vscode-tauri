/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ExtHostDocuments } from '../../common/extHostDocuments.js';
import { ExtHostDocumentsAndEditors } from '../../common/extHostDocumentsAndEditors.js';
import { SingleProxyRPCProtocol, TestRPCProtocol } from '../common/testRPCProtocol.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('ExtHostDocumentsAndEditors', () => {

	let editors: ExtHostDocumentsAndEditors;

	setup(function () {
		editors = new ExtHostDocumentsAndEditors(new TestRPCProtocol(), new NullLogService());
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('The value of TextDocument.isClosed is incorrect when a text document is closed, #27949', () => {

		editors.$acceptDocumentsAndEditorsDelta({
			addedDocuments: [{
				EOL: '\n',
				isDirty: true,
				languageId: 'fooLang',
				uri: URI.parse('foo:bar'),
				versionId: 1,
				lines: [
					'first',
					'second'
				],
				encoding: 'utf8'
			}]
		});

		return new Promise((resolve, reject) => {

			const d = editors.onDidRemoveDocuments(e => {
				try {

					for (const data of e) {
						assert.strictEqual(data.document.isClosed, true);
					}
					resolve(undefined);
				} catch (e) {
					reject(e);
				} finally {
					d.dispose();
				}
			});

			editors.$acceptDocumentsAndEditorsDelta({
				removedDocuments: [URI.parse('foo:bar')]
			});

		});
	});

	test('waits for document add after open resolves', async () => {
		const resource = URI.parse('test:/file.txt');
		const rpc = SingleProxyRPCProtocol({
			$tryOpenDocument: async () => resource
		});
		const documentsAndEditors = new ExtHostDocumentsAndEditors(rpc, new NullLogService());
		const documents = new ExtHostDocuments(rpc, documentsAndEditors);

		try {
			const documentPromise = documents.ensureDocumentData(resource);
			await Promise.resolve();

			documentsAndEditors.$acceptDocumentsAndEditorsDelta({
				addedDocuments: [{
					isDirty: false,
					languageId: 'plaintext',
					uri: resource,
					versionId: 1,
					lines: ['hello'],
					EOL: '\n',
					encoding: 'utf8'
				}]
			});

			const document = await documentPromise;
			assert.strictEqual(document.document.uri.toString(), resource.toString());
			assert.strictEqual(document.document.getText(), 'hello');
		} finally {
			documents.dispose();
		}
	});

	test('clears stale active editor when the active editor is removed without replacement', () => {
		const resource = URI.parse('test:/file.txt');
		const seen: (string | undefined)[] = [];
		const listener = editors.onDidChangeActiveTextEditor(editor => seen.push(editor?.document.uri.toString()));

		try {
			editors.$acceptDocumentsAndEditorsDelta({
				addedDocuments: [{
					isDirty: false,
					languageId: 'plaintext',
					uri: resource,
					versionId: 1,
					lines: ['hello'],
					EOL: '\n',
					encoding: 'utf8'
				}],
				addedEditors: [{
					id: 'editor-1',
					documentUri: resource,
					selections: [],
					options: { tabSize: 4, indentSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 },
					visibleRanges: [],
					editorPosition: 1
				}],
				newActiveEditor: 'editor-1'
			});

			assert.strictEqual(editors.activeEditor()?.document.uri.toString(), resource.toString());

			editors.$acceptDocumentsAndEditorsDelta({
				removedEditors: ['editor-1']
			});

			assert.strictEqual(editors.activeEditor(), undefined);
			assert.deepStrictEqual(seen, [resource.toString(), undefined]);
		} finally {
			listener.dispose();
		}
	});

	test('does not expose the sole visible editor when active editor becomes null', () => {
		const resource = URI.parse('test:/file.txt');

		editors.$acceptDocumentsAndEditorsDelta({
			addedDocuments: [{
				isDirty: false,
				languageId: 'plaintext',
				uri: resource,
				versionId: 1,
				lines: ['hello'],
				EOL: '\n',
				encoding: 'utf8'
			}],
			addedEditors: [{
				id: 'editor-1',
				documentUri: resource,
				selections: [],
				options: { tabSize: 4, indentSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 },
				visibleRanges: [],
				editorPosition: 1
			}],
			newActiveEditor: 'editor-1'
		});

		assert.strictEqual(editors.activeEditor()?.document.uri.toString(), resource.toString());

		editors.$acceptDocumentsAndEditorsDelta({
			newActiveEditor: null
		});

		assert.strictEqual(editors.activeEditor(), undefined);
		assert.strictEqual(editors.activeEditor(true), undefined);
	});

});
