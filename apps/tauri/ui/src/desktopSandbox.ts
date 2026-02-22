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
			const eventModulePath = '/out/vs/base/common/event.js';
			const bufferModulePath = '/out/vs/base/common/buffer.js';
			const ipcModulePath = '/out/vs/base/parts/ipc/common/ipc.js';

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

      // Extra dynamic channels still route through host fallback.
      server.registerChannel('tauriFallback', {
        call: async (_ctx: unknown, command: string, arg?: unknown) => {
          const args = Array.isArray(arg) ? arg : typeof arg === 'undefined' ? [] : [arg];
          return this.registry.call('tauriFallback', command, args);
        },
        listen: (_ctx: unknown, eventName: string, arg?: unknown) => {
          return createHostBackedEvent(this.registry, 'tauriFallback', eventName, arg);
        }
      });

      // Keep buffer module loaded so wrap is available in acceptMessage.
      this.vsBufferWrap = bufferModule.VSBuffer.wrap;
    })();

    return this.readyPromise;
  }

  private vsBufferWrap:
    | ((input: Uint8Array) => { buffer: ArrayBufferLike })
    | undefined;

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
      void this.ensureServer();
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
    for (const entry of [...listeners]) {
      try {
        entry.fn.call(entry.thisArgs, payload);
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
    return os.platform;
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

	const resolveConfiguration = async (): Promise<Record<string, unknown>> => {
		if (cachedConfiguration) {
			return cachedConfiguration;
		}

		const config = await resolveWindowConfig();
		cachedConfiguration = config;
		return config;
	};

  const shellEnv = async (): Promise<Record<string, string>> => {
    const [config, processEnvResponse] = await Promise.all([
      resolveConfiguration(),
      host.invokeMethod<{ env?: Record<string, string> }>('process.env', {})
    ]);

    const userEnv = (config.userEnv as Record<string, string> | undefined) ?? {};
    const processEnv = processEnvResponse.env ?? {};
    return {
      ...processEnv,
      ...userEnv
    };
  };

  const configuration = await resolveConfiguration();
  const processEnv = {
    ...((configuration.userEnv as Record<string, string> | undefined) ?? {})
  };
  processEnv.VSCODE_DESKTOP_RUNTIME = 'electrobun';
  processEnv.VSCODE_ELECTROBUN_DISABLE_MESSAGEPORT =
    processEnv.VSCODE_ELECTROBUN_DISABLE_MESSAGEPORT || 'true';
  processEnv.VSCODE_CWD = processEnv.VSCODE_CWD || '/';

  const processPlatform = parsePlatform(configuration);
  const processArch =
    typeof (configuration.os as { arch?: unknown } | undefined)?.arch === 'string'
      ? String((configuration.os as { arch?: string }).arch)
      : 'x64';
  const execPath =
    typeof configuration.execPath === 'string' ? configuration.execPath : '/Applications/Code Tauri.app';
  const processListeners = new Map<string, Set<(...args: unknown[]) => void>>();

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

        // Minimal emulation for extension host message-port startup:
        // send `Ready` (2), then after receiving init payload send `Initialized` (1).
        if (responseChannel === 'vscode:startExtensionHostMessagePortResult') {
          const channel = new MessageChannel();
          channel.port2.postMessage(Uint8Array.of(2));
          channel.port2.onmessage = () => {
            channel.port2.postMessage(Uint8Array.of(1));
          };
          channel.port2.start();
          window.postMessage(nonce, '*', [channel.port1]);
          return;
        }

        window.postMessage(nonce, '*', []);
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
        return processEnv;
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
        if (typeof resolved.zoomLevel === 'number') {
          zoomLevel = resolved.zoomLevel;
        } else {
          resolved.zoomLevel = zoomLevel;
        }

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
