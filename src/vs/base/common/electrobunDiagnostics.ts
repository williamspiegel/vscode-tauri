/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const ELECTROBUN_DIAGNOSTICS_FLAG = 'VSCODE_ELECTROBUN_DIAG';

export function isElectrobunDiagnosticsEnabled(): boolean {
	return process.env[ELECTROBUN_DIAGNOSTICS_FLAG] === '1';
}

export function emitElectrobunDiagnosticsBeacon(payload: string): void {
	if (!isElectrobunDiagnosticsEnabled()) {
		return;
	}

	const origin = globalThis.location?.origin;
	if (!origin || typeof fetch !== 'function') {
		return;
	}

	void fetch(`${origin}/DIAGNOSTICS?data=${encodeURIComponent(payload)}`).catch(() => undefined);
}
