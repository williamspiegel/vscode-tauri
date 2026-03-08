/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
	const options = {
		compileTsconfig: undefined,
		extensionDevelopmentPath: undefined,
		extensionTestsPath: undefined,
		testCliLabel: undefined,
		label: undefined,
		launchArgs: []
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--compile-tsconfig':
				options.compileTsconfig = argv[++i];
				break;
			case '--extensionDevelopmentPath':
				options.extensionDevelopmentPath = argv[++i];
				break;
			case '--extensionTestsPath':
				options.extensionTestsPath = argv[++i];
				break;
			case '--label':
				options.label = argv[++i];
				break;
			case '--test-cli-label':
				options.testCliLabel = argv[++i];
				break;
			case '--':
				options.launchArgs.push(...argv.slice(i + 1));
				i = argv.length;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!options.testCliLabel && (!options.extensionDevelopmentPath || !options.extensionTestsPath)) {
		throw new Error('--test-cli-label or both --extensionDevelopmentPath and --extensionTestsPath are required');
	}

	return options;
}

function prefixLines(chunk, label) {
	return chunk
		.split(/\r?\n/)
		.filter(line => line.length > 0)
		.map(line => `[${label}] ${line}`);
}

function createGroupKiller(child) {
	return (signal = 'SIGTERM') => {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}

		try {
			process.kill(-child.pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// ignore
			}
		}
	};
}

async function runCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => {
			stdout += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on('data', chunk => {
			stderr += chunk;
			process.stderr.write(chunk);
		});
		child.on('error', reject);
		child.on('exit', code => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new Error(`${command} ${args.join(' ')} exited with code ${code}\n${stdout}\n${stderr}`));
			}
		});
	});
}

async function readNewSignalLines(signalFile, cursor) {
	try {
		const stat = await fsp.stat(signalFile);
		if (stat.size <= cursor.offset) {
			return { cursor, lines: [] };
		}

		const handle = await fsp.open(signalFile, 'r');
		try {
			const length = stat.size - cursor.offset;
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, cursor.offset);
			const text = cursor.partial + buffer.toString('utf8');
			const lines = text.split('\n');
			const partial = lines.pop() ?? '';
			return {
				cursor: { offset: stat.size, partial },
				lines: lines.filter(Boolean)
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return { cursor, lines: [] };
		}
		throw error;
	}
}

async function main() {
	const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
	const options = parseArgs(process.argv.slice(2));

	if (options.compileTsconfig) {
		await runCommand('./node_modules/.bin/tsc', ['-p', options.compileTsconfig], {
			cwd: repoRoot,
			env: process.env
		});
	}

	const runRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vscode-tauri-standalone-'));
	const logsPath = path.join(runRoot, 'logs');
	const crashPath = path.join(runRoot, 'crashes');
	const userDataPath = path.join(runRoot, 'user-data');
	const workspacePath = path.join(runRoot, 'workspace');
	const signalFile = path.join(runRoot, 'signals', 'extension-tests.jsonl');
	await Promise.all([
		fsp.mkdir(logsPath, { recursive: true }),
		fsp.mkdir(crashPath, { recursive: true }),
		fsp.mkdir(userDataPath, { recursive: true }),
		fsp.mkdir(workspacePath, { recursive: true })
	]);

	const devPath = options.extensionDevelopmentPath ? path.resolve(repoRoot, options.extensionDevelopmentPath) : undefined;
	const testsPath = options.extensionTestsPath ? path.resolve(repoRoot, options.extensionTestsPath) : undefined;
	const label = options.label ?? options.testCliLabel ?? (devPath ? path.basename(devPath) : 'standalone-extension-tests');
	const allowCleanExitFallback = Boolean(options.testCliLabel);
	const childCommand = options.testCliLabel ? 'npm' : './scripts/code-tauri.sh';
	const childArgs = options.testCliLabel
		? ['run', 'test-extension', '--', '-l', options.testCliLabel, ...options.launchArgs]
		: [
			workspacePath,
			'--disable-telemetry',
			'--disable-experiments',
			'--skip-welcome',
			'--skip-release-notes',
			`--crash-reporter-directory=${crashPath}`,
			`--logsPath=${logsPath}`,
			'--no-cached-data',
			'--disable-updates',
			'--use-inmemory-secretstorage',
			'--disable-extensions',
			'--disable-workspace-trust',
			`--user-data-dir=${userDataPath}`,
			`--extensionDevelopmentPath=${devPath}`,
			`--extensionTestsPath=${testsPath}`,
			...options.launchArgs
		];
	const child = spawn(childCommand, childArgs, {
		cwd: repoRoot,
		env: {
			...process.env,
			INTEGRATION_TEST_ELECTRON_PATH: process.env.INTEGRATION_TEST_ELECTRON_PATH ?? './scripts/code-tauri.sh',
			VSCODE_TAURI_INTEGRATION: '1',
			VSCODE_TAURI_NO_WATCH: process.env.VSCODE_TAURI_NO_WATCH ?? '1',
			VSCODE_TAURI_NO_DEV_SERVER: process.env.VSCODE_TAURI_NO_DEV_SERVER ?? '1',
			VSCODE_SKIP_PRELAUNCH: process.env.VSCODE_SKIP_PRELAUNCH ?? '1',
			VSCODE_TAURI_EXTENSION_TESTS_SIGNAL_FILE: signalFile
		},
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	const killGroup = createGroupKiller(child);
	let completed = false;
	let signalCursor = { offset: 0, partial: '' };
	let pollHandle = undefined;
	let stdoutBuffer = '';
	let stderrBuffer = '';
	const successPatterns = [
		'[tauri.integration.extHostTests] execute resolved code=0',
		'[tauri.integration.extensionTests] execute resolved 0'
	];
	const failurePatterns = [
		'[tauri.integration.extHostTests] execute failed',
		'[tauri.integration.extensionTests] execute failed',
		' test failed.',
		' tests failed.'
	];
	const inspectSignalPayload = async (payload) => {
		if ((payload.event === 'execute-resolved' || payload.event === 'main-execute-resolved') && payload.code === 0) {
			await finish(0);
			return true;
		}

		if (payload.event === 'execute-failed' || payload.event === 'main-execute-failed' || payload.event === 'callback-error' || payload.event === 'promise-rejected' || payload.event === 'main-no-host') {
			await finish(1, `failure signal: ${payload.event}`);
			return true;
		}

		if (payload.event === 'callback-result' && typeof payload.failures === 'number') {
			if (payload.failures > 0) {
				await finish(1, `test failures reported: ${payload.failures}`);
			} else {
				await finish(0);
			}
			return true;
		}

		if ((payload.event === 'execute-resolved' || payload.event === 'main-execute-resolved') && typeof payload.code === 'number' && payload.code !== 0) {
			await finish(1, `execute resolved with code=${payload.code}`);
			return true;
		}

		return false;
	};
	const inspectSignalFile = async () => {
		const result = await readNewSignalLines(signalFile, signalCursor);
		signalCursor = result.cursor;
		for (const line of result.lines) {
			let payload;
			try {
				payload = JSON.parse(line);
			} catch {
				continue;
			}

			if (await inspectSignalPayload(payload)) {
				return true;
			}
		}

		return false;
	};

	const finish = async (exitCode, reason) => {
		if (completed) {
			return;
		}
		completed = true;
		if (pollHandle) {
			clearInterval(pollHandle);
		}
		if (reason) {
			console.error(`[${label}] ${reason}`);
		}
		killGroup(exitCode === 0 ? 'SIGTERM' : 'SIGKILL');
		if (exitCode === 0) {
			try {
				await fsp.rm(runRoot, { recursive: true, force: true });
			} catch {
				// ignore cleanup failures
			}
		} else {
			console.error(`[${label}] preserved debug artifacts at ${runRoot}`);
		}
		process.exit(exitCode);
	};

	const inspectBuffer = async (buffer, streamName) => {
		if (completed) {
			return;
		}

		for (const pattern of successPatterns) {
			if (buffer.includes(pattern)) {
				await finish(0);
				return;
			}
		}

		for (const pattern of failurePatterns) {
			if (buffer.includes(pattern)) {
				await finish(1, `failure marker detected from ${streamName}: ${pattern}`);
				return;
			}
		}
	};

	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');

	child.stdout.on('data', chunk => {
		stdoutBuffer += chunk;
		for (const line of prefixLines(chunk, label)) {
			process.stdout.write(`${line}\n`);
		}
		void inspectBuffer(stdoutBuffer, 'stdout');
	});
	child.stderr.on('data', chunk => {
		stderrBuffer += chunk;
		for (const line of prefixLines(chunk, label)) {
			process.stderr.write(`${line}\n`);
		}
		void inspectBuffer(stderrBuffer, 'stderr');
	});
	child.on('error', error => {
		void finish(1, `launch failed: ${error instanceof Error ? error.message : String(error)}`);
	});
	child.on('exit', (code, signal) => {
		if (completed) {
			return;
		}
		void (async () => {
			try {
				await inspectSignalFile();
				if (completed) {
					return;
				}
				await new Promise(resolve => setTimeout(resolve, 300));
				await inspectSignalFile();
				if (completed) {
					return;
				}
			} catch (error) {
				await finish(1, `signal polling failed during exit: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}

			if (code === 0 && allowCleanExitFallback) {
				await finish(0);
				return;
			}

			await finish(code === 0 ? 0 : 1, `exited before success marker code=${code} signal=${signal}`);
		})();
	});

	pollHandle = setInterval(async () => {
		if (completed) {
			return;
		}

		try {
			await inspectSignalFile();
		} catch (error) {
			await finish(1, `signal polling failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, 250);

	setTimeout(() => {
		if (completed) {
			return;
		}
		void finish(1, 'timed out waiting for extension test signal');
	}, 600000);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
