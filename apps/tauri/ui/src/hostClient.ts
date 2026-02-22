import {
  HostEventName,
  HostEventPayload,
  hostProtocol,
  isKnownMethod,
  JsonRpcRequest,
  JsonRpcResponse,
  ProtocolHandshakeRequest,
  ProtocolHandshakeResponse,
  validateRequiredParams
} from './hostProtocol';

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriEventListener<T> = (event: { payload: T }) => void;
type TauriListen = <T>(event: string, handler: TauriEventListener<T>) => Promise<() => void>;

interface TauriWindow extends Window {
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke;
    };
    event?: {
      listen?: TauriListen;
    };
  };
  __TAURI_INTERNALS__?: {
    invoke?: (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    transformCallback?: (callback: (payload: unknown) => void, once?: boolean) => number;
    unregisterCallback?: (id: number) => void;
  };
  __TAURI_INVOKE__?: TauriInvoke;
}

export class HostClient {
  private nextId = 1;
  private readonly invoke: TauriInvoke;

  constructor() {
    this.invoke = HostClient.resolveInvoke();
  }

  private static resolveInvoke(): TauriInvoke {
    const tauriWindow = window as TauriWindow;
    const candidate =
      tauriWindow.__TAURI__?.core?.invoke ??
      tauriWindow.__TAURI_INTERNALS__?.invoke ??
      tauriWindow.__TAURI_INVOKE__;
    if (!candidate) {
      throw new Error('Tauri invoke API is unavailable. Run this UI inside the Tauri host.');
    }

    return (command: string, args?: Record<string, unknown>) => candidate(command, args);
  }

  private static resolveListen(): TauriListen {
    const tauriWindow = window as TauriWindow;
    const globalListen = tauriWindow.__TAURI__?.event?.listen;
    if (globalListen) {
      return globalListen;
    }

    const internals = tauriWindow.__TAURI_INTERNALS__;
    if (internals?.invoke && internals.transformCallback && internals.unregisterCallback) {
      const invoke = internals.invoke;
      return async <T>(event: string, handler: TauriEventListener<T>) => {
        const callbackId = internals.transformCallback!(payload => {
          const eventPayload = (payload as { payload?: T })?.payload ?? (payload as T);
          handler({ payload: eventPayload });
        });

        const eventId = await invoke('plugin:event|listen', {
          event,
          target: { kind: 'Any' },
          handler: callbackId
        });

        return async () => {
          await invoke('plugin:event|unlisten', {
            event,
            eventId
          });
          internals.unregisterCallback?.(callbackId);
        };
      };
    }

    throw new Error('Tauri event API is unavailable. Run this UI inside the Tauri host.');
  }

  async handshake(): Promise<ProtocolHandshakeResponse> {
    const request: ProtocolHandshakeRequest = {
      protocolVersion: hostProtocol.protocolVersion,
      clientName: 'vscode-tauri-ui',
      clientVersion: '0.1.0',
      requestedCapabilities: Object.keys(hostProtocol.capabilities)
    };

    return this.invokeMethod<ProtocolHandshakeResponse>('protocol.handshake', request);
  }

  async invokeMethod<T>(method: string, params?: unknown): Promise<T> {
    if (!isKnownMethod(method)) {
      throw new Error(`Unknown host method: ${method}`);
    }

    validateRequiredParams(method, params);

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params
    };

    const raw = await this.invoke('host_invoke', { request });
    const response = raw as JsonRpcResponse<T>;

    if (response.jsonrpc !== '2.0' || response.id !== request.id) {
      throw new Error(`Invalid JSON-RPC envelope for method ${method}`);
    }

    if (response.error) {
      throw new Error(`Host error ${response.error.code}: ${response.error.message}`);
    }

    return response.result as T;
  }

  async getFallbackCounts(): Promise<Record<string, number>> {
    return this.invokeMethod<Record<string, number>>('host.fallbackCounts', {});
  }

  async getWorkbenchCssModules(): Promise<string[]> {
    const result = await this.invokeMethod<{ modules: string[] }>('host.cssModules', {});
    const modules = result.modules;
    if (!Array.isArray(modules) || modules.some(module => typeof module !== 'string')) {
      throw new Error('Host returned an invalid workbench CSS module payload.');
    }

    return modules;
  }

  async listenEvent<E extends HostEventName>(
    eventName: E,
    handler: (payload: HostEventPayload<E>) => void
  ): Promise<() => void> {
    const listen = HostClient.resolveListen();
    return listen<HostEventPayload<E>>(eventName, event => {
      handler(event.payload);
    });
  }
}
