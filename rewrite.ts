/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

async function main() {
	const root = path.join(process.cwd(), 'out');

	async function* findFiles(dir: string): AsyncGenerator<string> {
		const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const dirent of dirents) {
			const res = path.resolve(dir, dirent.name);
			if (dirent.isDirectory()) {
				yield* findFiles(res);
			} else {
				yield res;
			}
		}
	}

	const runtimePath = '/Users/williamspiegel/Documents/codexExperiments/vscode-electrobun/build/lib/electrobun-runtime-shim.mjs';

	let count = 0;
	for await (const file of findFiles(root)) {
		if (file.endsWith('.js') || file.endsWith('.mjs')) {
			const content = await fs.promises.readFile(file, 'utf8');
			let newContent = content.replace(/from ['"]electrobun['"]/g, `from '${runtimePath}'`);
			newContent = newContent.replace(/require\(['"]electrobun['"]\)/g, `require('${runtimePath}')`);
			if (content !== newContent) {
				await fs.promises.writeFile(file, newContent);
				console.log(`Rewrote ${file}`);
				count++;
			}
		}
	}
	console.log(`Rewrote ${count} files.`);
}

main().catch(console.error);
