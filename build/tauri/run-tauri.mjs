/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import path from 'node:path';

const mode = process.argv[2] ?? 'dev';
if (!['dev', 'build'].includes(mode)) {
	console.error(`Unsupported tauri mode: ${mode}. Use dev or build.`);
	process.exit(1);
}
const appArgs = process.argv.slice(3);
const resolvedNodeBinary = process.env.VSCODE_TAURI_NODE_BINARY || process.execPath;
process.env.VSCODE_TAURI_NODE_BINARY = resolvedNodeBinary;
const useStaticFrontendInDev =
	mode === 'dev' &&
	['1', 'true', 'on'].includes(String(process.env.VSCODE_TAURI_NO_DEV_SERVER ?? '').toLowerCase());
const disableWatchInDev =
	mode === 'dev' &&
	['1', 'true', 'on'].includes(String(process.env.VSCODE_TAURI_NO_WATCH ?? '').toLowerCase());

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const SOURCEMAP_WARNING_PATTERN = /Sourcemap for ".*" points to missing source files/;
const DYNAMIC_IMPORT_WARNING_PATTERN = /dynamic import cannot be analyzed by Vite|vite:import-analysis|dynamic-import-vars#limitations/;

function shouldSuppressOutput(line) {
	return SOURCEMAP_WARNING_PATTERN.test(line) || DYNAMIC_IMPORT_WARNING_PATTERN.test(line);
}

function pipeFiltered(stream, sink) {
	if (!stream) {
		return;
	}

	stream.setEncoding('utf8');
	let pending = '';
	let warningBlock = '';
	let bufferingWarningBlock = false;

	const flushWarningBlock = () => {
		if (!warningBlock) {
			return;
		}

		if (!shouldSuppressOutput(warningBlock)) {
			sink.write(warningBlock);
		}

		warningBlock = '';
		bufferingWarningBlock = false;
	};

	stream.on('data', chunk => {
		pending += chunk;
		let lineEnd = pending.indexOf('\n');
		while (lineEnd !== -1) {
			const line = pending.slice(0, lineEnd + 1);
			pending = pending.slice(lineEnd + 1);

			if (bufferingWarningBlock) {
				warningBlock += line;
				if (line.trim().length === 0) {
					flushWarningBlock();
				}
				lineEnd = pending.indexOf('\n');
				continue;
			}

			if (line.includes('[vite] (client) warning:')) {
				bufferingWarningBlock = true;
				warningBlock = line;
				lineEnd = pending.indexOf('\n');
				continue;
			}

			if (!shouldSuppressOutput(line)) {
				sink.write(line);
			}

			lineEnd = pending.indexOf('\n');
		}
	});

	stream.on('end', () => {
		if (pending.length > 0 && !shouldSuppressOutput(pending)) {
			sink.write(pending);
		}
		flushWarningBlock();
	});
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repoRoot,
			env: process.env,
			shell: process.platform === 'win32',
			stdio: ['inherit', 'pipe', 'pipe'],
			...options
		});

		pipeFiltered(child.stdout, process.stdout);
		pipeFiltered(child.stderr, process.stderr);

		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (signal) {
				process.kill(process.pid, signal);
				return;
			}

			if (typeof code === 'number' && code !== 0) {
				process.exit(code);
				return;
			}

			resolve();
		});
	});
}

await run('node', ['build/next/index.ts', 'transpile', '--exclude-tests']);
await run('node', ['build/tauri/contract-test.mjs']);
await run('node', ['build/tauri/smoke.mjs']);
await run('npm', ['--prefix', 'apps/tauri/ui', 'run', 'build']);
const tauriArgs = ['tauri', mode];
if (useStaticFrontendInDev) {
	tauriArgs.push(
		'--config',
		JSON.stringify({
			build: {
				beforeDevCommand: '',
				devUrl: null
			}
		}),
		'--no-dev-server'
	);
}
if (disableWatchInDev) {
	tauriArgs.push('--no-watch');
}
if (appArgs.length > 0) {
	tauriArgs.push('--', '--', ...appArgs);
}
await run('cargo', tauriArgs, { cwd: path.join(repoRoot, 'apps/tauri/src-tauri') });
