/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DidChangeProfilesEvent, IUserDataProfile } from '../../common/userDataProfile.js';
import { UserDataProfilesService } from '../../common/userDataProfileIpc.js';

class TestChannel implements IChannel {
	constructor(private readonly eventPayload: DidChangeProfilesEvent | undefined) { }

	call<T>(_command: string, _arg?: any): Promise<T> {
		throw new Error('Unexpected call');
	}

	listen<T>(event: string): Event<T> {
		switch (event) {
			case 'onDidChangeProfiles':
				return Event.once(Event.of(this.eventPayload as T));
			case 'onDidResetWorkspaces':
				return Event.None;
		}

		throw new Error(`Unexpected event: ${event}`);
	}
}

suite('UserDataProfileIpc', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tolerates missing profile arrays from IPC events', async () => {
		const defaultProfile = {
			id: 'default',
			isDefault: true,
			name: 'Default',
			location: URI.file('/tmp/default'),
			globalStorageHome: URI.file('/tmp/default/globalStorage'),
			settingsResource: URI.file('/tmp/default/settings.json'),
			keybindingsResource: URI.file('/tmp/default/keybindings.json'),
			tasksResource: URI.file('/tmp/default/tasks.json'),
			snippetsHome: URI.file('/tmp/default/snippets'),
			promptsHome: URI.file('/tmp/default/prompts'),
			extensionsResource: URI.file('/tmp/default/extensions.json'),
			mcpResource: URI.file('/tmp/default/mcp.json'),
			cacheHome: URI.file('/tmp/default/cache'),
			useDefaultFlags: undefined
		} satisfies IUserDataProfile;

		const service = new UserDataProfilesService([defaultProfile], URI.file('/tmp/profilesHome'), new TestChannel({
			all: undefined as unknown as IUserDataProfile[],
			added: undefined as unknown as IUserDataProfile[],
			removed: undefined as unknown as IUserDataProfile[],
			updated: undefined as unknown as IUserDataProfile[]
		}));

		const event = await Event.toPromise(service.onDidChangeProfiles);
		assert.deepStrictEqual(event.added, []);
		assert.deepStrictEqual(event.removed, []);
		assert.deepStrictEqual(event.updated, []);
		assert.strictEqual(service.profiles.length, 1);
		assert.strictEqual(service.defaultProfile.settingsResource.fsPath, '/tmp/default/settings.json');

		service.dispose();
	});
});
