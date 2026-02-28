/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const paths = require('path');
const glob = require('glob');
// Linux: prevent a weird NPE when mocha on Linux requires the window size from the TTY
// Since we are not running in a tty environment, we just implement the method statically
const tty = require('tty');
// @ts-ignore
if (!tty.getWindowSize) {
	// @ts-ignore
	tty.getWindowSize = function () { return [80, 75]; };
}
const Mocha = require('mocha');

let mocha = new Mocha({
	ui: 'tdd',
	color: true
});

function traceTauriIntegration(message, ...args) {
	if (process.env.VSCODE_TAURI_INTEGRATION !== '1') {
		return;
	}

	console.error(`[tauri.integration.testRunner] ${message}`, ...args);
}

exports.configure = function configure(opts) {
	mocha = new Mocha(opts);
};

exports.run = function run(testsRoot, clb) {
	// Enable source map support
	require('source-map-support').install();
	traceTauriIntegration(`scan start root=${testsRoot}`);

	// Glob test files
	glob('**/**.test.js', { cwd: testsRoot }, function (error, files) {
		if (error) {
			traceTauriIntegration('scan error', error);
			return clb(error);
		}
		try {
			traceTauriIntegration(`scan complete files=${files.length}`);
			// Fill into Mocha
			files.forEach(function (f) {
				traceTauriIntegration(`load file ${f}`);
				return mocha.addFile(paths.join(testsRoot, f));
			});
			// Run the tests
			const runner = mocha.run(function (failures) {
				traceTauriIntegration(`run complete failures=${failures}`);
				clb(null, failures);
			});
			runner.on('test', function (test) {
				traceTauriIntegration(`test start ${test.fullTitle()}`);
			});
			runner.on('pass', function (test) {
				traceTauriIntegration(`test pass ${test.fullTitle()}`);
			});
			runner.on('pending', function (test) {
				traceTauriIntegration(`test pending ${test.fullTitle()}`);
			});
			runner.on('fail', function (test, err) {
				traceTauriIntegration(`test fail ${test.fullTitle()}`, err);
			});
		}
		catch (error) {
			traceTauriIntegration('run setup error', error);
			return clb(error);
		}
	});
};
