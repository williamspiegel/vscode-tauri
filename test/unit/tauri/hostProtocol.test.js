/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const assert = require('assert');
const path = require('path');

suite('Tauri Host Protocol', () => {
	/** @type {typeof import('../../../../apps/tauri/ui/src/hostProtocol')} */
	let hostProtocolModule;

	setup(() => {
		const compiledUiRoot = process.env.TAURI_UI_TEST_BUILD_DIR;
		assert.ok(compiledUiRoot, 'TAURI_UI_TEST_BUILD_DIR must be set by harness');

		hostProtocolModule = require(path.join(compiledUiRoot, 'hostProtocol.js'));
	});

	test('isKnownMethod returns true for declared methods and false for unknown methods', () => {
		assert.strictEqual(hostProtocolModule.isKnownMethod('desktop.channelCall'), true);
		assert.strictEqual(hostProtocolModule.isKnownMethod('desktop.channelUnlisten'), true);
		assert.strictEqual(hostProtocolModule.isKnownMethod('desktop.notARealMethod'), false);
	});

	test('validateRequiredParams enforces required params', () => {
		assert.throws(
			() => hostProtocolModule.validateRequiredParams('desktop.channelCall', { channel: 'nativeHost' }),
			/missing required param: method/
		);

		assert.doesNotThrow(() => hostProtocolModule.validateRequiredParams('desktop.channelCall', {
			channel: 'nativeHost',
			method: 'window.getState',
			args: []
		}));
	});

	test('validateRequiredParams throws for unknown methods', () => {
		assert.throws(
			() => hostProtocolModule.validateRequiredParams('desktop.unknownMethod', {}),
			/Unknown method/
		);
	});

	test('protocol version is stable', () => {
		assert.strictEqual(hostProtocolModule.hostProtocol.protocolVersion, '1.0.0');
		assert.ok(hostProtocolModule.hostProtocol.methods['desktop.resolveWindowConfig']);
	});
});
