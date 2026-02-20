/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PolicyUpdate, Watcher } from '@vscode/policy-watcher';
import { Throttler } from '../../../base/common/async.js';
import { IStringDictionary } from '../../../base/common/collections.js';
import { MutableDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import {
	AbstractPolicyService,
	IPolicyService,
	PolicyDefinition,
	PolicyValue,
} from '../common/policy.js';

export class NativePolicyService
	extends AbstractPolicyService
	implements IPolicyService {
	private throttler = this._register(new Throttler());
	private readonly watcher = this._register(new MutableDisposable<Watcher>());

	constructor(
		@ILogService private readonly logService: ILogService,
		private readonly productName: string,
	) {
		super();
	}

	protected async _updatePolicyDefinitions(
		policyDefinitions: IStringDictionary<PolicyDefinition>,
	): Promise<void> {
		this.logService.trace(
			`NativePolicyService#_updatePolicyDefinitions - Found ${Object.keys(policyDefinitions).length} policy definitions`,
		);

		let createWatcher: typeof import('@vscode/policy-watcher').createWatcher;
		try {
			const mod = await import('@vscode/policy-watcher');
			createWatcher = mod.createWatcher;
		} catch (e) {
			this.logService.warn(
				`NativePolicyService#_updatePolicyDefinitions - Error loading watcher natively:`,
				e,
			);
			createWatcher = (productName, definitions, updateCallback) => {
				const initialPolicyUpdate: PolicyUpdate<IStringDictionary<PolicyDefinition>> = {};
				updateCallback(initialPolicyUpdate);
				return { dispose: () => { } };
			};
		}

		await this.throttler.queue(
			() =>
				new Promise<void>((c, e) => {
					try {
						this.watcher.value = createWatcher(
							this.productName,
							policyDefinitions,
							(update) => {
								this._onDidPolicyChange(update);
								c();
							},
						);
					} catch (err) {
						this.logService.error(
							`NativePolicyService#_updatePolicyDefinitions - Error creating watcher:`,
							err,
						);
						e(err);
					}
				}),
		);
	}

	private _onDidPolicyChange(
		update: PolicyUpdate<IStringDictionary<PolicyDefinition>>,
	): void {
		this.logService.trace(
			`NativePolicyService#_onDidPolicyChange - Updated policy values: ${JSON.stringify(update)}`,
		);

		for (const key in update as Record<string, PolicyValue | undefined>) {
			const value = update[key];

			if (value === undefined) {
				this.policies.delete(key);
			} else {
				this.policies.set(key, value);
			}
		}

		this._onDidChange.fire(Object.keys(update));
	}
}
