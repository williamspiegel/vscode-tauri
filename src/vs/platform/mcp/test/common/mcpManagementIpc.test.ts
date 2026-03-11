/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { NullLogService } from '../../../log/common/log.js';
import { IAllowedMcpServersService, IInstallableMcpServer, ILocalMcpServer, InstallMcpServerResult } from '../../common/mcpManagement.js';
import { McpServerType } from '../../common/mcpPlatformTypes.js';
import { McpManagementChannelClient } from '../../common/mcpManagementIpc.js';

class TestAllowedMcpServersService extends Disposable implements IAllowedMcpServersService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeAllowedMcpServers = Event.None;

	isAllowed(_mcpServer: ILocalMcpServer | IInstallableMcpServer): true {
		return true;
	}
}

class TestChannel implements IChannel {
	private readonly installEmitter = new Emitter<InstallMcpServerResult | null>();
	private readonly didInstallEmitter = new Emitter<readonly (InstallMcpServerResult | null | undefined)[] | null>();
	private readonly didUpdateEmitter = new Emitter<readonly (InstallMcpServerResult | null | undefined)[] | null>();
	private readonly uninstallEmitter = new Emitter<{ name: string; mcpResource: URI } | null>();
	private readonly didUninstallEmitter = new Emitter<{ name: string; mcpResource: URI; error?: string } | null>();

	constructor(private readonly installed: readonly (ILocalMcpServer | null | undefined)[] | null) { }

	call<T>(command: string): Promise<T> {
		if (command === 'getInstalled') {
			return Promise.resolve(this.installed as T);
		}

		throw new Error(`Unexpected command: ${command}`);
	}

	listen<T>(event: string): Event<T> {
		switch (event) {
			case 'onInstallMcpServer':
				return this.installEmitter.event as Event<T>;
			case 'onDidInstallMcpServers':
				return this.didInstallEmitter.event as Event<T>;
			case 'onDidUpdateMcpServers':
				return this.didUpdateEmitter.event as Event<T>;
			case 'onUninstallMcpServer':
				return this.uninstallEmitter.event as Event<T>;
			case 'onDidUninstallMcpServer':
				return this.didUninstallEmitter.event as Event<T>;
		}

		throw new Error(`Unexpected event: ${event}`);
	}

	fireDidInstall(value: readonly (InstallMcpServerResult | null | undefined)[] | null): void {
		this.didInstallEmitter.fire(value);
	}

	fireDidUpdate(value: readonly (InstallMcpServerResult | null | undefined)[] | null): void {
		this.didUpdateEmitter.fire(value);
	}

	override dispose(): void {
		super.dispose();
		this.installEmitter.dispose();
		this.didInstallEmitter.dispose();
		this.didUpdateEmitter.dispose();
		this.uninstallEmitter.dispose();
		this.didUninstallEmitter.dispose();
	}

	fireInstall(value: InstallMcpServerResult | null): void {
		this.installEmitter.fire(value);
	}

	fireUninstall(value: { name: string; mcpResource: URI } | null): void {
		this.uninstallEmitter.fire(value);
	}

	fireDidUninstall(value: { name: string; mcpResource: URI; error?: string } | null): void {
		this.didUninstallEmitter.fire(value);
	}
}

suite('McpManagementIpc', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('getInstalled tolerates null arrays from IPC', async () => {
		const client = new McpManagementChannelClient(new TestChannel(null), new TestAllowedMcpServersService(), new NullLogService());

		await assert.doesNotReject(async () => {
			const servers = await client.getInstalled();
			assert.deepStrictEqual(servers, []);
		});

		client.dispose();
	});

	test('install and update events tolerate null arrays from IPC', () => {
		const channel = new TestChannel([]);
		const client = new McpManagementChannelClient(channel, new TestAllowedMcpServersService(), new NullLogService());
		let installedResults: readonly ILocalMcpServer[] | undefined;
		let updatedResults: readonly ILocalMcpServer[] | undefined;

		const installDisposable = client.onDidInstallMcpServers(results => installedResults = results.map(result => result.local!).filter(Boolean));
		const updateDisposable = client.onDidUpdateMcpServers(results => updatedResults = results.map(result => result.local!).filter(Boolean));

		channel.fireDidInstall(null);
		channel.fireDidUpdate(null);

		assert.deepStrictEqual(installedResults, []);
		assert.deepStrictEqual(updatedResults, []);

		installDisposable.dispose();
		updateDisposable.dispose();
		client.dispose();
		channel.dispose();
	});

	test('install and update events tolerate null entries from IPC', () => {
		const channel = new TestChannel([]);
		const client = new McpManagementChannelClient(channel, new TestAllowedMcpServersService(), new NullLogService());
		let installedCount = -1;
		let updatedCount = -1;

		const installDisposable = client.onDidInstallMcpServers(results => installedCount = results.length);
		const updateDisposable = client.onDidUpdateMcpServers(results => updatedCount = results.length);

		channel.fireDidInstall([null, undefined]);
		channel.fireDidUpdate([undefined, null]);

		assert.strictEqual(installedCount, 0);
		assert.strictEqual(updatedCount, 0);

		installDisposable.dispose();
		updateDisposable.dispose();
		client.dispose();
		channel.dispose();
	});

	test('getInstalled tolerates null entries from IPC', async () => {
		const client = new McpManagementChannelClient(new TestChannel([null, undefined]), new TestAllowedMcpServersService(), new NullLogService());

		await assert.doesNotReject(async () => {
			const servers = await client.getInstalled();
			assert.deepStrictEqual(servers, []);
		});

		client.dispose();
	});

	test('single-object events tolerate null payloads from IPC', () => {
		const channel = new TestChannel([]);
		const client = new McpManagementChannelClient(channel, new TestAllowedMcpServersService(), new NullLogService());
		let installCount = 0;
		let uninstallCount = 0;
		let didUninstallCount = 0;

		const installDisposable = client.onInstallMcpServer(() => installCount++);
		const uninstallDisposable = client.onUninstallMcpServer(() => uninstallCount++);
		const didUninstallDisposable = client.onDidUninstallMcpServer(() => didUninstallCount++);

		channel.fireInstall(null);
		channel.fireUninstall(null);
		channel.fireDidUninstall(null);

		assert.strictEqual(installCount, 0);
		assert.strictEqual(uninstallCount, 0);
		assert.strictEqual(didUninstallCount, 0);

		installDisposable.dispose();
		uninstallDisposable.dispose();
		didUninstallDisposable.dispose();
		client.dispose();
		channel.dispose();
	});

	test('getInstalled still revives valid servers', async () => {
		const server: ILocalMcpServer = {
			name: 'test-server',
			source: 'local',
			mcpResource: URI.file('/tmp/mcp.json'),
			config: {
				type: McpServerType.LOCAL,
				command: 'node',
				args: ['server.js']
			}
		};
		const client = new McpManagementChannelClient(new TestChannel([server]), new TestAllowedMcpServersService(), new NullLogService());

		const servers = await client.getInstalled();
		assert.strictEqual(servers.length, 1);
		assert.strictEqual(servers[0].name, 'test-server');
		assert.strictEqual(servers[0].mcpResource.fsPath, '/tmp/mcp.json');

		client.dispose();
	});
});
