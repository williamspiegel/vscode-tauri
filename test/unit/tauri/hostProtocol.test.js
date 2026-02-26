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

	test('validateRequiredParams throws when required-object methods receive non-object params', () => {
		assert.throws(
			() => hostProtocolModule.validateRequiredParams('desktop.channelCall', null),
			/expects object params/
		);
	});

	test('validateRequiredParams allows object methods with no required params', () => {
		assert.doesNotThrow(() => hostProtocolModule.validateRequiredParams('update.check', undefined));
		assert.doesNotThrow(() => hostProtocolModule.validateRequiredParams('window.getState', null));
	});

	test('validateRequiredParams ignores non-object method specs', () => {
		assert.doesNotThrow(() => hostProtocolModule.validateRequiredParams('protocol.handshake', undefined));
	});

	test('validateRequiredParams enforces every required protocol param', () => {
		const methods = hostProtocolModule.hostProtocol.methods;
		for (const [method, spec] of Object.entries(methods)) {
			const paramsSpec = spec && typeof spec === 'object' ? spec.params : undefined;
			if (!paramsSpec || paramsSpec.type !== 'object' || !Array.isArray(paramsSpec.required) || paramsSpec.required.length === 0) {
				continue;
			}

			const firstRequired = paramsSpec.required[0];
			assert.throws(
				() => hostProtocolModule.validateRequiredParams(method, {}),
				new RegExp(`missing required param: ${firstRequired}`)
			);
		}
	});

	test('validateRequiredParams rejects non-object params for required-object methods', () => {
		const methods = hostProtocolModule.hostProtocol.methods;
		for (const [method, spec] of Object.entries(methods)) {
			const paramsSpec = spec && typeof spec === 'object' ? spec.params : undefined;
			if (!paramsSpec || paramsSpec.type !== 'object' || !Array.isArray(paramsSpec.required) || paramsSpec.required.length === 0) {
				continue;
			}

			assert.throws(
				() => hostProtocolModule.validateRequiredParams(method, 'not-an-object'),
				/expects object params/
			);
		}
	});

	test('validateRequiredParams allows object-param methods with no required fields', () => {
		const methods = hostProtocolModule.hostProtocol.methods;
		for (const [method, spec] of Object.entries(methods)) {
			const paramsSpec = spec && typeof spec === 'object' ? spec.params : undefined;
			if (!paramsSpec || paramsSpec.type !== 'object') {
				continue;
			}
			if (Array.isArray(paramsSpec.required) && paramsSpec.required.length > 0) {
				continue;
			}

			assert.doesNotThrow(() => hostProtocolModule.validateRequiredParams(method, undefined));
			assert.doesNotThrow(() => hostProtocolModule.validateRequiredParams(method, null));
		}
	});

	test('protocol version is stable', () => {
		assert.strictEqual(hostProtocolModule.hostProtocol.protocolVersion, '1.0.0');
		assert.ok(hostProtocolModule.hostProtocol.methods['desktop.resolveWindowConfig']);
	});
});
