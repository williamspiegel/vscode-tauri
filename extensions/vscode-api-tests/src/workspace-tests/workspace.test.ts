/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { join } from 'path';
import * as vscode from 'vscode';
import { closeAllEditors, pathEquals } from '../utils';

const expectedWorkspaceRoot = process.env['VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT'] || join(__dirname, '../../testWorkspace');
const expectedWorkspaceRoot2 = process.env['VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT_2'] || join(__dirname, '../../testWorkspace2');
const expectedWorkspaceFile = process.env['VSCODE_TAURI_EXPECTED_WORKSPACE_FILE'] || join(__dirname, '../../testworkspace.code-workspace');

suite('vscode API - workspace', () => {

	teardown(closeAllEditors);

	test('rootPath', () => {
		assert.ok(pathEquals(vscode.workspace.rootPath!, expectedWorkspaceRoot));
	});

	test('workspaceFile', () => {
		assert.ok(pathEquals(vscode.workspace.workspaceFile!.fsPath, expectedWorkspaceFile));
	});

	test('workspaceFolders', () => {
		assert.strictEqual(vscode.workspace.workspaceFolders!.length, 2);
		assert.ok(pathEquals(vscode.workspace.workspaceFolders![0].uri.fsPath, expectedWorkspaceRoot));
		assert.ok(pathEquals(vscode.workspace.workspaceFolders![1].uri.fsPath, expectedWorkspaceRoot2));
		assert.ok(pathEquals(vscode.workspace.workspaceFolders![1].name, 'Test Workspace 2'));
	});

	test('getWorkspaceFolder', () => {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(join(expectedWorkspaceRoot2, 'far.js')));
		assert.ok(!!folder);

		if (folder) {
			assert.ok(pathEquals(folder.uri.fsPath, expectedWorkspaceRoot2));
		}
	});
});
