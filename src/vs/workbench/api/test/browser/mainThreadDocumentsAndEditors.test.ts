/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MainThreadDocumentsAndEditors } from '../../browser/mainThreadDocumentsAndEditors.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { ModelService } from '../../../../editor/common/services/modelService.js';
import { TestCodeEditorService } from '../../../../editor/test/browser/editorTestServices.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IDocumentsAndEditorsDelta } from '../../common/extHost.protocol.js';
import { createTestCodeEditor, ITestCodeEditor } from '../../../../editor/test/browser/testCodeEditor.js';
import { mock } from '../../../../base/test/common/mock.js';
import { TestEditorService, TestEditorGroupsService, TestEnvironmentService, TestPathService } from '../../../test/browser/workbenchTestServices.js';
import { Event } from '../../../../base/common/event.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { UndoRedoService } from '../../../../platform/undoRedo/common/undoRedoService.js';
import { TestDialogService } from '../../../../platform/dialogs/test/common/testDialogService.js';
import { TestNotificationService } from '../../../../platform/notification/test/common/testNotificationService.js';
import { TestTextResourcePropertiesService, TestWorkingCopyFileService } from '../../../test/common/workbenchTestServices.js';
import { UriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { LanguageService } from '../../../../editor/common/services/languageService.js';
import { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import { TestLanguageConfigurationService } from '../../../../editor/test/common/modes/testLanguageConfigurationService.js';
import { IUndoRedoService } from '../../../../platform/undoRedo/common/undoRedo.js';
import { IQuickDiffModelService } from '../../../contrib/scm/browser/quickDiffModel.js';
import { IEditorPane } from '../../../common/editor.js';
import { ITextEditorDiffInformation } from '../../../../platform/editor/common/editor.js';
import { ITreeSitterLibraryService } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { TestTreeSitterLibraryService } from '../../../../editor/test/common/services/testTreeSitterLibraryService.js';
import { createTextModel } from '../../../../editor/test/common/testTextModel.js';

suite('MainThreadDocumentsAndEditors', () => {

	let disposables: DisposableStore;

	let modelService: ModelService;
	let codeEditorService: TestCodeEditorService;
	let textFileService: ITextFileService;
	let workbenchEditorService: TestEditorService;
	const deltas: IDocumentsAndEditorsDelta[] = [];

	function myCreateTestCodeEditor(model: ITextModel | undefined): ITestCodeEditor {
		return createTestCodeEditor(model, {
			hasTextFocus: false,
			serviceCollection: new ServiceCollection(
				[ICodeEditorService, codeEditorService]
			)
		});
	}

	function createMainThreadDocumentsAndEditors(): MainThreadDocumentsAndEditors {
		const editorGroupService = new TestEditorGroupsService();

		const fileService = new class extends mock<IFileService>() {
			override onDidRunOperation = Event.None;
			override onDidChangeFileSystemProviderCapabilities = Event.None;
			override onDidChangeFileSystemProviderRegistrations = Event.None;
		};

		return new MainThreadDocumentsAndEditors(
			SingleProxyRPCProtocol({
				$acceptDocumentsAndEditorsDelta: (delta: IDocumentsAndEditorsDelta) => { deltas.push(delta); },
				$acceptEditorDiffInformation: (_id: string, _diffInformation: ITextEditorDiffInformation | undefined) => { }
			}),
			modelService,
			textFileService,
			workbenchEditorService,
			codeEditorService,
			fileService,
			null!,
			editorGroupService,
			new class extends mock<IPaneCompositePartService>() implements IPaneCompositePartService {
				override onDidPaneCompositeOpen = Event.None;
				override onDidPaneCompositeClose = Event.None;
				override getActivePaneComposite() {
					return undefined;
				}
			},
			TestEnvironmentService,
			new TestWorkingCopyFileService(),
			new UriIdentityService(fileService),
			new class extends mock<IClipboardService>() {
				override readText() {
					return Promise.resolve('clipboard_contents');
				}
			},
			new TestPathService(),
			new TestConfigurationService(),
			new class extends mock<IQuickDiffModelService>() {
				override createQuickDiffModelReference() {
					return undefined;
				}
			}
		);
	}

	setup(() => {
		disposables = new DisposableStore();

		deltas.length = 0;
		const configService = new TestConfigurationService();
		configService.setUserConfiguration('editor', { 'detectIndentation': false });
		const dialogService = new TestDialogService();
		const notificationService = new TestNotificationService();
		const undoRedoService = new UndoRedoService(dialogService, notificationService);
		const themeService = new TestThemeService();
		const instantiationService = new TestInstantiationService();
		instantiationService.set(ILanguageService, disposables.add(new LanguageService()));
		instantiationService.set(ILanguageConfigurationService, new TestLanguageConfigurationService());
		instantiationService.set(ITreeSitterLibraryService, new TestTreeSitterLibraryService());
		instantiationService.set(IUndoRedoService, undoRedoService);
		modelService = new ModelService(
			configService,
			new TestTextResourcePropertiesService(configService),
			undoRedoService,
			instantiationService
		);
		codeEditorService = new TestCodeEditorService(themeService);
		textFileService = new class extends mock<ITextFileService>() {
			override isDirty() { return false; }
			// eslint-disable-next-line local/code-no-any-casts
			override files = <any>{
				onDidSave: Event.None,
				onDidRevert: Event.None,
				onDidChangeDirty: Event.None,
				onDidChangeEncoding: Event.None
			};
			// eslint-disable-next-line local/code-no-any-casts
			override untitled = <any>{
				onDidChangeEncoding: Event.None
			};
			override getEncoding() { return 'utf8'; }
		};
		workbenchEditorService = disposables.add(new TestEditorService());
		disposables.add(createMainThreadDocumentsAndEditors());
	});

	teardown(() => {
		disposables.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Model#add', () => {
		deltas.length = 0;

		disposables.add(modelService.createModel('farboo', null));

		assert.strictEqual(deltas.length, 1);
		const [delta] = deltas;

		assert.strictEqual(delta.addedDocuments!.length, 1);
		assert.strictEqual(delta.removedDocuments, undefined);
		assert.strictEqual(delta.addedEditors, undefined);
		assert.strictEqual(delta.removedEditors, undefined);
		assert.strictEqual(delta.newActiveEditor, undefined);
	});

	test('ignore huge model', function () {

		const oldLimit = TextModel._MODEL_SYNC_LIMIT;
		try {
			const largeModelString = 'abc'.repeat(1024);
			TextModel._MODEL_SYNC_LIMIT = largeModelString.length / 2;

			const model = modelService.createModel(largeModelString, null);
			disposables.add(model);
			assert.ok(model.isTooLargeForSyncing());

			assert.strictEqual(deltas.length, 1);
			const [delta] = deltas;
			assert.strictEqual(delta.newActiveEditor, null);
			assert.strictEqual(delta.addedDocuments, undefined);
			assert.strictEqual(delta.removedDocuments, undefined);
			assert.strictEqual(delta.addedEditors, undefined);
			assert.strictEqual(delta.removedEditors, undefined);

		} finally {
			TextModel._MODEL_SYNC_LIMIT = oldLimit;
		}
	});

	test('ignore huge model from editor', function () {

		const oldLimit = TextModel._MODEL_SYNC_LIMIT;
		try {
			const largeModelString = 'abc'.repeat(1024);
			TextModel._MODEL_SYNC_LIMIT = largeModelString.length / 2;

			const model = modelService.createModel(largeModelString, null);
			const editor = myCreateTestCodeEditor(model);

			assert.strictEqual(deltas.length, 1);
			deltas.length = 0;
			assert.strictEqual(deltas.length, 0);
			editor.dispose();
			model.dispose();

		} finally {
			TextModel._MODEL_SYNC_LIMIT = oldLimit;
		}
	});

	test('ignores stale active text editor controls without an active workbench editor', () => {
		const model = modelService.createModel('test', null);
		const editor = myCreateTestCodeEditor(model);
		workbenchEditorService.activeTextEditorControl = editor;
		workbenchEditorService.activeEditor = undefined;
		workbenchEditorService.activeEditorPane = undefined;
		workbenchEditorService.visibleEditorPanes = [];

		deltas.length = 0;
		disposables.add(createMainThreadDocumentsAndEditors());

		assert.strictEqual(deltas.length, 1);
		const [delta] = deltas;
		assert.strictEqual(delta.addedDocuments?.length, 1);
		assert.strictEqual(delta.addedEditors, undefined);
		assert.strictEqual(delta.newActiveEditor, undefined);

		editor.dispose();
		model.dispose();
	});

	test('tracks focused active text editor controls without an active workbench editor', () => {
		const model = modelService.createModel('test', null);
		const editor = createTestCodeEditor(model, {
			hasTextFocus: true,
			serviceCollection: new ServiceCollection(
				[ICodeEditorService, codeEditorService]
			)
		});

		workbenchEditorService.activeTextEditorControl = editor;
		workbenchEditorService.activeEditor = undefined;
		workbenchEditorService.activeEditorPane = undefined;
		workbenchEditorService.visibleEditorPanes = [];

		deltas.length = 0;
		disposables.add(createMainThreadDocumentsAndEditors());

		assert.strictEqual(deltas.length, 2);
		const [first, second] = deltas;
		assert.strictEqual(first.addedDocuments?.length, 1);
		assert.strictEqual(second.addedEditors?.length, 1);
		assert.ok(typeof second.newActiveEditor === 'string');

		editor.dispose();
		model.dispose();
	});

	test('tracks focused active text editor controls whose model is not yet in the shared model service', () => {
		const model = createTextModel('test');
		const editor = createTestCodeEditor(model, {
			hasTextFocus: true,
			serviceCollection: new ServiceCollection(
				[ICodeEditorService, codeEditorService]
			)
		});

		workbenchEditorService.activeTextEditorControl = editor;
		workbenchEditorService.activeEditor = undefined;
		workbenchEditorService.activeEditorPane = undefined;
		workbenchEditorService.visibleEditorPanes = [];

		deltas.length = 0;
		disposables.add(createMainThreadDocumentsAndEditors());

		assert.strictEqual(deltas.length, 2);
		const [first, second] = deltas;
		assert.strictEqual(first.addedDocuments?.length, 1);
		assert.strictEqual(first.addedDocuments?.[0].uri?.toString(), model.uri.toString());
		assert.strictEqual(second.addedEditors?.length, 1);
		assert.strictEqual(second.addedEditors?.[0].documentUri?.toString(), model.uri.toString());
		assert.ok(typeof second.newActiveEditor === 'string');

		editor.dispose();
		model.dispose();
	});

	test('ensureTextEditorForCodeEditor syncs the document before the editor when the model is untracked', () => {
		const model = createTextModel('test');
		const editor = createTestCodeEditor(model, {
			hasTextFocus: false,
			serviceCollection: new ServiceCollection(
				[ICodeEditorService, codeEditorService]
			)
		});
		const instance = disposables.add(createMainThreadDocumentsAndEditors());

		deltas.length = 0;
		const id = instance.ensureTextEditorForCodeEditor(editor as unknown as ICodeEditor);

		assert.ok(typeof id === 'string');
		assert.strictEqual(deltas.length, 1);
		const [delta] = deltas;
		assert.strictEqual(delta.addedDocuments?.length, 1);
		assert.strictEqual(delta.addedDocuments?.[0].uri?.toString(), model.uri.toString());
		assert.strictEqual(delta.addedEditors?.length, 1);
		assert.strictEqual(delta.addedEditors?.[0].documentUri?.toString(), model.uri.toString());

		editor.dispose();
		model.dispose();
	});

	test('ensureTextEditorForCodeEditor marks nested active text editor controls as active', () => {
		const model = createTextModel('test');
		const editor = createTestCodeEditor(model, {
			hasTextFocus: false,
			serviceCollection: new ServiceCollection(
				[ICodeEditorService, codeEditorService]
			)
		});
		const nestedPane = {
			input: {},
			group: { count: 1, contains: () => true },
			getControl: () => ({})
		} as unknown as IEditorPane;
		workbenchEditorService.activeEditor = nestedPane.input as never;
		workbenchEditorService.activeEditorPane = nestedPane;
		workbenchEditorService.activeTextEditorControl = editor;
		workbenchEditorService.visibleEditorPanes = [nestedPane];

		const instance = disposables.add(createMainThreadDocumentsAndEditors());

		deltas.length = 0;
		const id = instance.ensureTextEditorForCodeEditor(editor as unknown as ICodeEditor);

		assert.ok(typeof id === 'string');
		assert.strictEqual(deltas.length, 1);
		const [delta] = deltas;
		assert.strictEqual(delta.addedEditors?.length, 1);
		assert.strictEqual(delta.newActiveEditor, id);

		editor.dispose();
		model.dispose();
	});

	test('ignores stale editor panes whose group no longer reports the input as active', () => {
		const model = modelService.createModel('test', null);
		const editor = myCreateTestCodeEditor(model);
		const stalePane = { input: {}, group: { activeEditor: undefined, contains: () => false }, getControl: () => editor } as unknown as IEditorPane;
		workbenchEditorService.visibleEditorPanes = [stalePane];
		workbenchEditorService.activeEditor = undefined;
		workbenchEditorService.activeEditorPane = stalePane;
		workbenchEditorService.activeTextEditorControl = editor;

		deltas.length = 0;
		disposables.add(createMainThreadDocumentsAndEditors());

		assert.strictEqual(deltas.length, 1);
		const [delta] = deltas;
		assert.strictEqual(delta.addedDocuments?.length, 1);
		assert.strictEqual(delta.addedEditors, undefined);
		assert.strictEqual(delta.newActiveEditor, undefined);

		editor.dispose();
		model.dispose();
	});

	test('tracks active text editor controls when a workbench active editor exists but pane membership lags', () => {
		const model = modelService.createModel('test', null);
		const editor = myCreateTestCodeEditor(model);
		const pendingInput = {};
		const laggingPane = { input: pendingInput, group: { count: 0, contains: () => false }, getControl: () => editor } as unknown as IEditorPane;
		workbenchEditorService.activeEditor = pendingInput as never;
		workbenchEditorService.activeEditorPane = laggingPane;
		workbenchEditorService.activeTextEditorControl = editor;
		workbenchEditorService.visibleEditorPanes = [];

		deltas.length = 0;
		disposables.add(createMainThreadDocumentsAndEditors());

		assert.strictEqual(deltas.length, 2);
		const [first, second] = deltas;
		assert.strictEqual(first.addedDocuments?.length, 1);
		assert.strictEqual(second.addedEditors?.length, 1);
		assert.strictEqual(second.addedEditors?.[0].documentUri?.toString(), model.uri.toString());
		assert.ok(typeof second.newActiveEditor === 'string');

		editor.dispose();
		model.dispose();
	});

	test('ignore simple widget model', function () {
		this.timeout(1000 * 60); // increase timeout for this one test

		const model = modelService.createModel('test', null, undefined, true);
		disposables.add(model);
		assert.ok(model.isForSimpleWidget);

		assert.strictEqual(deltas.length, 1);
		const [delta] = deltas;
		assert.strictEqual(delta.newActiveEditor, null);
		assert.strictEqual(delta.addedDocuments, undefined);
		assert.strictEqual(delta.removedDocuments, undefined);
		assert.strictEqual(delta.addedEditors, undefined);
		assert.strictEqual(delta.removedEditors, undefined);
	});

	test('ignore editor w/o model', () => {
		const editor = myCreateTestCodeEditor(undefined);
		assert.strictEqual(deltas.length, 1);
		const [delta] = deltas;
		assert.strictEqual(delta.newActiveEditor, null);
		assert.strictEqual(delta.addedDocuments, undefined);
		assert.strictEqual(delta.removedDocuments, undefined);
		assert.strictEqual(delta.addedEditors, undefined);
		assert.strictEqual(delta.removedEditors, undefined);

		editor.dispose();
	});

	test('editor with model', () => {
		deltas.length = 0;

		const model = modelService.createModel('farboo', null);
		const editor = myCreateTestCodeEditor(model);

		assert.strictEqual(deltas.length, 2);
		const [first, second] = deltas;
		assert.strictEqual(first.addedDocuments!.length, 1);
		assert.strictEqual(first.newActiveEditor, undefined);
		assert.strictEqual(first.removedDocuments, undefined);
		assert.strictEqual(first.addedEditors, undefined);
		assert.strictEqual(first.removedEditors, undefined);

		assert.strictEqual(second.addedEditors!.length, 1);
		assert.strictEqual(second.addedDocuments, undefined);
		assert.strictEqual(second.removedDocuments, undefined);
		assert.strictEqual(second.removedEditors, undefined);
		assert.strictEqual(second.newActiveEditor, undefined);

		editor.dispose();
		model.dispose();
	});

	test('tracks visible simple widget editors', () => {
		deltas.length = 0;

		const model = modelService.createModel('farboo', null);
		const editor = {
			getId: () => 'visibleSimpleWidget',
			getModel: () => model,
			hasModel: () => true,
			hasTextFocus: () => false,
			hasWidgetFocus: () => false,
			isSimpleWidget: true,
			onDidChangeModel: Event.None,
			onDidFocusEditorText: Event.None,
			onDidFocusEditorWidget: Event.None
		} as unknown as ICodeEditor;

		const visiblePane = {
			getControl: () => editor
		} as unknown as IEditorPane;
		workbenchEditorService.visibleEditorPanes = [visiblePane];
		codeEditorService.addCodeEditor(editor);

		assert.strictEqual(deltas.length, 2);
		const [first, second] = deltas;
		assert.strictEqual(first.addedDocuments!.length, 1);
		assert.strictEqual(second.addedEditors!.length, 1);
		assert.strictEqual(second.addedEditors![0].documentUri?.scheme, model.uri.scheme);

		codeEditorService.removeCodeEditor(editor);
		model.dispose();
	});

	test('tracks active text editor controls even before pane controls resolve', () => {
		deltas.length = 0;

		const model = modelService.createModel('farboo', null);
		const editor = myCreateTestCodeEditor(model);
		codeEditorService.removeCodeEditor(editor);

		workbenchEditorService.activeTextEditorControl = editor;
		disposables.add(createMainThreadDocumentsAndEditors());

		assert.strictEqual(deltas.length, 2);
		const [, second] = deltas;
		assert.strictEqual(second.addedEditors!.length, 1);
		assert.strictEqual(second.addedEditors![0].documentUri?.toString(), model.uri.toString());

		editor.dispose();
		model.dispose();
	});

	test('editor with dispos-ed/-ing model', () => {
		const model = modelService.createModel('farboo', null);
		const editor = myCreateTestCodeEditor(model);

		// ignore things until now
		deltas.length = 0;

		modelService.destroyModel(model.uri);
		assert.strictEqual(deltas.length, 1);
		const [first] = deltas;

		assert.strictEqual(first.newActiveEditor, undefined);
		assert.strictEqual(first.removedEditors!.length, 1);
		assert.strictEqual(first.removedDocuments!.length, 1);
		assert.strictEqual(first.addedDocuments, undefined);
		assert.strictEqual(first.addedEditors, undefined);

		editor.dispose();
		model.dispose();
	});
});
