/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { main } from './electrobun.ts';

export { config } from './electrobun.ts';

if (import.meta.main) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
