import { HostClient } from './hostClient';
import { createDesktopChannelRegistry, DesktopChannelRegistry } from './desktopChannels';

type IpcListener = (event: { sender: unknown }, ...args: unknown[]) => void;

type EventSubscription = {
  listener: IpcListener;
  thisArgs: unknown;
};

interface DisposableLike {
  dispose(): void;
}

interface WindowWithVscode extends Window {
  vscode?: unknown;
  _VSCODE_USE_RELATIVE_IMPORTS?: boolean;
  _VSCODE_DISABLE_CSS_IMPORT_MAP?: boolean;
  __VSCODE_DESKTOP_SANDBOX_MODULE_OVERRIDES__?: {
    event?: string;
    buffer?: string;
    ipc?: string;
  };
}

interface UriComponents {
  scheme: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

interface SingleFolderWorkspaceIdentifier {
  id: string;
  uri: UriComponents;
}

interface MultiRootWorkspaceIdentifier {
  id: string;
  configPath: UriComponents;
}

type WorkspaceIdentifier = SingleFolderWorkspaceIdentifier | MultiRootWorkspaceIdentifier;

function getRendererIpcModulePaths(): { eventModulePath: string; bufferModulePath: string; ipcModulePath: string } {
  const win = window as WindowWithVscode;
  const overrides = win.__VSCODE_DESKTOP_SANDBOX_MODULE_OVERRIDES__;

  return {
    eventModulePath: typeof overrides?.event === 'string' ? overrides.event : '/out/vs/base/common/event.js',
    bufferModulePath: typeof overrides?.buffer === 'string' ? overrides.buffer : '/out/vs/base/common/buffer.js',
    ipcModulePath: typeof overrides?.ipc === 'string' ? overrides.ipc : '/out/vs/base/parts/ipc/common/ipc.js'
  };
}

function getRendererLifecycleModulePath(): string {
  return getRendererIpcModulePaths().eventModulePath.replace(/event\.js$/, 'lifecycle.js');
}

function getRendererIpcMessagePortModulePath(): string {
  return getRendererIpcModulePaths().ipcModulePath.replace(/ipc\.js$/, 'ipc.mp.js');
}

const ENVIRONMENT_VARIABLE_MUTATOR_TYPE_REPLACE = 1;
const ENVIRONMENT_VARIABLE_MUTATOR_TYPE_APPEND = 2;
const ENVIRONMENT_VARIABLE_MUTATOR_TYPE_PREPEND = 3;

type SerializableEnvironmentMutator = {
  variable?: unknown;
  value?: unknown;
  type?: unknown;
  options?: {
    applyAtProcessCreation?: unknown;
  };
};

function numberHash(value: number, hashValue: number): number {
  return (((hashValue << 5) - hashValue) + value) | 0;
}

function stringHash(value: string, hashValue = 0): number {
  hashValue = numberHash(149417, hashValue);
  for (let index = 0; index < value.length; index++) {
    hashValue = numberHash(value.charCodeAt(index), hashValue);
  }
  return hashValue;
}

function getWorkspaceId(value: string): string {
  return stringHash(value).toString(16);
}

function toFileUriComponents(path: string): UriComponents {
  const normalized = path.replace(/\\/g, '/');
  return {
    scheme: 'file',
    authority: '',
    path: normalized.startsWith('/') ? normalized : `/${normalized}`
  };
}

function tryParseUriComponents(value: string): UriComponents | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith('/')) {
    return toFileUriComponents(value);
  }

  try {
    const parsed = new URL(value);
    return {
      scheme: parsed.protocol.replace(/:$/, ''),
      authority: parsed.host,
      path: decodeURIComponent(parsed.pathname),
      query: parsed.search ? parsed.search.slice(1) : undefined,
      fragment: parsed.hash ? parsed.hash.slice(1) : undefined
    };
  } catch {
    return toFileUriComponents(value);
  }
}

function workspaceIdentifierFromLocation(): WorkspaceIdentifier | null | undefined {
  const query = new URLSearchParams(window.location.search);

  if (query.has('ew')) {
    return null;
  }

  const workspacePath = query.get('workspace');
  if (workspacePath) {
    const workspaceUri = tryParseUriComponents(workspacePath);
    if (workspaceUri) {
      return {
        id: getWorkspaceId(workspacePath),
        configPath: workspaceUri
      };
    }
  }

  const folderPath = query.get('folder');
  if (!folderPath) {
    return undefined;
  }

  const folderUri = tryParseUriComponents(folderPath);
  if (!folderUri) {
    return undefined;
  }

  return {
    id: getWorkspaceId(folderPath),
    uri: folderUri
  };
}

function applyWorkspaceFromLocation(configuration: Record<string, unknown>): void {
  const workspace = workspaceIdentifierFromLocation();

  if (workspace === undefined) {
    return;
  }

  if (workspace === null) {
    delete configuration.workspace;
    return;
  }

  configuration.workspace = workspace;
}

class RendererChannelServer {
  private channelServer: {
    registerChannel(name: string, channel: unknown): void;
  } | undefined;
  private readyPromise: Promise<void> | undefined;
  private incomingEmitter: {
    event: unknown;
    fire(data: unknown): void;
  } | undefined;

  constructor(
    private readonly host: HostClient,
    private readonly registry: DesktopChannelRegistry,
    private readonly emitIpcMessage: (payload: Uint8Array) => void,
    private readonly windowId: number
  ) {}

	private async ensureReady(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }

		this.readyPromise = (async () => {
			const { eventModulePath, bufferModulePath, ipcModulePath } = getRendererIpcModulePaths();

			const eventModule = (await import(/* @vite-ignore */ eventModulePath)) as {
				Emitter: new () => { event: unknown; fire(data: unknown): void };
			};
			const bufferModule = (await import(/* @vite-ignore */ bufferModulePath)) as {
				VSBuffer: {
					wrap(input: Uint8Array): { buffer: ArrayBufferLike };
				};
			};
			const ipcModule = (await import(/* @vite-ignore */ ipcModulePath)) as {
				ChannelServer: new (
					protocol: { onMessage: unknown; send(message: { buffer: ArrayBufferLike }): void },
					ctx: string
        ) => { registerChannel(name: string, channel: unknown): void };
      };

      const incoming = new eventModule.Emitter();
      this.incomingEmitter = incoming;

      const protocol = {
        onMessage: incoming.event,
        send: (message: { buffer: ArrayBufferLike }) => {
          this.emitIpcMessage(toUint8Array(message.buffer));
        }
      };

      const server = new ipcModule.ChannelServer(protocol, `window:${this.windowId}`);
      this.channelServer = server;

      for (const channel of this.registry.channels) {
        server.registerChannel(channel, {
          call: async (_ctx: unknown, command: string, arg?: unknown) => {
            const args = Array.isArray(arg) ? arg : typeof arg === 'undefined' ? [] : [arg];
            return this.registry.call(channel, command, args);
          },
          listen: (_ctx: unknown, eventName: string, arg?: unknown) => {
            return createHostBackedEvent(this.registry, channel, eventName, arg);
          }
        });
      }

      // Keep buffer module loaded so wrap is available in acceptMessage.
      this.vsBufferWrap = bufferModule.VSBuffer.wrap;
    })();

    return this.readyPromise;
  }

  private vsBufferWrap:
    | ((input: Uint8Array) => { buffer: ArrayBufferLike })
    | undefined;

  async ready(): Promise<void> {
    await this.ensureReady();
  }

  async acceptMessage(payload: unknown): Promise<void> {
    await this.ensureReady();
    if (!this.incomingEmitter || !this.vsBufferWrap) {
      return;
    }

    const bytes = toUint8Array(payload);
    this.incomingEmitter.fire(this.vsBufferWrap(bytes));
  }
}

class IpcRendererShim {
  private readonly listeners = new Map<string, Set<EventSubscription>>();
  private readonly onceWrappers = new Map<string, Map<IpcListener, IpcListener>>();
  private readonly channelRegistry: DesktopChannelRegistry;
  private channelServer: RendererChannelServer | undefined;
  private configurationPromise: Promise<Record<string, unknown>> | undefined;

  readonly sender = this;

  constructor(
    private readonly host: HostClient,
    private readonly resolveWindowId: () => Promise<number>
  ) {
    this.channelRegistry = createDesktopChannelRegistry(host);
    this.installIpcEventBridge();
    this.installMenubarBridge();
  }

  private installIpcEventBridge(): void {
    void this.channelRegistry.listen('__ipc', 'event', null, payload => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const candidate = payload as { channel?: unknown; args?: unknown };
      if (typeof candidate.channel !== 'string' || !candidate.channel.startsWith('vscode:')) {
        return;
      }

      const args = Array.isArray(candidate.args) ? candidate.args : [];
      this.emit(candidate.channel, ...args);
    });
  }

  private installMenubarBridge(): void {
    void this.channelRegistry.listen('menubar', 'runAction', null, payload => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const candidate = payload as { id?: unknown; from?: unknown; args?: unknown };
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
        return;
      }

      this.emit('vscode:runAction', {
        id: candidate.id,
        from: typeof candidate.from === 'string' ? candidate.from : 'menu',
        args: Array.isArray(candidate.args) ? candidate.args : undefined
      });
    });

    void this.channelRegistry.listen('menubar', 'runKeybinding', null, payload => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const candidate = payload as { userSettingsLabel?: unknown };
      if (
        typeof candidate.userSettingsLabel !== 'string' ||
        candidate.userSettingsLabel.length === 0
      ) {
        return;
      }

      this.emit('vscode:runKeybinding', {
        userSettingsLabel: candidate.userSettingsLabel
      });
    });
  }

  private validateChannel(channel: string): void {
    if (!channel || !channel.startsWith('vscode:')) {
      throw new Error(`Unsupported event IPC channel '${channel}'`);
    }
  }

  private emit(channel: string, ...args: unknown[]): void {
    const subs = this.listeners.get(channel);
    if (!subs || subs.size === 0) {
      return;
    }

    for (const sub of [...subs]) {
      try {
        sub.listener.call(sub.thisArgs, { sender: this }, ...args);
      } catch (error) {
        console.error('[desktopSandbox] ipc listener failed', { channel, error });
      }
    }
  }

  private async ensureServer(): Promise<RendererChannelServer> {
    if (this.channelServer) {
      return this.channelServer;
    }

    const windowId = await this.resolveWindowId();
    this.channelServer = new RendererChannelServer(this.host, this.channelRegistry, payload => {
      this.emit('vscode:message', payload);
    }, windowId);

    return this.channelServer;
  }

  send(channel: string, ...args: unknown[]): void {
    this.validateChannel(channel);

    if (channel === 'vscode:hello') {
      void this.ensureServer().then(server => server.ready());
      return;
    }

    if (channel === 'vscode:message') {
      const payload = args[0];
      void this.ensureServer().then(server => server.acceptMessage(payload));
      return;
    }

    if (channel === 'vscode:disconnect') {
      return;
    }

    void this.host.desktopChannelCall('__ipcSend__', channel, args).catch(error => {
      console.warn('[desktopSandbox] ipc send bridge failed', { channel, error });
    });
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.validateChannel(channel);

    if (channel === 'vscode:fetchShellEnv') {
      const result = await this.host.invokeMethod<{ env?: Record<string, string> }>('process.env', {});
      return result.env ?? {};
    }

    return this.host.desktopChannelCall('__ipcInvoke__', channel, args);
  }

  on(channel: string, listener: IpcListener): this {
    this.validateChannel(channel);

    const subs = this.listeners.get(channel) ?? new Set<EventSubscription>();
    subs.add({ listener, thisArgs: undefined });
    this.listeners.set(channel, subs);
    return this;
  }

  once(channel: string, listener: IpcListener): this {
    this.validateChannel(channel);

    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, listener);
      listener(event, ...args);
    };

    const wrappers = this.onceWrappers.get(channel) ?? new Map<IpcListener, IpcListener>();
    wrappers.set(listener, wrapped);
    this.onceWrappers.set(channel, wrappers);
    this.on(channel, wrapped);

    return this;
  }

  removeListener(channel: string, listener: IpcListener): this {
    this.validateChannel(channel);

    const subs = this.listeners.get(channel);
    if (!subs) {
      return this;
    }

    const wrappers = this.onceWrappers.get(channel);
    const actual = wrappers?.get(listener) ?? listener;
    for (const sub of [...subs]) {
      if (sub.listener === actual) {
        subs.delete(sub);
      }
    }

    wrappers?.delete(listener);
    if (subs.size === 0) {
      this.listeners.delete(channel);
    }

    return this;
  }

  off(channel: string, listener: IpcListener): this {
    return this.removeListener(channel, listener);
  }

  async resolveConfiguration(): Promise<Record<string, unknown>> {
    if (!this.configurationPromise) {
      this.configurationPromise = this.host.resolveWindowConfig();
    }

    return this.configurationPromise;
  }
}

function addDisposable(target: unknown, disposable: DisposableLike): void {
  if (!target) {
    return;
  }

  const list = target as { push?: (value: DisposableLike) => unknown; add?: (value: DisposableLike) => unknown };
  if (typeof list.add === 'function') {
    list.add(disposable);
    return;
  }
  if (typeof list.push === 'function') {
    list.push(disposable);
  }
}

function normalizeDesktopEventPayload(eventName: string, payload: unknown): unknown {
  if (eventName === 'onDidChangeFile' || eventName === 'fileChange') {
    return Array.isArray(payload) ? payload : [];
  }

  if (eventName === 'onDidChangeStorage') {
    const event = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    return {
      changed: Array.isArray(event.changed) ? event.changed : [],
      deleted: Array.isArray(event.deleted) ? event.deleted : []
    };
  }

  if (eventName === 'onDidChangeProfiles') {
    const event = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    return {
      all: Array.isArray(event.all) ? event.all : [],
      added: Array.isArray(event.added) ? event.added : [],
      removed: Array.isArray(event.removed) ? event.removed : [],
      updated: Array.isArray(event.updated) ? event.updated : []
    };
  }

  return payload;
}

function createHostBackedEvent(
  registry: DesktopChannelRegistry,
  channel: string,
  eventName: string,
  arg: unknown
): (listener: (value: unknown) => void, thisArgs?: unknown, disposables?: unknown) => DisposableLike {
  const listeners = new Set<{ fn: (value: unknown) => void; thisArgs: unknown }>();
  let stopListening: (() => void) | undefined;
  let starting: Promise<void> | undefined;

  const fire = (payload: unknown) => {
    const normalizedPayload = normalizeDesktopEventPayload(eventName, payload);
    for (const entry of [...listeners]) {
      try {
        entry.fn.call(entry.thisArgs, normalizedPayload);
      } catch (error) {
        console.error('[desktopSandbox] channel event listener failed', {
          channel,
          eventName,
          error
        });
      }
    }
  };

  const ensureListening = () => {
    if (stopListening || starting) {
      return;
    }

    starting = registry.listen(channel, eventName, arg, fire).then(stop => {
      stopListening = () => {
        void stop();
      };
      starting = undefined;
    }).catch(error => {
      console.warn('[desktopSandbox] channel listen bridge failed', { channel, eventName, error });
      starting = undefined;
    });
  };

  const maybeStop = () => {
    if (listeners.size > 0 || !stopListening) {
      return;
    }

    const stop = stopListening;
    stopListening = undefined;
    stop();
  };

  return (listener, thisArgs, disposables) => {
    const entry = { fn: listener, thisArgs };
    listeners.add(entry);
    ensureListening();

    const disposable: DisposableLike = {
      dispose() {
        listeners.delete(entry);
        maybeStop();
      }
    };

    addDisposable(disposables, disposable);
    return disposable;
  };
}

function toUint8Array(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) {
    return payload;
  }

  if (Array.isArray(payload)) {
    return Uint8Array.from(payload as number[]);
  }

  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }

  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  if (payload && typeof payload === 'object') {
    const objectPayload = payload as {
      buffer?: unknown;
      byteOffset?: unknown;
      byteLength?: unknown;
      data?: unknown;
    };

    if (
      objectPayload.buffer instanceof ArrayBuffer &&
      typeof objectPayload.byteOffset === 'number' &&
      typeof objectPayload.byteLength === 'number'
    ) {
      return new Uint8Array(
        objectPayload.buffer,
        objectPayload.byteOffset,
        objectPayload.byteLength
      );
    }

    if (Array.isArray(objectPayload.data)) {
      return Uint8Array.from(objectPayload.data as number[]);
    }
  }

  return new Uint8Array(0);
}

function parsePlatform(config: Record<string, unknown>): string {
  const os = config.os as { type?: string; platform?: string } | undefined;
  if (typeof os?.platform === 'string') {
    const normalized = os.platform.toLowerCase();
    if (normalized === 'darwin' || normalized === 'macos' || normalized === 'mac') {
      return 'darwin';
    }
    if (normalized === 'win32' || normalized === 'windows' || normalized === 'win') {
      return 'win32';
    }
    if (normalized === 'linux') {
      return 'linux';
    }
  }

  if (typeof os?.type === 'string') {
    const normalized = os.type.toLowerCase();
    if (normalized.includes('darwin')) {
      return 'darwin';
    }
    if (normalized.includes('windows')) {
      return 'win32';
    }
  }

  return 'darwin';
}

function parseArch(config: Record<string, unknown>): string {
  const rawArch = typeof (config.os as { arch?: unknown } | undefined)?.arch === 'string'
    ? String((config.os as { arch?: string }).arch).toLowerCase()
    : '';

  if (rawArch === 'x64' || rawArch === 'x86_64' || rawArch === 'amd64') {
    return 'x64';
  }
  if (rawArch === 'arm64' || rawArch === 'aarch64') {
    return 'arm64';
  }
  if (rawArch === 'arm' || rawArch === 'armv7l' || rawArch === 'armhf') {
    return 'arm';
  }
  if (rawArch === 'ia32' || rawArch === 'x86') {
    return 'ia32';
  }

  return 'x64';
}

type LocalPtyLoopbackProcess = {
  id: number;
  shell: string;
  cwd: string;
  hostTerminalId: number;
  pid: number;
};

async function createLocalPtyHostLoopbackPort(
  host: HostClient,
  shellEnv: () => Promise<Record<string, string>>,
  defaultShell: () => string
): Promise<MessagePort> {
  const [
    ipcModule,
    ipcMessagePortModule,
    lifecycleModule,
    eventModule
  ] = await Promise.all([
    import(/* @vite-ignore */ getRendererIpcModulePaths().ipcModulePath) as Promise<{
      ChannelServer: new (protocol: unknown, ctx: string) => {
        registerChannel(name: string, channel: unknown): void;
      };
      ProxyChannel: {
        fromService<TContext>(
          service: unknown,
          disposables: { add<T extends { dispose(): void }>(value: T): T }
        ): unknown;
      };
    }>,
    import(/* @vite-ignore */ getRendererIpcMessagePortModulePath()) as Promise<{
      Protocol: new (port: MessagePort) => { disconnect(): void };
    }>,
    import(/* @vite-ignore */ getRendererLifecycleModulePath()) as Promise<{
      DisposableStore: new () => {
        add<T extends { dispose(): void }>(value: T): T;
        dispose(): void;
      };
    }>,
    import(/* @vite-ignore */ getRendererIpcModulePaths().eventModulePath) as Promise<{
      Emitter: new <T>() => {
        readonly event: (listener: (value: T) => void) => { dispose(): void };
        fire(value: T): void;
        dispose(): void;
      };
    }>
  ]);

  const channel = new MessageChannel();
  const disposables = new lifecycleModule.DisposableStore();
  const onProcessData = new eventModule.Emitter<{ id: number; event: { data: string; trackCommit: boolean } }>();
  const onProcessReady = new eventModule.Emitter<{
    id: number;
    event: { pid: number; cwd: string; windowsPty: undefined };
  }>();
  const onProcessExit = new eventModule.Emitter<{ id: number; event: number | undefined }>();
  const onDidChangeProperty = new eventModule.Emitter<{ id: number; property: { type: number; value: unknown } }>();
  const onProcessReplay = new eventModule.Emitter<{ id: number; event: { events: []; commands: { commands: [] } } }>();
  const onProcessOrphanQuestion = new eventModule.Emitter<{ id: number }>();
  const onDidRequestDetach = new eventModule.Emitter<{ workspaceId: string; instanceId: number }>();
  const processes = new Map<number, LocalPtyLoopbackProcess>();

  disposables.add(onProcessData);
  disposables.add(onProcessReady);
  disposables.add(onProcessExit);
  disposables.add(onDidChangeProperty);
  disposables.add(onProcessReplay);
  disposables.add(onProcessOrphanQuestion);
  disposables.add(onDidRequestDetach);

  const resolveProcess = (id: number): LocalPtyLoopbackProcess => {
    const process = processes.get(id);
    if (!process) {
      throw new Error(`Unknown local pty process id ${id}`);
    }
    return process;
  };

  const parseShellLaunchArgs = (value: unknown): string[] => {
    if (typeof value === 'string') {
      return value.length > 0 ? [value] : [];
    }
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === 'string');
  };

  const applyEnvironmentVariableCollections = (
    env: Record<string, string>,
    serializedCollections: unknown
  ): void => {
    if (!Array.isArray(serializedCollections)) {
      return;
    }

    const variableMutators = new Map<string, SerializableEnvironmentMutator[]>();

    for (const collectionEntry of serializedCollections) {
      if (!Array.isArray(collectionEntry) || collectionEntry.length < 2) {
        continue;
      }

      const serializedCollection = collectionEntry[1];
      if (!Array.isArray(serializedCollection)) {
        continue;
      }

      for (const mutatorEntry of serializedCollection) {
        if (!Array.isArray(mutatorEntry) || mutatorEntry.length < 2) {
          continue;
        }

        const [variableName, rawMutator] = mutatorEntry;
        if (typeof variableName !== 'string' || !rawMutator || typeof rawMutator !== 'object') {
          continue;
        }

        const mutator = rawMutator as SerializableEnvironmentMutator;
        const variable =
          typeof mutator.variable === 'string' && mutator.variable.length > 0
            ? mutator.variable
            : variableName;
        const value = typeof mutator.value === 'string' ? mutator.value : undefined;
        const type = typeof mutator.type === 'number' ? mutator.type : undefined;
        if (typeof value !== 'string' || typeof type !== 'number') {
          continue;
        }

        let entry = variableMutators.get(variable);
        if (!entry) {
          entry = [];
          variableMutators.set(variable, entry);
        }

        if (entry.length > 0 && entry[0].type === ENVIRONMENT_VARIABLE_MUTATOR_TYPE_REPLACE) {
          continue;
        }
        entry.unshift(mutator);
      }
    }

    for (const [variable, mutators] of variableMutators) {
      for (const mutator of mutators) {
        if (mutator.options?.applyAtProcessCreation === false) {
          continue;
        }

        const value = typeof mutator.value === 'string' ? mutator.value : '';
        switch (mutator.type) {
          case ENVIRONMENT_VARIABLE_MUTATOR_TYPE_REPLACE:
            env[variable] = value;
            break;
          case ENVIRONMENT_VARIABLE_MUTATOR_TYPE_APPEND:
            env[variable] = (env[variable] || '') + value;
            break;
          case ENVIRONMENT_VARIABLE_MUTATOR_TYPE_PREPEND:
            env[variable] = value + (env[variable] || '');
            break;
        }
      }
    }
  };

  const stopLocalPtyData = await host.desktopChannelListen(
    'localPty',
    'onProcessData',
    null,
    payload => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const event = payload as {
        id?: unknown;
        event?: { data?: unknown; trackCommit?: unknown } | undefined;
      };
      const processId = typeof event.id === 'number' ? event.id : undefined;
      const processEvent =
        event.event && typeof event.event === 'object' ? event.event : undefined;
      const data =
        processEvent && typeof processEvent.data === 'string'
          ? processEvent.data
          : undefined;
      if (typeof processId !== 'number' || typeof data !== 'string') {
        return;
      }

      onProcessData.fire({
        id: processId,
        event: {
          data,
          trackCommit: processEvent?.trackCommit === true
        }
      });
    }
  );
  disposables.add({
    dispose: () => {
      void stopLocalPtyData();
    }
  });

  const service = {
    onProcessData: onProcessData.event,
    onProcessReady: onProcessReady.event,
    onProcessExit: onProcessExit.event,
    onDidChangeProperty: onDidChangeProperty.event,
    onProcessReplay: onProcessReplay.event,
    onProcessOrphanQuestion: onProcessOrphanQuestion.event,
    onDidRequestDetach: onDidRequestDetach.event,
    async createProcess(
      shellLaunchConfig: Record<string, unknown> | undefined,
      cwd: string,
      cols: number,
      rows: number,
      _unicodeVersion: string,
      env: Record<string, string | null> | undefined,
      _executableEnv?: Record<string, string | null> | undefined,
      options?: { environmentVariableCollections?: unknown }
    ): Promise<number> {
      const mergedEnv = {} as Record<string, string>;
      const baseEnv = _executableEnv && typeof _executableEnv === 'object'
        ? _executableEnv
        : await shellEnv();
      for (const [key, value] of Object.entries(baseEnv)) {
        if (typeof value === 'string') {
          mergedEnv[key] = value;
        }
      }

      if (env && typeof env === 'object') {
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === 'string') {
            mergedEnv[key] = value;
          } else if (value === null) {
            delete mergedEnv[key];
          }
        }
      }

      applyEnvironmentVariableCollections(mergedEnv, options?.environmentVariableCollections);

      const executable =
        typeof shellLaunchConfig?.executable === 'string' && shellLaunchConfig.executable.length > 0
          ? shellLaunchConfig.executable
          : defaultShell();
      const args = parseShellLaunchArgs(shellLaunchConfig?.args);
      void host.invokeMethod('host.log', {
        level: 'info',
        source: 'desktopSandbox.localPty',
        message: `createProcess shell=${executable} cwd=${cwd} args=${JSON.stringify(args)} envKeys=${Object.keys(mergedEnv).length} envCollections=${Array.isArray(options?.environmentVariableCollections) ? options.environmentVariableCollections.length : 0}`
      }).catch(() => undefined);
      const result = await host.invokeMethod<{ id?: unknown; pid?: unknown }>('terminal.create', {
        shell: executable,
        args,
        cwd,
        env: mergedEnv,
        cols,
        rows
      });
      const hostTerminalId = typeof result.id === 'number' ? result.id : undefined;
      const pid = typeof result.pid === 'number' ? result.pid : -1;
      if (typeof hostTerminalId !== 'number') {
        throw new Error('terminal.create returned an invalid id');
      }

      const id = hostTerminalId;
      processes.set(id, {
        id,
        shell: executable,
        cwd,
        hostTerminalId,
        pid
      });
      const readyEvent = {
        pid,
        cwd,
        windowsPty: undefined
      };
      setTimeout(() => {
        onProcessReady.fire({
          id,
          event: readyEvent
        });
      }, 0);
      return id;
    },
    async start(id: number): Promise<{ pid: number; cwd: string; windowsPty: undefined }> {
      const process = resolveProcess(id);
      const readyEvent = {
        pid: process.pid,
        cwd: process.cwd,
        windowsPty: undefined
      };
      setTimeout(() => {
        onProcessReady.fire({
          id,
          event: readyEvent
        });
      }, 0);
      return readyEvent;
    },
    input(id: number, data: string): void {
      const process = resolveProcess(id);
      void host.invokeMethod('host.log', {
        level: 'info',
        source: 'desktopSandbox.localPty',
        message: `input id=${id} bytes=${data.length} data=${data.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`
      }).catch(() => undefined);
      void host.invokeMethod('terminal.write', {
        id: process.hostTerminalId,
        data
      }).catch(error => {
        console.warn('[desktopSandbox] local pty write failed', { id, error });
      });
    },
    resize(id: number, cols: number, rows: number): void {
      const process = resolveProcess(id);
      void host.invokeMethod('terminal.resize', {
        id: process.hostTerminalId,
        cols,
        rows
      }).catch(() => undefined);
    },
    shutdown(id: number): void {
      const process = processes.get(id);
      if (!process) {
        return;
      }
      processes.delete(id);
      void host.invokeMethod('terminal.kill', {
        id: process.hostTerminalId
      }).catch(() => undefined).finally(() => {
        onProcessExit.fire({ id, event: undefined });
      });
    },
    async getEnvironment(): Promise<Record<string, string>> {
      return shellEnv();
    },
    async getShellEnvironment(): Promise<Record<string, string>> {
      return shellEnv();
    },
    async getLatency(): Promise<[]> {
      return [];
    },
    async getPerformanceMarks(): Promise<[]> {
      return [];
    },
    async getProfiles(): Promise<unknown[]> {
      const shell = defaultShell();
      return [{
        profileName: shell.split('/').pop() || 'shell',
        path: shell,
        isDefault: true,
        isAutoDetected: true
      }];
    },
    async getDefaultSystemShell(): Promise<string> {
      return defaultShell();
    },
    async requestDetachInstance(): Promise<undefined> {
      return undefined;
    },
    async acceptDetachInstanceReply(): Promise<void> {
      return;
    },
    async detachFromProcess(): Promise<void> {
      return;
    },
    async attachToProcess(): Promise<void> {
      throw new Error('attachToProcess is not supported in the Tauri local pty loopback.');
    },
    async listProcesses(): Promise<[]> {
      return [];
    },
    async processBinary(id: number, data: string): Promise<void> {
      this.input(id, data);
    },
    async sendSignal(id: number): Promise<void> {
      this.shutdown(id);
    },
    async acknowledgeDataEvent(): Promise<void> {
      return;
    },
    async setUnicodeVersion(): Promise<void> {
      return;
    },
    async clearBuffer(): Promise<void> {
      return;
    },
    async refreshProperty(id: number): Promise<unknown> {
      const process = processes.get(id);
      return process?.cwd;
    },
    async updateProperty(): Promise<void> {
      return;
    },
    async getTerminalLayoutInfo(): Promise<null> {
      return null;
    },
    async setTerminalLayoutInfo(): Promise<void> {
      return;
    },
    async reviveTerminalProcesses(): Promise<void> {
      return;
    },
    async reduceConnectionGraceTime(): Promise<void> {
      return;
    },
    orphanQuestionReply(): void {
      return;
    },
    dispose(): void {
      for (const process of processes.values()) {
        void host.invokeMethod('terminal.kill', {
          id: process.hostTerminalId
        }).catch(() => undefined);
      }
      processes.clear();
      disposables.dispose();
    }
  };

  const protocol = new ipcMessagePortModule.Protocol(channel.port2);
  const server = new ipcModule.ChannelServer(protocol, 'tauri-pty-host');
  server.registerChannel(
    'ptyHostWindow',
    ipcModule.ProxyChannel.fromService(service, disposables)
  );

  return channel.port1;
}

export async function installDesktopSandbox(host: HostClient): Promise<void> {
	const win = window as WindowWithVscode;
	let resolvedWindowConfigPromise: Promise<Record<string, unknown>> | undefined;
	const resolveWindowConfig = () => {
		if (!resolvedWindowConfigPromise) {
			resolvedWindowConfigPromise = host.resolveWindowConfig();
		}
		return resolvedWindowConfigPromise;
	};

	const ipc = new IpcRendererShim(host, async () => {
		const config = await resolveWindowConfig();
		const id = config.windowId;
		return typeof id === 'number' ? id : 1;
	});

  let zoomLevel = 0;
  let cachedConfiguration: Record<string, unknown> | undefined;
  let shellEnvPromise: Promise<Record<string, string>> | undefined;

  const resolveConfiguration = async (): Promise<Record<string, unknown>> => {
		if (cachedConfiguration) {
			return cachedConfiguration;
		}

		const config = await resolveWindowConfig();
    applyWorkspaceFromLocation(config);
    if (typeof config.zoomLevel === 'number') {
      zoomLevel = config.zoomLevel;
    }
		cachedConfiguration = config;
		return config;
	};

  const shellEnv = async (): Promise<Record<string, string>> => {
    if (!shellEnvPromise) {
      shellEnvPromise = Promise.all([
        resolveConfiguration(),
        host.invokeMethod<{ env?: Record<string, string> }>('process.env', {})
      ]).then(([config, processEnvResponse]) => {
        const userEnv = (config.userEnv as Record<string, string> | undefined) ?? {};
        const processEnv = processEnvResponse.env ?? {};
        return {
          ...processEnv,
          ...userEnv
        };
      });
    }

    return shellEnvPromise;
  };

  const configuration = await resolveConfiguration();
  const processEnv = {
    ...((configuration.userEnv as Record<string, string> | undefined) ?? {})
  };
  processEnv.VSCODE_DESKTOP_RUNTIME = 'electrobun';
  processEnv.VSCODE_ELECTROBUN_DISABLE_MESSAGEPORT = 'true';
  processEnv.VSCODE_CWD = processEnv.VSCODE_CWD || '/';
  if (!processEnv.VSCODE_TAURI_WEBVIEW_EXTERNAL_ENDPOINT) {
    const origin = window.location.origin;
    if (origin && origin !== 'null') {
      processEnv.VSCODE_TAURI_WEBVIEW_EXTERNAL_ENDPOINT =
        `${origin.replace(/\/+$/, '')}/out/vs/workbench/contrib/webview/browser/pre/`;
    }
  }

  const processPlatform = parsePlatform(configuration);
  const processArch = parseArch(configuration);
  const execPath =
    typeof configuration.execPath === 'string' ? configuration.execPath : '/Applications/Code Tauri.app';
  const processListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const messagePortBridgeStops = new Map<string, () => Promise<void>>();
  const shouldLogMessagePortBridge = processEnv.VSCODE_TAURI_INTEGRATION === '1';

  const logMessagePortBridge = (message: string): void => {
    if (!shouldLogMessagePortBridge) {
      return;
    }

    void host.invokeMethod('host.log', {
      level: 'info',
      source: 'desktopSandbox.port',
      message
    }).catch(() => undefined);
  };

  const processOn = (type: string, callback: (...args: unknown[]) => void): void => {
    const listeners = processListeners.get(type) ?? new Set<(...args: unknown[]) => void>();
    listeners.add(callback);
    processListeners.set(type, listeners);
  };

  const processOff = (type: string, callback: (...args: unknown[]) => void): void => {
    const listeners = processListeners.get(type);
    if (!listeners) {
      return;
    }

    listeners.delete(callback);
    if (listeners.size === 0) {
      processListeners.delete(type);
    }
  };

  const globals = {
    ipcRenderer: {
      send(channel: string, ...args: unknown[]) {
        ipc.send(channel, ...args);
      },
      invoke(channel: string, ...args: unknown[]) {
        return ipc.invoke(channel, ...args);
      },
      on(channel: string, listener: IpcListener) {
        return ipc.on(channel, listener);
      },
      once(channel: string, listener: IpcListener) {
        return ipc.once(channel, listener);
      },
      removeListener(channel: string, listener: IpcListener) {
        return ipc.removeListener(channel, listener);
      },
      off(channel: string, listener: IpcListener) {
        return ipc.off(channel, listener);
      }
    },
    ipcMessagePort: {
      acquire(responseChannel: string, nonce: string) {
        if (!responseChannel.startsWith('vscode:')) {
          throw new Error(`Unsupported event IPC channel '${responseChannel}'`);
        }

        const postResponse = (ports: Transferable[]) => {
          queueMicrotask(() => {
            logMessagePortBridge(`dispatch response nonce=${nonce} ports=${ports.length}`);
            if (typeof window.dispatchEvent === 'function' && typeof Event === 'function') {
              const event = new Event('message');
              Object.defineProperties(event, {
                data: { configurable: true, value: nonce },
                ports: { configurable: true, value: ports },
                source: { configurable: true, value: window }
              });
              window.dispatchEvent(event);
              return;
            }

            window.postMessage(nonce, '*', ports);
          });
        };

        if (responseChannel === 'vscode:startExtensionHostMessagePortResult') {
          const channel = new MessageChannel();
          let closed = false;
          let rendererPortReady = false;
          const pendingFrames: Uint8Array[] = [];
          const existingStop = messagePortBridgeStops.get(nonce);
          if (existingStop) {
            void existingStop();
            messagePortBridgeStops.delete(nonce);
          }

          const flushPendingFrames = () => {
            if (closed || !rendererPortReady || pendingFrames.length === 0) {
              return;
            }

            logMessagePortBridge(`flush pending nonce=${nonce} frames=${pendingFrames.length}`);
            for (const frame of pendingFrames.splice(0)) {
              channel.port2.postMessage(frame);
            }
          };

          const closeBridge = () => {
            if (closed) {
              return;
            }
            closed = true;
            channel.port2.onmessage = null;
            channel.port2.close();
            const stop = messagePortBridgeStops.get(nonce);
            if (stop) {
              messagePortBridgeStops.delete(nonce);
              void stop();
            }
            void host.desktopChannelCall('extensionHostStarter', 'closeMessagePortFrame', [nonce]).catch(error => {
              console.warn('[desktopSandbox] failed to close extension host message port frame', { nonce, error });
            });
          };

          channel.port2.onmessage = event => {
            if (closed) {
              return;
            }
            const frame = Array.from(toUint8Array(event.data));
            void host
              .desktopChannelCall('extensionHostStarter', 'writeMessagePortFrame', [nonce, frame])
              .catch(error => {
                console.warn('[desktopSandbox] failed to forward extension host message port frame', { nonce, error });
                closeBridge();
              });
          };
          channel.port2.onmessageerror = () => closeBridge();
          channel.port1.addEventListener('close', () => closeBridge(), { once: true });
          channel.port2.addEventListener('close', () => closeBridge(), { once: true });
          channel.port2.start();

          void host
            .desktopChannelListen('extensionHostStarter', 'onDynamicMessagePortFrame', nonce, payload => {
              if (closed) {
                return;
              }
              const frame = toUint8Array(payload);
              if (frame.byteLength === 0) {
                return;
              }
              if (!rendererPortReady) {
                pendingFrames.push(frame);
                return;
              }
              channel.port2.postMessage(frame);
            })
            .then(stop => {
              if (closed) {
                void stop();
                return;
              }
              messagePortBridgeStops.set(nonce, stop);
            })
            .catch(error => {
              console.warn('[desktopSandbox] failed to subscribe to extension host message port frames', { nonce, error });
              closeBridge();
            });

          postResponse([channel.port1]);
          setTimeout(() => {
            rendererPortReady = true;
            logMessagePortBridge(`renderer ready nonce=${nonce}`);
            flushPendingFrames();
          }, 0);
          return;
        }

        if (responseChannel === 'vscode:createPtyHostMessageChannelResult') {
          void host.invokeMethod('host.log', {
            level: 'info',
            source: 'desktopSandbox.localPty',
            message: 'acquire pty host message channel'
          }).catch(() => undefined);
          void createLocalPtyHostLoopbackPort(
            host,
            shellEnv,
            () => processEnv.SHELL || '/bin/zsh'
          ).then(port => {
            postResponse([port]);
          }).catch(error => {
            console.warn('[desktopSandbox] failed to create local pty loopback port', error);
            postResponse([]);
          });
          return;
        }

        postResponse([]);
      }
    },
    webFrame: {
      setZoomLevel(level: number): void {
        if (typeof level !== 'number' || Number.isNaN(level)) {
          return;
        }

        zoomLevel = level;
      }
    },
    process: {
      get platform() {
        return processPlatform;
      },
      get arch() {
        return processArch;
      },
      get env() {
        return { ...processEnv };
      },
      get versions() {
        return {
          node: '20.17.0',
          chrome: '122.0.0',
          electron: 'tauri-bridge',
          tauri: '2'
        };
      },
      get type() {
        return 'renderer';
      },
      get execPath() {
        return execPath;
      },
      cwd() {
        return processEnv.VSCODE_CWD || '/';
      },
      shellEnv() {
        return shellEnv();
      },
      async getProcessMemoryInfo() {
        if ('memory' in performance && typeof (performance as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize === 'number') {
          const used = (performance as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
          const kiloBytes = Math.floor(used / 1024);
          return { private: kiloBytes, residentSet: kiloBytes, shared: 0 };
        }

        return { private: 0, residentSet: 0, shared: 0 };
      },
      on() {
        if (arguments.length >= 2 && typeof arguments[0] === 'string' && typeof arguments[1] === 'function') {
          processOn(arguments[0], arguments[1]);
        }
      },
      once() {
        if (arguments.length < 2 || typeof arguments[0] !== 'string' || typeof arguments[1] !== 'function') {
          return;
        }

        const eventType = arguments[0];
        const callback = arguments[1];
        const wrapped = (...args: unknown[]) => {
          processOff(eventType, wrapped);
          callback(...args);
        };
        processOn(eventType, wrapped);
      },
      off() {
        if (arguments.length >= 2 && typeof arguments[0] === 'string' && typeof arguments[1] === 'function') {
          processOff(arguments[0], arguments[1]);
        }
      },
      removeListener() {
        if (arguments.length >= 2 && typeof arguments[0] === 'string' && typeof arguments[1] === 'function') {
          processOff(arguments[0], arguments[1]);
        }
      },
      emit() {
        if (arguments.length === 0 || typeof arguments[0] !== 'string') {
          return false;
        }

        const eventType = arguments[0];
        const listeners = processListeners.get(eventType);
        if (!listeners || listeners.size === 0) {
          return false;
        }

        const eventArgs = Array.prototype.slice.call(arguments, 1) as unknown[];
        for (const listener of [...listeners]) {
          try {
            listener(...eventArgs);
          } catch (error) {
            console.error('[desktopSandbox] process listener failed', { eventType, error });
          }
        }

        return true;
      },
      nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]) {
        queueMicrotask(() => callback(...args));
      }
    },
    context: {
      configuration(): Record<string, unknown> | undefined {
        return cachedConfiguration;
      },
      async resolveConfiguration(): Promise<Record<string, unknown>> {
        const resolved = await resolveConfiguration();
        resolved.zoomLevel = zoomLevel;

        return resolved;
      }
    },
    webUtils: {
      getPathForFile(file: File): string {
        const candidate = file as File & { path?: string; webkitRelativePath?: string };
        if (typeof candidate.path === 'string' && candidate.path.length > 0) {
          return candidate.path;
        }

        if (typeof candidate.webkitRelativePath === 'string' && candidate.webkitRelativePath.length > 0) {
          return candidate.webkitRelativePath;
        }

        return file.name;
      }
    }
  };

  win._VSCODE_USE_RELATIVE_IMPORTS = true;
  win._VSCODE_DISABLE_CSS_IMPORT_MAP = false;

  Object.defineProperty(win, 'vscode', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: globals
  });

  (globalThis as { process?: unknown }).process = globals.process as unknown;
  (globalThis as { global?: typeof globalThis }).global = globalThis;
}
