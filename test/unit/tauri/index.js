/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const Mocha = require('mocha');
const ts = require('typescript');
const glob = require('glob');
const { applyReporter } = require('../reporter');

/**
 * @type {{
 * grep: string;
 * run: string;
 * runGlob: string;
 * reporter: string;
 * 'reporter-options': string;
 * help: boolean;
 * }}
 */
const args = minimist(process.argv.slice(2), {
	string: ['grep', 'run', 'runGlob', 'reporter', 'reporter-options'],
	boolean: ['help'],
	alias: {
		grep: ['g', 'f'],
		runGlob: ['glob', 'runGrep'],
		help: 'h'
	},
	default: {
		reporter: 'spec',
		'reporter-options': ''
	}
});

if (args.help) {
	console.log(`Usage: node ${process.argv[1]} [options]

Options:
--grep, -g, -f <pattern>      only run tests matching <pattern>
--run <file>                  only run tests from <file>
--runGlob, --glob <pattern>   only run tests matching <file_pattern>
--reporter <reporter>         mocha reporter name (default: "spec")
--reporter-options <options>  reporter options
--help, -h                    show help`);
	process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const compiledRoot = path.join(repoRoot, '.tmp', 'tauri-unit', 'compiled');
const compiledUiRoot = path.join(compiledRoot, 'apps', 'tauri', 'ui', 'src');
const testRoot = __dirname;

function collectFiles(dir, matcher) {
	/** @type {string[]} */
	const output = [];

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			output.push(...collectFiles(fullPath, matcher));
			continue;
		}

		if (matcher(fullPath)) {
			output.push(fullPath);
		}
	}

	return output;
}

function ensureParent(pathname) {
	fs.mkdirSync(path.dirname(pathname), { recursive: true });
}

function transpileTauriUiSources() {
	const sourceRoot = path.join(repoRoot, 'apps', 'tauri', 'ui', 'src');
	fs.rmSync(compiledRoot, { recursive: true, force: true });
	fs.mkdirSync(compiledUiRoot, { recursive: true });
	fs.writeFileSync(path.join(compiledRoot, 'package.json'), '{\n\t"type": "commonjs"\n}\n');

	const sourceFiles = collectFiles(sourceRoot, fullPath => fullPath.endsWith('.ts'));
	for (const sourcePath of sourceFiles) {
		const relative = path.relative(sourceRoot, sourcePath);
		const destination = path.join(compiledUiRoot, relative.replace(/\.ts$/, '.js'));
		const source = fs.readFileSync(sourcePath, 'utf8');
		const transpiled = ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
				moduleResolution: ts.ModuleResolutionKind.Node10,
				ignoreDeprecations: '6.0',
				resolveJsonModule: true,
				esModuleInterop: true,
				allowSyntheticDefaultImports: true
			},
			fileName: sourcePath,
			reportDiagnostics: true
		});

		if (transpiled.diagnostics?.length) {
			const formatted = ts.formatDiagnosticsWithColorAndContext(transpiled.diagnostics, {
				getCurrentDirectory: () => repoRoot,
				getCanonicalFileName: filename => filename,
				getNewLine: () => '\n'
			});
			throw new Error(`Failed to transpile ${sourcePath}\n${formatted}`);
		}

		ensureParent(destination);
		fs.writeFileSync(destination, transpiled.outputText);
	}

	const protocolSource = path.join(repoRoot, 'apps', 'tauri', 'protocol', 'host-v1.json');
	const protocolDestination = path.join(compiledRoot, 'apps', 'tauri', 'protocol', 'host-v1.json');
	ensureParent(protocolDestination);
	fs.copyFileSync(protocolSource, protocolDestination);

	process.env.TAURI_UI_TEST_BUILD_DIR = compiledUiRoot;
}

function cleanupCompiledArtifacts() {
	fs.rmSync(path.join(repoRoot, '.tmp', 'tauri-unit'), { recursive: true, force: true });
}

function resolveTestModules() {
	if (args.run) {
		const files = Array.isArray(args.run) ? args.run : [args.run];
		return files.map(file => path.resolve(repoRoot, file));
	}

	const pattern = args.runGlob || '**/*.test.js';
	return glob.sync(pattern, { cwd: testRoot }).map(file => path.join(testRoot, file));
}

async function main() {
	transpileTauriUiSources();

	const modules = resolveTestModules();
	if (modules.length === 0) {
		console.warn('No Tauri unit test files matched.');
		process.exit(0);
	}

	const mocha = new Mocha({
		ui: 'tdd',
		reporter: function () { },
		grep: args.grep ? new RegExp(args.grep) : undefined,
		timeout: 10000
	});

	for (const modulePath of modules) {
		mocha.addFile(modulePath);
	}

	await mocha.loadFilesAsync();

	const runner = mocha.run(failures => {
		cleanupCompiledArtifacts();
		process.exit(failures ? 1 : 0);
	});
	applyReporter(runner, args);
}

main().catch(error => {
	console.error(error);
	cleanupCompiledArtifacts();
	process.exit(1);
});
