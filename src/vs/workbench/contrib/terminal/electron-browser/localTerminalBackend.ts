/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { IProcessEnvironment, isMacintosh, isWindows, OperatingSystem } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILocalPtyService, IProcessDataEvent, IProcessPropertyMap, IPtyHostLatencyMeasurement, IPtyService, IShellLaunchConfig, ITerminalBackend, ITerminalBackendRegistry, ITerminalChildProcess, ITerminalEnvironment, ITerminalLogService, ITerminalProcessOptions, ITerminalsLayoutInfo, ITerminalsLayoutInfoById, ProcessPropertyType, TerminalExtensions, TerminalIpcChannels, TerminalSettingId, TitleEventSource } from '../../../../platform/terminal/common/terminal.js';
import { IGetTerminalLayoutInfoArgs, IProcessDetails, ISetTerminalLayoutInfoArgs } from '../../../../platform/terminal/common/terminalProcess.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalInstanceService } from '../browser/terminal.js';
import { ITerminalProfileResolverService } from '../common/terminal.js';
import { TerminalStorageKeys } from '../common/terminalStorageKeys.js';
import { LocalPty } from './localPty.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IShellEnvironmentService } from '../../../services/environment/electron-browser/shellEnvironmentService.js';
import { IHistoryService } from '../../../services/history/common/history.js';
import * as terminalEnvironment from '../common/terminalEnvironment.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IEnvironmentVariableService } from '../common/environmentVariable.js';
import { BaseTerminalBackend } from '../browser/baseTerminalBackend.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { Client as MessagePortClient } from '../../../../base/parts/ipc/common/ipc.mp.js';
import { acquirePort } from '../../../../base/parts/ipc/electron-browser/ipc.mp.js';
import { getDelayedChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { mark, PerformanceMark } from '../../../../base/common/performance.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { memoize } from '../../../../base/common/decorators.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { shouldUseEnvironmentVariableCollection } from '../../../../platform/terminal/common/terminalEnvironment.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';

export class LocalTerminalBackendContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.localTerminalBackend';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService
	) {
		const backend = instantiationService.createInstance(LocalTerminalBackend);
		Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).registerTerminalBackend(backend);
		terminalInstanceService.didRegisterBackend(backend);
	}
}

class LocalTerminalBackend extends BaseTerminalBackend implements ITerminalBackend {
	readonly remoteAuthority = undefined;

	private readonly _ptys: Map<number, LocalPty> = new Map();
	private readonly _isElectrobunRuntime = (() => {
		const maybeWindow = globalThis as typeof globalThis & { __electrobunInternalBridge?: unknown; __electrobunWindowId?: unknown };
		return Boolean(
			process.env['VSCODE_DESKTOP_RUNTIME'] === 'electrobun' ||
			process.versions?.['bun'] ||
			maybeWindow.__electrobunInternalBridge ||
			typeof maybeWindow.__electrobunWindowId === 'number'
		);
	})();
	private _isIndirectProxyConnected = false;
	private _pendingCreateProcessCount = 0;
	private readonly _pendingPtyIds = new Set<number>();
	private readonly _earlyPtyEventQueue: {
		type: 'data' | 'property' | 'exit' | 'ready' | 'replay' | 'orphan';
		id: number | undefined;
		payload?: unknown;
	}[] = [];
	private _lastKnownPtyId: number | undefined;
	private readonly _enableElectrobunPtyDiag = process.env['VSCODE_ELECTROBUN_PTY_DIAG'] === '1';

	private _directProxyClientEventually: DeferredPromise<MessagePortClient> | undefined;
	private _directProxy: IPtyService | undefined;
	private readonly _directProxyDisposables = this._register(new MutableDisposable());

	/**
	 * Communicate to the direct proxy (renderer<->ptyhost) if it's available, otherwise use the
	 * indirect proxy (renderer<->main<->ptyhost). The latter may not need to actually launch the
	 * pty host, for example when detecting profiles.
	 */
	private get _proxy(): IPtyService { return this._directProxy || this._localPtyService; }

	private readonly _whenReady = new DeferredPromise<void>();
	get whenReady(): Promise<void> { return this._whenReady.p; }
	setReady(): void { this._whenReady.complete(); }

	private readonly _onDidRequestDetach = this._register(new Emitter<{ requestId: number; workspaceId: string; instanceId: number }>());
	readonly onDidRequestDetach = this._onDidRequestDetach.event;

	constructor(
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@ITerminalLogService logService: ITerminalLogService,
		@ILocalPtyService private readonly _localPtyService: ILocalPtyService,
		@ILabelService private readonly _labelService: ILabelService,
		@IShellEnvironmentService private readonly _shellEnvironmentService: IShellEnvironmentService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationResolverService private readonly _configurationResolverService: IConfigurationResolverService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IProductService private readonly _productService: IProductService,
		@IHistoryService private readonly _historyService: IHistoryService,
		@ITerminalProfileResolverService private readonly _terminalProfileResolverService: ITerminalProfileResolverService,
		@IEnvironmentVariableService private readonly _environmentVariableService: IEnvironmentVariableService,
		@IHistoryService historyService: IHistoryService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IStatusbarService statusBarService: IStatusbarService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
	) {
		super(_localPtyService, logService, historyService, _configurationResolverService, statusBarService, workspaceContextService);

		this._register(this.onPtyHostRestart(() => {
			// When running via the renderer->main->ptyhost fallback, the proxy object
			// stays stable across pty host starts. Rebinding listeners here can race
			// with initial process events and drop ready/data notifications.
			if (this._isIndirectProxyConnected && !this._directProxy) {
				this._logService.trace('Renderer->PtyHost#connect: keeping indirect channel on pty host restart');
				return;
			}
			this._directProxy = undefined;
			this._directProxyClientEventually = undefined;
			this._isIndirectProxyConnected = false;
			this._connectToDirectProxy();
		}));
	}

	/**
	 * Request a direct connection to the pty host, this will launch the pty host process if necessary.
	 */
	private async _connectToDirectProxy(): Promise<void> {
		if (this._isElectrobunRuntime && process.env['VSCODE_ELECTROBUN_ENABLE_DIRECT_PTY'] !== 'true') {
			this._ensureIndirectProxyConnected('electrobun-runtime');
			return;
		}

		// Check if connecting is in progress
		if (this._directProxyClientEventually) {
			await this._directProxyClientEventually.p;
			return;
		}

		this._logService.debug('Starting pty host');
		const directProxyClientEventually = new DeferredPromise<MessagePortClient>();
		this._directProxyClientEventually = directProxyClientEventually;
		const directProxy = ProxyChannel.toService<IPtyService>(getDelayedChannel(this._directProxyClientEventually.p.then(client => client.getChannel(TerminalIpcChannels.PtyHostWindow))));
		this._directProxy = directProxy;
		this._directProxyDisposables.clear();

		// The pty host should not get launched until at least the window restored phase
		// if remote auth exists, don't await
		if (!this._remoteAgentService.getConnection()?.remoteAuthority) {
			await this._lifecycleService.when(LifecyclePhase.Restored);
		}

		mark('code/terminal/willConnectPtyHost');
		this._logService.trace('Renderer->PtyHost#connect: before acquirePort');
		acquirePort('vscode:createPtyHostMessageChannel', 'vscode:createPtyHostMessageChannelResult').then(port => {
			mark('code/terminal/didConnectPtyHost');
			this._logService.trace('Renderer->PtyHost#connect: connection established');

			const store = new DisposableStore();
			this._directProxyDisposables.value = store;

			// There are two connections to the pty host; one to the regular shared process
			// _localPtyService, and one directly via message port _ptyHostDirectProxy. The former is
			// used for pty host management messages, it would make sense in the future to use a
			// separate interface/service for this one.
			const client = store.add(new MessagePortClient(port, `window:${this._nativeHostService.windowId}`));
			directProxyClientEventually.complete(client);
			this._onPtyHostConnected.fire();

			this._attachPtyServiceListeners(directProxy, store);

			// Eagerly fetch the backend's environment for memoization
			this.getEnvironment();
		}).catch(error => {
			this._logService.error('Renderer->PtyHost#connect: failed to acquire MessagePort', error);
			directProxyClientEventually.error(error);
			this._directProxyClientEventually = undefined;
			this._directProxy = undefined;
			this._ensureIndirectProxyConnected('direct-messageport-failed', error);
			try {
				void fetch(`${globalThis.location.origin}/DIAGNOSTICS?data=${encodeURIComponent(`PTY_CONNECT_TIMEOUT:${String(error)}`)}`);
			} catch {
				// ignore diagnostic failures
			}
		});
	}

	private _ensureIndirectProxyConnected(reason: string, error?: unknown): void {
		if (this._isIndirectProxyConnected) {
			return;
		}

		this._logService.warn(`Renderer->PtyHost#connect: using indirect renderer->main->ptyhost channel (${reason})`);
		if (error) {
			this._logService.debug('Renderer->PtyHost#connect: indirect fallback cause', error);
		}
		this._directProxy = undefined;
		this._directProxyClientEventually = undefined;
		this._directProxyDisposables.clear();
		const store = new DisposableStore();
		this._directProxyDisposables.value = store;
		this._attachPtyServiceListeners(this._localPtyService, store);
		this._isIndirectProxyConnected = true;
		this._onPtyHostConnected.fire();

		// Eagerly fetch the backend's environment for memoization
		void this.getEnvironment();
	}

	private _attachPtyServiceListeners(proxy: IPtyService, store: DisposableStore): void {
		store.add(proxy.onProcessData(e => {
			const pty = this._resolvePtyForEvent(e);
			const payload = this._readEventPayload<IProcessDataEvent | string>(e);
			const id = this._resolvePtyId(this._readEventId(e));
			this._tracePtyDiag('onProcessData', { id: this._readEventId(e), hasPty: Boolean(pty), payloadType: typeof payload });
			if (pty && payload !== undefined) {
				pty.handleData(payload);
			} else if (payload !== undefined) {
				this._queueEarlyPtyEvent('data', id, payload);
			}
		}));
		store.add(proxy.onDidChangeProperty(e => {
			const pty = this._resolvePtyForEvent(e);
			const property = this._readEventPayload<{ type: ProcessPropertyType; value: unknown }>(e, 'property') ?? this._readEventPayload<{ type: ProcessPropertyType; value: unknown }>(e);
			const id = this._resolvePtyId(this._readEventId(e));
			this._tracePtyDiag('onDidChangeProperty', { id: this._readEventId(e), hasPty: Boolean(pty), propertyType: property?.type });
			if (pty && property) {
				pty.handleDidChangeProperty(property);
			} else if (property) {
				this._queueEarlyPtyEvent('property', id, property);
			}
		}));
		store.add(proxy.onProcessExit(e => {
			const pty = this._resolvePtyForEvent(e);
			const id = this._resolvePtyId(this._readEventId(e));
			this._tracePtyDiag('onProcessExit', { id: this._readEventId(e), hasPty: Boolean(pty), raw: this._readEventPayload<unknown>(e) });
			const rawExit = this._readEventPayload<number | { code?: number } | undefined>(e);
			const exitCode = typeof rawExit === 'number'
				? rawExit
				: (rawExit && typeof rawExit === 'object' && typeof rawExit.code === 'number' ? rawExit.code : undefined);
			if (!pty) {
				this._queueEarlyPtyEvent('exit', id, exitCode);
				return;
			}
			pty.handleExit(exitCode);
			pty.dispose();
			this._ptys.delete(pty.id);
		}));
		store.add(proxy.onProcessReady(e => {
			const pty = this._resolvePtyForEvent(e);
			const ready = this._coerceReadyEvent(this._readEventPayload<unknown>(e));
			const id = this._resolvePtyId(this._readEventId(e));
			this._tracePtyDiag('onProcessReady', { id: this._readEventId(e), hasPty: Boolean(pty), raw: this._readEventPayload<unknown>(e), ready });
			if (pty && ready) {
				pty.handleReady(ready);
			} else if (ready) {
				this._queueEarlyPtyEvent('ready', id, ready);
			}
		}));
		store.add(proxy.onProcessReplay(e => {
			const pty = this._resolvePtyForEvent(e);
			const payload = this._readEventPayload<{ events: { cols: number; rows: number; data: string }[]; commands?: unknown }>(e);
			const id = this._resolvePtyId(this._readEventId(e));
			this._tracePtyDiag('onProcessReplay', { id: this._readEventId(e), hasPty: Boolean(pty), hasPayload: Boolean(payload) });
			if (pty && payload) {
				void pty.handleReplay(payload);
			} else if (payload) {
				this._queueEarlyPtyEvent('replay', id, payload);
			}
		}));
		store.add(proxy.onProcessOrphanQuestion(e => {
			const pty = this._resolvePtyForEvent(e);
			if (pty) {
				pty.handleOrphanQuestion();
				return;
			}
			this._queueEarlyPtyEvent('orphan', this._resolvePtyId(this._readEventId(e)));
		}));
		store.add(proxy.onDidRequestDetach(e => {
			const payload = this._readEventPayload<{ requestId: number; workspaceId: string; instanceId: number }>(e);
			if (payload) {
				this._onDidRequestDetach.fire(payload);
			}
		}));
	}

	private _queueEarlyPtyEvent(type: 'data' | 'property' | 'exit' | 'ready' | 'replay' | 'orphan', id: number | undefined, payload?: unknown): void {
		const shouldQueueForSpecificId = id !== undefined && this._pendingPtyIds.has(id);
		if (!shouldQueueForSpecificId && this._pendingCreateProcessCount <= 0) {
			return;
		}
		if (this._earlyPtyEventQueue.length > 2048) {
			this._earlyPtyEventQueue.shift();
		}
		this._earlyPtyEventQueue.push({ type, id, payload });
		this._tracePtyDiag('queueEarlyPtyEvent', { type, id, queueLength: this._earlyPtyEventQueue.length });
	}

	private _flushEarlyPtyEvents(id: number, pty: LocalPty): void {
		if (this._earlyPtyEventQueue.length === 0) {
			return;
		}

		let replayed = 0;
		const remaining: typeof this._earlyPtyEventQueue = [];
		for (const entry of this._earlyPtyEventQueue) {
			if (entry.id !== undefined && entry.id !== id) {
				remaining.push(entry);
				continue;
			}

			replayed++;
			switch (entry.type) {
				case 'data':
					if (entry.payload !== undefined) {
						pty.handleData(entry.payload as IProcessDataEvent | string);
					}
					break;
				case 'property':
					if (entry.payload) {
						pty.handleDidChangeProperty(entry.payload as { type: ProcessPropertyType; value: unknown });
					}
					break;
				case 'ready':
					if (entry.payload) {
						pty.handleReady(entry.payload as { pid: number; cwd: string; windowsPty?: unknown });
					}
					break;
				case 'replay':
					if (entry.payload) {
						void pty.handleReplay(entry.payload as { events: { cols: number; rows: number; data: string }[]; commands?: unknown });
					}
					break;
				case 'orphan':
					pty.handleOrphanQuestion();
					break;
				case 'exit': {
					const exitCode = entry.payload as number | undefined;
					pty.handleExit(exitCode);
					pty.dispose();
					this._ptys.delete(pty.id);
					break;
				}
			}
		}

		this._earlyPtyEventQueue.length = 0;
		this._earlyPtyEventQueue.push(...remaining);
		if (replayed > 0) {
			this._tracePtyDiag('flushEarlyPtyEvents', { id, replayed, remaining: remaining.length });
		}
	}

	private _resolvePtyId(value: unknown): number | undefined {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string' && value.length > 0) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
		return undefined;
	}

	private _readEventId(event: unknown): unknown {
		if (Array.isArray(event)) {
			if (event.length === 1 && event[0] && typeof event[0] === 'object') {
				const wrapped = event[0] as { id?: unknown; processId?: unknown; persistentProcessId?: unknown; event?: { id?: unknown; processId?: unknown; persistentProcessId?: unknown } } & Record<string, unknown>;
				return wrapped.id
					?? wrapped.processId
					?? wrapped.persistentProcessId
					?? wrapped.event?.id
					?? wrapped.event?.processId
					?? wrapped.event?.persistentProcessId
					?? wrapped['0'];
			}
			return event[0];
		}
		if (event && typeof event === 'object') {
			const candidate = event as { id?: unknown; processId?: unknown; persistentProcessId?: unknown; event?: { id?: unknown; processId?: unknown; persistentProcessId?: unknown } } & Record<string, unknown>;
			return candidate.id
				?? candidate.processId
				?? candidate.persistentProcessId
				?? candidate.event?.id
				?? candidate.event?.processId
				?? candidate.event?.persistentProcessId
				?? candidate['0'];
		}
		return undefined;
	}

	private _readEventPayload<T>(event: unknown, propertyKey: string = 'event'): T | undefined {
		if (Array.isArray(event)) {
			if (event.length === 1 && event[0] && typeof event[0] === 'object') {
				const wrapped = event[0] as Record<string, unknown>;
				if (Object.prototype.hasOwnProperty.call(wrapped, propertyKey)) {
					return wrapped[propertyKey] as T;
				}
				if (Object.prototype.hasOwnProperty.call(wrapped, '1')) {
					return wrapped['1'] as T;
				}
				if (propertyKey === 'event' || propertyKey === 'property') {
					return wrapped as T;
				}
				return undefined;
			}
			return event[1] as T;
		}
		if (event && typeof event === 'object') {
			const wrapped = event as Record<string, unknown>;
			if (Object.prototype.hasOwnProperty.call(wrapped, propertyKey)) {
				return wrapped[propertyKey] as T;
			}
			if (Object.prototype.hasOwnProperty.call(wrapped, '1')) {
				return wrapped['1'] as T;
			}
			if (propertyKey === 'event' || propertyKey === 'property') {
				return wrapped as T;
			}
			return undefined;
		}
		return event as T;
	}

	private _coerceReadyEvent(event: unknown): { pid: number; cwd: string; windowsPty?: unknown } | undefined {
		if (!event || typeof event !== 'object') {
			return undefined;
		}

		const candidate = event as {
			pid?: unknown;
			processId?: unknown;
			cwd?: unknown;
			initialCwd?: unknown;
			currentWorkingDirectory?: unknown;
			windowsPty?: unknown;
			event?: unknown;
		};

		if (candidate.event && typeof candidate.event === 'object') {
			const nested = this._coerceReadyEvent(candidate.event);
			if (nested) {
				return nested;
			}
		}

		const pid = typeof candidate.pid === 'number'
			? candidate.pid
			: (typeof candidate.processId === 'number' ? candidate.processId : undefined);
		if (typeof pid !== 'number') {
			return undefined;
		}

		return {
			pid,
			cwd: typeof candidate.cwd === 'string'
				? candidate.cwd
				: (typeof candidate.initialCwd === 'string'
					? candidate.initialCwd
					: (typeof candidate.currentWorkingDirectory === 'string' ? candidate.currentWorkingDirectory : '')),
			windowsPty: candidate.windowsPty
		};
	}

	private _resolvePtyForEvent(event: unknown): LocalPty | undefined {
		const normalizedId = this._resolvePtyId(this._readEventId(event));
		if (normalizedId !== undefined) {
			const pty = this._ptys.get(normalizedId);
			if (pty) {
				return pty;
			}
		}

		// Electrobun can occasionally drop tuple id wrappers. If only one terminal
		// exists, route events to it so ready/pid metadata is not lost.
		if (this._ptys.size === 1) {
			const only = this._ptys.values().next().value as LocalPty | undefined;
			this._tracePtyDiag('resolvePtyFallbackSingle', { normalizedId, fallbackId: only?.id });
			return only;
		}

		this._tracePtyDiag('resolvePtyMiss', { normalizedId, event });
		return undefined;
	}

	private _tracePtyDiag(label: string, value: unknown): void {
		if (!this._enableElectrobunPtyDiag) {
			return;
		}

		try {
			this._logService.warn(`[ElectrobunPTY] ${label} ${JSON.stringify(value)}`);
		} catch {
			this._logService.warn(`[ElectrobunPTY] ${label}`);
		}
	}

	async requestDetachInstance(workspaceId: string, instanceId: number): Promise<IProcessDetails | undefined> {
		return this._proxy.requestDetachInstance(workspaceId, instanceId);
	}

	async acceptDetachInstanceReply(requestId: number, persistentProcessId?: number): Promise<void> {
		if (!persistentProcessId) {
			this._logService.warn('Cannot attach to feature terminals, custom pty terminals, or those without a persistentProcessId');
			return;
		}
		return this._proxy.acceptDetachInstanceReply(requestId, persistentProcessId);
	}

	async persistTerminalState(): Promise<void> {
		const ids = Array.from(this._ptys.keys());
		const serialized = await this._proxy.serializeTerminalState(ids);
		this._storageService.store(TerminalStorageKeys.TerminalBufferState, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async updateTitle(id: number, title: string, titleSource: TitleEventSource): Promise<void> {
		await this._proxy.updateTitle(id, title, titleSource);
	}

	async updateIcon(id: number, userInitiated: boolean, icon: URI | { light: URI; dark: URI } | { id: string; color?: { id: string } }, color?: string): Promise<void> {
		await this._proxy.updateIcon(id, userInitiated, icon, color);
	}

	async setNextCommandId(id: number, commandLine: string, commandId: string): Promise<void> {
		await this._proxy.setNextCommandId(id, commandLine, commandId);
	}

	async updateProperty<T extends ProcessPropertyType>(id: number, property: ProcessPropertyType, value: IProcessPropertyMap[T]): Promise<void> {
		return this._proxy.updateProperty(id, property, value);
	}

	async createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		unicodeVersion: '6' | '11',
		env: IProcessEnvironment,
		options: ITerminalProcessOptions,
		shouldPersist: boolean
	): Promise<ITerminalChildProcess> {
		await this._connectToDirectProxy();
		const executableEnv = await this._shellEnvironmentService.getShellEnv();
		let id: number;
		try {
			let createdId: unknown;
			this._pendingCreateProcessCount++;
			try {
				createdId = await this._proxy.createProcess(shellLaunchConfig, cwd, cols, rows, unicodeVersion, env, executableEnv, options, shouldPersist, this._getWorkspaceId(), this._getWorkspaceName());
			} finally {
				this._pendingCreateProcessCount = Math.max(0, this._pendingCreateProcessCount - 1);
			}
			const normalizedId = this._resolvePtyId(createdId);
			if (normalizedId === undefined) {
				throw new Error(`Invalid pty id received from host: ${String(createdId)}`);
			}
			id = normalizedId;
			this._pendingPtyIds.add(id);
		} catch (error) {
			this._logService.error('Renderer->PtyHost#createProcess failed', error);
			throw error;
		}
		const pty = new LocalPty(id, shouldPersist, this._proxy);
		this._ptys.set(id, pty);
		this._pendingPtyIds.delete(id);
		this._lastKnownPtyId = id;
		this._flushEarlyPtyEvents(id, pty);
		return pty;
	}

	async attachToProcess(id: number): Promise<ITerminalChildProcess | undefined> {
		await this._connectToDirectProxy();
		try {
			const normalizedId = this._resolvePtyId(id);
			if (normalizedId === undefined) {
				return undefined;
			}
			await this._proxy.attachToProcess(normalizedId);
			const pty = new LocalPty(normalizedId, true, this._proxy);
			this._pendingPtyIds.add(normalizedId);
			this._ptys.set(normalizedId, pty);
			this._pendingPtyIds.delete(normalizedId);
			this._lastKnownPtyId = normalizedId;
			this._flushEarlyPtyEvents(normalizedId, pty);
			return pty;
		} catch (e) {
			this._logService.warn(`Couldn't attach to process ${e.message}`);
		}
		return undefined;
	}

	async attachToRevivedProcess(id: number): Promise<ITerminalChildProcess | undefined> {
		await this._connectToDirectProxy();
		try {
			const newId = await this._proxy.getRevivedPtyNewId(this._getWorkspaceId(), id) ?? id;
			return await this.attachToProcess(newId);
		} catch (e) {
			this._logService.warn(`Couldn't attach to process ${e.message}`);
		}
		return undefined;
	}

	async listProcesses(): Promise<IProcessDetails[]> {
		await this._connectToDirectProxy();
		return this._proxy.listProcesses();
	}

	async getLatency(): Promise<IPtyHostLatencyMeasurement[]> {
		const measurements: IPtyHostLatencyMeasurement[] = [];
		const sw = new StopWatch();
		if (this._directProxy) {
			await this._directProxy.getLatency();
			sw.stop();
			measurements.push({
				label: 'window<->ptyhost (message port)',
				latency: sw.elapsed()
			});
			sw.reset();
		}
		const results = await this._localPtyService.getLatency();
		sw.stop();
		measurements.push({
			label: 'window<->ptyhostservice<->ptyhost',
			latency: sw.elapsed()
		});
		return [
			...measurements,
			...results
		];
	}

	async getPerformanceMarks(): Promise<PerformanceMark[]> {
		try {
			return await this._proxy.getPerformanceMarks();
		} catch (error) {
			// Avoid blocking terminal backend readiness if pty host warmup races under Electrobun.
			this._logService.error('Renderer->PtyHost#getPerformanceMarks failed', error);
			return [];
		}
	}

	async reduceConnectionGraceTime(): Promise<void> {
		this._proxy.reduceConnectionGraceTime();
	}

	async getDefaultSystemShell(osOverride?: OperatingSystem): Promise<string> {
		return this._proxy.getDefaultSystemShell(osOverride);
	}

	async getProfiles(profiles: unknown, defaultProfile: unknown, includeDetectedProfiles?: boolean) {
		try {
			return await this._localPtyService.getProfiles(this._workspaceContextService.getWorkspace().id, profiles, defaultProfile, includeDetectedProfiles) || [];
		} catch (error) {
			this._logService.error('Renderer->PtyHost#getProfiles failed', error);
			return [];
		}
	}

	@memoize
	async getEnvironment(): Promise<IProcessEnvironment> {
		return this._proxy.getEnvironment();
	}

	@memoize
	async getShellEnvironment(): Promise<IProcessEnvironment> {
		return this._shellEnvironmentService.getShellEnv();
	}

	async getWslPath(original: string, direction: 'unix-to-win' | 'win-to-unix'): Promise<string> {
		return this._proxy.getWslPath(original, direction);
	}

	async setTerminalLayoutInfo(layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {
		const args: ISetTerminalLayoutInfoArgs = {
			workspaceId: this._getWorkspaceId(),
			tabs: layoutInfo ? layoutInfo.tabs : [],
			background: layoutInfo ? layoutInfo.background : null
		};
		await this._proxy.setTerminalLayoutInfo(args);
		// Store in the storage service as well to be used when reviving processes as normally this
		// is stored in memory on the pty host
		this._storageService.store(TerminalStorageKeys.TerminalLayoutInfo, JSON.stringify(args), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
		const workspaceId = this._getWorkspaceId();
		const layoutArgs: IGetTerminalLayoutInfoArgs = { workspaceId };

		// Revive processes if needed
		const serializedState = this._storageService.get(TerminalStorageKeys.TerminalBufferState, StorageScope.WORKSPACE);
		const reviveBufferState = this._deserializeTerminalState(serializedState);
		if (reviveBufferState && reviveBufferState.length > 0) {
			try {
				// Create variable resolver
				const activeWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot();
				const lastActiveWorkspace = activeWorkspaceRootUri ? this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri) ?? undefined : undefined;
				const variableResolver = terminalEnvironment.createVariableResolver(lastActiveWorkspace, await this._terminalProfileResolverService.getEnvironment(this.remoteAuthority), this._configurationResolverService);

				// Re-resolve the environments and replace it on the state so local terminals use a fresh
				// environment
				mark('code/terminal/willGetReviveEnvironments');
				await Promise.all(reviveBufferState.map(state => new Promise<void>(r => {
					this._resolveEnvironmentForRevive(variableResolver, state.shellLaunchConfig).then(freshEnv => {
						state.processLaunchConfig.env = freshEnv;
						r();
					});
				})));
				mark('code/terminal/didGetReviveEnvironments');

				mark('code/terminal/willReviveTerminalProcesses');
				await this._proxy.reviveTerminalProcesses(workspaceId, reviveBufferState, Intl.DateTimeFormat().resolvedOptions().locale);
				mark('code/terminal/didReviveTerminalProcesses');
				this._storageService.remove(TerminalStorageKeys.TerminalBufferState, StorageScope.WORKSPACE);
				// If reviving processes, send the terminal layout info back to the pty host as it
				// will not have been persisted on application exit
				const layoutInfo = this._storageService.get(TerminalStorageKeys.TerminalLayoutInfo, StorageScope.WORKSPACE);
				if (layoutInfo) {
					mark('code/terminal/willSetTerminalLayoutInfo');
					await this._proxy.setTerminalLayoutInfo(JSON.parse(layoutInfo));
					mark('code/terminal/didSetTerminalLayoutInfo');
					this._storageService.remove(TerminalStorageKeys.TerminalLayoutInfo, StorageScope.WORKSPACE);
				}
			} catch (e: unknown) {
				this._logService.warn('LocalTerminalBackend#getTerminalLayoutInfo Error', (<{ message?: string }>e).message ?? e);
			}
		}

		return this._proxy.getTerminalLayoutInfo(layoutArgs);
	}

	private async _resolveEnvironmentForRevive(variableResolver: terminalEnvironment.VariableResolver | undefined, shellLaunchConfig: IShellLaunchConfig): Promise<IProcessEnvironment> {
		const platformKey = isWindows ? 'windows' : (isMacintosh ? 'osx' : 'linux');
		const envFromConfigValue = this._configurationService.getValue<ITerminalEnvironment | undefined>(`terminal.integrated.env.${platformKey}`);
		const baseEnv = await (shellLaunchConfig.useShellEnvironment ? this.getShellEnvironment() : this.getEnvironment());
		const env = await terminalEnvironment.createTerminalEnvironment(shellLaunchConfig, envFromConfigValue, variableResolver, this._productService.version, this._configurationService.getValue(TerminalSettingId.DetectLocale), baseEnv);
		if (shouldUseEnvironmentVariableCollection(shellLaunchConfig)) {
			const workspaceFolder = terminalEnvironment.getWorkspaceForTerminal(shellLaunchConfig.cwd, this._workspaceContextService, this._historyService);
			await this._environmentVariableService.mergedCollection.applyToProcessEnvironment(env, { workspaceFolder }, variableResolver);
		}
		return env;
	}

	private _getWorkspaceName(): string {
		return this._labelService.getWorkspaceLabel(this._workspaceContextService.getWorkspace());
	}

	// #region Pty service contribution RPC calls

	installAutoReply(match: string, reply: string): Promise<void> {
		return this._proxy.installAutoReply(match, reply);
	}
	uninstallAllAutoReplies(): Promise<void> {
		return this._proxy.uninstallAllAutoReplies();
	}

	// #endregion
}
