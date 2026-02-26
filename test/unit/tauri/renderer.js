/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This browser harness is intentionally lightweight and mirrors the
// Electron/browser unit harness structure so Tauri browser-side cases can
// be added incrementally without reworking test bootstrapping.
mocha.setup({ ui: 'tdd', timeout: 5000 });

suite('Tauri Renderer Harness', () => {
	test('boots mocha in browser context', () => {
		if (!globalThis.window) {
			throw new Error('renderer harness requires a window object');
		}
	});
});

mocha.run();
