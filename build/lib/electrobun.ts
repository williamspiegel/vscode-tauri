/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

const root = path.dirname(path.dirname(import.meta.dirname));
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8')) as {
	nameLong: string;
	nameShort: string;
	applicationName: string;
};

export const config = {
	version: process.env['ELECTROBUN_VERSION'] || '0.0.0',
	productAppName: product.nameLong,
	companyName: 'Microsoft Corporation',
	darwinExecutable: product.nameShort,
	linuxExecutableName: product.applicationName,
	winIcon: 'resources/win32/code.ico',
	token: process.env['GITHUB_TOKEN']
};

function ensureRuntimeAvailable(runtimeBinary: string): void {
	const probeResult = spawnSync(runtimeBinary, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
	if (probeResult.status === 0) {
		return;
	}

	if (path.isAbsolute(runtimeBinary) || runtimeBinary.includes(path.sep)) {
		if (fs.existsSync(runtimeBinary)) {
			return;
		}
	}

	throw new Error(`Unable to execute '${runtimeBinary}'. Set ELECTROBUN_PATH to your Electrobun executable.`);
}

function resolveRuntimeBinary(runtimeBinary: string): string {
	const launcherBasename = process.platform === 'win32' ? 'launcher.exe' : 'launcher';
	const localLauncherCandidates = [
		path.join(root, launcherBasename),
		path.join(root, 'dist-macos-arm64', launcherBasename),
		path.join(root, 'dist-macos-x64', launcherBasename),
		path.join(root, 'node_modules', 'electrobun', 'dist-macos-arm64', launcherBasename),
		path.join(root, 'node_modules', 'electrobun', 'dist-macos-x64', launcherBasename)
	];

	const explicitRuntimePath = runtimeBinary;
	if (path.isAbsolute(explicitRuntimePath)) {
		return explicitRuntimePath;
	}

	if (explicitRuntimePath.includes(path.sep)) {
		return path.resolve(root, explicitRuntimePath);
	}

	// Prefer a native launcher in the workspace over the CLI shim.
	for (const candidate of localLauncherCandidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	const candidatePaths: string[] = [];

	if (path.isAbsolute(runtimeBinary)) {
		candidatePaths.push(runtimeBinary);
	} else if (runtimeBinary.includes(path.sep)) {
		candidatePaths.push(path.resolve(root, runtimeBinary));
	} else {
		const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
		const result = spawnSync(lookupCommand, [runtimeBinary], { encoding: 'utf8' });
		if (result.status === 0) {
			const resolved = result.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
			if (resolved) {
				candidatePaths.push(resolved);
			}
		}
	}

	// Common local fallback when users extracted electrobun core binaries in repo root.
	candidatePaths.push(path.join(root, launcherBasename));

	for (const candidatePath of candidatePaths) {
		if (candidatePath && fs.existsSync(candidatePath)) {
			return candidatePath;
		}
	}

	return runtimeBinary;
}

function writeUnixLauncher(launcherPath: string, runtimeBinary: string): void {
	fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
	fs.writeFileSync(launcherPath, `#!/usr/bin/env bash\nexec \"${runtimeBinary}\" \"$@\"\n`, 'utf8');
	fs.chmodSync(launcherPath, 0o755);
}

function rewriteOutImportsToRuntimeShim(runtimeShimPath: string, runtimeShimCjsPath: string): void {
	const outDir = path.join(root, 'out');
	if (!fs.existsSync(outDir)) {
		return;
	}

	const pendingDirs: string[] = [outDir];
	while (pendingDirs.length > 0) {
		const currentDir = pendingDirs.pop();
		if (!currentDir) {
			continue;
		}

		for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				pendingDirs.push(fullPath);
				continue;
			}

				if (!entry.isFile() || !entry.name.endsWith('.js')) {
					continue;
				}

				const originalText = fs.readFileSync(fullPath, 'utf8');
				const updatedText = originalText
					.replace(/from 'electron'/g, `from '${runtimeShimPath}'`)
					.replace(/from "electron"/g, `from "${runtimeShimPath}"`)
					.replace(/require\('electron'\)/g, `require('${runtimeShimCjsPath}')`)
					.replace(/require\("electron"\)/g, `require("${runtimeShimCjsPath}")`)
					.replace(/import\('electron'\)/g, `import('${runtimeShimPath}')`)
					.replace(/import\("electron"\)/g, `import("${runtimeShimPath}")`)
					.replace(/from 'electrobun'/g, `from '${runtimeShimPath}'`)
					.replace(/from "electrobun"/g, `from "${runtimeShimPath}"`)
					.replace(/require\('electrobun'\)/g, `require('${runtimeShimCjsPath}')`)
					.replace(/require\("electrobun"\)/g, `require("${runtimeShimCjsPath}")`)
					.replaceAll(`require('${runtimeShimPath}')`, `require('${runtimeShimCjsPath}')`)
					.replaceAll(`require("${runtimeShimPath}")`, `require("${runtimeShimCjsPath}")`);

			if (updatedText !== originalText) {
				fs.writeFileSync(fullPath, updatedText, 'utf8');
			}
		}
	}
}

function copyIfExists(sourcePath: string, targetPath: string): void {
	if (!fs.existsSync(sourcePath)) {
		return;
	}

	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.copyFileSync(sourcePath, targetPath);
	fs.chmodSync(targetPath, 0o755);
}

function writeDarwinLauncher(launcherPath: string, runtimeBinary: string): void {
	const runtimeBaseName = path.basename(runtimeBinary).toLowerCase();
	if (runtimeBaseName === 'launcher' || runtimeBaseName === 'launcher.exe') {
		fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
		fs.copyFileSync(runtimeBinary, launcherPath);
		fs.chmodSync(launcherPath, 0o755);

		const runtimeDir = path.dirname(runtimeBinary);
		for (const companion of ['bun', 'bsdiff', 'bspatch', 'libNativeWrapper.dylib', 'libasar.dylib', 'zig-zstd', 'extractor', 'process_helper']) {
			const sourcePath = path.join(runtimeDir, companion);
			const targetPath = path.join(path.dirname(launcherPath), companion);
			copyIfExists(sourcePath, targetPath);
		}
		return;
	}

	writeUnixLauncher(launcherPath, runtimeBinary);
}

function writeDarwinEntrypoint(buildPath: string, runtimeBinary: string): void {
	const entrypointPath = path.join(buildPath, `${product.nameLong}.app`, 'Contents', 'Resources', 'main.js');
	const appEntrypointPath = path.join(buildPath, `${product.nameLong}.app`, 'Contents', 'Resources', 'app', 'bun', 'index.js');
	const outMainPath = path.join(root, 'out', 'main.js');
	const runtimeMainPath = path.join(path.dirname(runtimeBinary), 'main.js');
	const versionPath = path.join(buildPath, `${product.nameLong}.app`, 'Contents', 'Resources', 'version.json');

	fs.mkdirSync(path.dirname(appEntrypointPath), { recursive: true });
	fs.writeFileSync(appEntrypointPath, `import { pathToFileURL } from 'node:url';
try {
	console.log('[electrobun app entrypoint] Importing out/main.js');
	await import(pathToFileURL(${JSON.stringify(outMainPath)}).href);
	console.log('[electrobun app entrypoint] Imported out/main.js');
} catch (error) {
	console.error('[electrobun app entrypoint] Failed to load out/main.js');
	console.error(error);
	process.exitCode = 1;
	throw error;
}
`, 'utf8');

	if (fs.existsSync(runtimeMainPath)) {
		copyIfExists(runtimeMainPath, entrypointPath);
	} else {
		fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
		fs.writeFileSync(entrypointPath, `import { pathToFileURL } from 'node:url';\nawait import(pathToFileURL(${JSON.stringify(outMainPath)}).href);\n`, 'utf8');
	}

	fs.writeFileSync(versionPath, JSON.stringify({
		name: product.nameLong,
		identifier: 'com.microsoft.VSCode',
		channel: 'dev'
	}, null, '\t'));
}

export async function main(): Promise<void> {
	const runtimeBinary = resolveRuntimeBinary(process.env['ELECTROBUN_PATH'] || 'electrobun');
	ensureRuntimeAvailable(runtimeBinary);
	rewriteOutImportsToRuntimeShim(
		path.join(root, 'build', 'lib', 'electrobun-runtime-shim.mjs'),
		path.join(root, 'build', 'lib', 'electrobun-runtime-shim.cjs')
	);

	const buildPath = path.join(root, '.build', 'electrobun');
	await fs.promises.rm(buildPath, { recursive: true, force: true });

	switch (process.platform) {
		case 'darwin': {
			const launcherPath = path.join(buildPath, `${product.nameLong}.app`, 'Contents', 'MacOS', `${product.nameShort}`);
			writeDarwinLauncher(launcherPath, runtimeBinary);
			writeDarwinEntrypoint(buildPath, runtimeBinary);
			break;
		}
		case 'linux': {
			const launcherPath = path.join(buildPath, `${product.applicationName}`);
			writeUnixLauncher(launcherPath, runtimeBinary);
			break;
		}
		case 'win32': {
			const launcherPath = path.join(buildPath, `${product.nameShort}.exe`);
			fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
			fs.copyFileSync(runtimeBinary, launcherPath);
			break;
		}
		default:
			throw new Error(`Unsupported platform: ${process.platform}`);
	}
}

function isMainEntryPoint(): boolean {
	const entryPath = process.argv[1];
	if (!entryPath) {
		return false;
	}

	return import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (import.meta.main || isMainEntryPoint()) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
