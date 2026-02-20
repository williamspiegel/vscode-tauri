/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'electrobun' {
	export = Electron.CrossProcessExports;
}

declare module 'electrobun/main' {
	export = Electron.Main;
}

declare module 'electrobun/common' {
	export = Electron.Common;
}

declare module 'electrobun/renderer' {
	export = Electron.Renderer;
}

declare module 'electrobun/utility' {
	export = Electron.Utility;
}

interface NodeRequireFunction {
	(moduleName: 'electrobun'): typeof Electron.CrossProcessExports;
	(moduleName: 'electrobun/main'): typeof Electron.Main;
	(moduleName: 'electrobun/common'): typeof Electron.Common;
	(moduleName: 'electrobun/renderer'): typeof Electron.Renderer;
	(moduleName: 'electrobun/utility'): typeof Electron.Utility;
}

interface NodeRequire {
	(moduleName: 'electrobun'): typeof Electron.CrossProcessExports;
	(moduleName: 'electrobun/main'): typeof Electron.Main;
	(moduleName: 'electrobun/common'): typeof Electron.Common;
	(moduleName: 'electrobun/renderer'): typeof Electron.Renderer;
	(moduleName: 'electrobun/utility'): typeof Electron.Utility;
}
