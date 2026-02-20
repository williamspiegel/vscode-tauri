/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const typesPath = path.join(srcDir, 'vs/base/parts/sandbox/common/desktopRuntimeTypes.js');

const files = [
	'src/main.ts',
	'src/vs/base/parts/sandbox/electron-browser/preload.ts',
	'src/vs/base/parts/sandbox/node/electronTypes.ts',
	'src/vs/code/electron-main/app.ts',
	'src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts',
	'src/vs/platform/browserElements/electron-main/nativeBrowserElementsMainService.ts',
	'src/vs/platform/browserView/electron-main/browserSession.ts',
	'src/vs/platform/browserView/electron-main/browserView.ts',
	'src/vs/platform/browserView/electron-main/browserViewDebugger.ts',
	'src/vs/platform/browserView/electron-main/browserViewMainService.ts',
	'src/vs/platform/debug/electron-main/extensionHostDebugIpc.ts',
	'src/vs/platform/native/electron-main/nativeHostMainService.ts',
	'src/vs/platform/protocol/electron-main/protocolMainService.ts',
	'src/vs/platform/terminal/common/terminal.ts',
	'src/vs/platform/terminal/node/terminalProcess.ts',
	'src/vs/platform/theme/electron-main/themeMainServiceImpl.ts',
	'src/vs/platform/utilityProcess/electron-main/utilityProcess.ts',
	'src/vs/platform/webContentExtractor/electron-main/webPageLoader.ts',
	'src/vs/platform/webContentExtractor/test/electron-main/webPageLoader.test.ts',
	'src/vs/platform/windows/electron-main/windowImpl.ts',
	'src/vs/platform/windows/test/electron-main/windowsFinder.test.ts',
	'src/vs/platform/workspaces/test/electron-main/workspacesManagementMainService.test.ts',
	'src/vs/workbench/contrib/chat/browser/actions/chatContext.ts',
	'src/vs/workbench/test/electron-browser/workbenchTestServices.ts'
];

files.forEach(file => {
	const filePath = path.join(__dirname, file);
	if (!fs.existsSync(filePath)) {
		return;
	}

	let content = fs.readFileSync(filePath, 'utf8');
	const matches = [...content.matchAll(/Electron\.([A-Za-z]+)/g)];
	if (matches.length === 0) {
		return;
	}

	const typesToImport = new Set();
	matches.forEach(m => typesToImport.add(m[1]));

	// Check if the file already imports from desktopRuntimeTypes
	const relPath = path.relative(path.dirname(filePath), typesPath).replace(/\\/g, '/');
	const importPath = relPath.startsWith('.') ? relPath : `./${relPath}`;

	// Replace Electron.X with X
	content = content.replace(/Electron\.([A-Za-z]+)/g, '$1');

	// Add import statement
	const importRegex = new RegExp(`from ['"]${importPath}['"]`);
	if (importRegex.test(content)) {
		// already has import, need to merge? just add a new import line for simplicity, or ignore if it's tricky.
		// Actually, a new import line with the same path is valid in TS/JS.
		const importStmt = `import type { ${[...typesToImport].join(', ')} } from '${importPath}';`;
		const lastImportIndex = content.lastIndexOf('import ');
		if (lastImportIndex !== -1) {
			const endOfLastImport = content.indexOf('\n', lastImportIndex);
			content = content.slice(0, endOfLastImport) + '\n' + importStmt + content.slice(endOfLastImport);
		} else {
			content = importStmt + '\n' + content;
		}
	} else {
		const importStmt = `import type { ${[...typesToImport].join(', ')} } from '${importPath}';`;
		const lastImportIndex = content.lastIndexOf('import ');
		if (lastImportIndex !== -1) {
			const endOfLastImport = content.indexOf('\n', lastImportIndex);
			content = content.slice(0, endOfLastImport) + '\n' + importStmt + content.slice(endOfLastImport);
		} else {
			// Find first line after comments
			content = importStmt + '\n' + content;
		}
	}

	fs.writeFileSync(filePath, content);
	console.log(`Updated ${file}`);
});
