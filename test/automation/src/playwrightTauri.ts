/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as playwright from '@playwright/test';
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { PlaywrightDriver } from './playwrightDriver';
import { Logger, measureAndLog } from './logger';
import type { LaunchOptions } from './code';

const root = join(__dirname, '..', '..', '..');
const DEFAULT_TAURI_ENDPOINT = 'http://127.0.0.1:1420';

export async function launch(options: LaunchOptions): Promise<{ tauriProcess: ChildProcess; driver: PlaywrightDriver }> {
	const tauriProcess = await launchTauriHost(options);
	const endpoint = await waitForTauriEndpoint(options.logger);
	const { browser, context, page } = await launchBrowser(options, endpoint);

	return {
		tauriProcess,
		driver: new PlaywrightDriver(browser, context, page, tauriProcess, Promise.resolve(), options)
	};
}

async function launchTauriHost(options: LaunchOptions): Promise<ChildProcess> {
	const script = join(root, 'scripts', process.platform === 'win32' ? 'code-tauri.bat' : 'code-tauri.sh');
	const args: string[] = [];
	if (options.codePath) {
		args.push('--build');
	}

	const env = {
		...process.env,
		VSCODE_SKIP_PRELAUNCH: process.env.VSCODE_SKIP_PRELAUNCH ?? '1',
		VSCODE_TAURI_NO_DEV_SERVER: process.env.VSCODE_TAURI_NO_DEV_SERVER ?? '1',
		VSCODE_TAURI_NO_WATCH: process.env.VSCODE_TAURI_NO_WATCH ?? '1'
	};

	options.logger.log(`Starting Tauri host with '${script} ${args.join(' ')}'`);
	const tauriProcess = spawn(script, args, {
		cwd: root,
		env,
		shell: process.platform === 'win32'
	});

	tauriProcess.stdout?.on('data', data => options.logger.log(`[tauri-launch] stdout: ${data}`));
	tauriProcess.stderr?.on('data', data => options.logger.log(`[tauri-launch] stderr: ${data}`));

	tauriProcess.once('exit', (code, signal) => {
		options.logger.log(`[tauri-launch] exited early (code: ${code}, signal: ${signal})`);
	});

	return tauriProcess;
}

async function waitForTauriEndpoint(logger: Logger): Promise<string> {
	const attempts = 180;
	const retryDelayMs = 1000;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(DEFAULT_TAURI_ENDPOINT, { method: 'GET' });
			if (response.ok || response.status === 304 || response.status === 404) {
				logger.log(`Tauri endpoint is reachable at ${DEFAULT_TAURI_ENDPOINT} (attempt ${attempt}).`);
				return DEFAULT_TAURI_ENDPOINT;
			}
		} catch {
			// keep retrying while host starts up
		}

		await new Promise(resolve => setTimeout(resolve, retryDelayMs));
	}

	throw new Error(`Timed out waiting for Tauri endpoint at ${DEFAULT_TAURI_ENDPOINT}.`);
}

async function launchBrowser(options: LaunchOptions, endpoint: string) {
	const { logger, tracing, snapshots, headless } = options;

	const playwrightImpl = options.playwright ?? playwright;
	const [browserType, browserChannel] = (options.browser ?? 'chromium').split('-');
	const browser = await measureAndLog(() => playwrightImpl[browserType as 'chromium' | 'webkit' | 'firefox'].launch({
		headless: headless ?? true,
		timeout: 0,
		channel: browserChannel
	}), 'playwright#launch (tauri)', logger);
	const context = await measureAndLog(() => browser.newContext(), 'browser.newContext (tauri)', logger);

	if (tracing) {
		try {
			await measureAndLog(() => context.tracing.start({ screenshots: true, snapshots }), 'context.tracing.start() (tauri)', logger);
		} catch (error) {
			logger.log(`Playwright (Tauri): Failed to start playwright tracing (${error})`);
		}
	}

	const page = await measureAndLog(() => context.newPage(), 'context.newPage (tauri)', logger);
	await measureAndLog(() => page.setViewportSize({ width: 1440, height: 900 }), 'page.setViewportSize (tauri)', logger);
	await measureAndLog(() => page.goto(endpoint, { waitUntil: 'domcontentloaded' }), 'page.goto() (tauri)', logger);

	page.on('console', msg => logger.log(`Playwright (Tauri): [${msg.type()}] ${msg.text()}`));
	page.on('pageerror', error => logger.log(`Playwright (Tauri) ERROR: page error: ${error}`));
	page.on('crash', () => logger.log('Playwright (Tauri) ERROR: page crash'));

	return { browser, context, page };
}
