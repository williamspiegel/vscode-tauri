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
  private windowConfigPromise: Promise<Record<string, unknown>> | undefined;
  private readonly desktopChannelHandlers = new Map<string, (payload: unknown) => void>();
  private readonly desktopChannelBufferedEvents = new Map<string, unknown[]>();
  private desktopChannelEventStop: (() => void) | undefined;
  private desktopChannelEventReady: Promise<void> | undefined;
  private static cachedListen: TauriListen | undefined;
  private static readonly tauriEventNameMap: Record<string, string> = {
    'filesystem.changed': 'filesystem_changed',
    'desktop.channelEvent': 'desktop_channel_event'
  };
  private static readonly tauriEventNameInvalidPattern = /[^A-Za-z0-9_/:-]/g;
  private static formatUnknownError(error: unknown): string {
    if (error instanceof Error) {
      const parts: string[] = [];
      if (error.name) {
        parts.push(error.name);
      }
      if (error.message) {
        parts.push(error.message);
      }
      if (error.stack) {
        parts.push(error.stack);
      }
      return parts.join(' | ');
    }

    if (typeof error === 'string') {
      return error;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private static normalizeDesktopChannelPayload(
    envelope: HostEventPayload<'desktop.channelEvent'>
  ): unknown {
    if (envelope.channel === 'storage' && envelope.event === 'onDidChangeStorage') {
      const payload =
        envelope.payload && typeof envelope.payload === 'object'
          ? (envelope.payload as Record<string, unknown>)
          : {};
      return {
        changed: Array.isArray(payload.changed) ? payload.changed : [],
        deleted: Array.isArray(payload.deleted) ? payload.deleted : []
      };
    }

    if (envelope.channel === 'userDataProfiles' && envelope.event === 'onDidChangeProfiles') {
      const payload =
        envelope.payload && typeof envelope.payload === 'object'
          ? (envelope.payload as Record<string, unknown>)
          : {};
      return {
        all: Array.isArray(payload.all) ? payload.all : [],
        added: Array.isArray(payload.added) ? payload.added : [],
        removed: Array.isArray(payload.removed) ? payload.removed : [],
        updated: Array.isArray(payload.updated) ? payload.updated : []
      };
    }

    return envelope.payload;
  }

  private static toTauriEventName(eventName: string): string {
    const mapped = HostClient.tauriEventNameMap[eventName] ?? eventName;
    const sanitized = mapped
      .replace(/\./g, '_')
      .replace(HostClient.tauriEventNameInvalidPattern, '_');
    return sanitized.length > 0 ? sanitized : 'host_event';
  }

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
    if (HostClient.cachedListen) {
      return HostClient.cachedListen;
    }

    const tauriWindow = window as TauriWindow;
    const globalListen = tauriWindow.__TAURI__?.event?.listen;
    if (globalListen) {
      HostClient.cachedListen = globalListen;
      return globalListen;
    }

    const internals = tauriWindow.__TAURI_INTERNALS__;
    if (internals?.invoke && internals.transformCallback && internals.unregisterCallback) {
      const invoke = internals.invoke;
      const listen = async <T>(event: string, handler: TauriEventListener<T>) => {
        const callbackId = internals.transformCallback!(payload => {
          const eventPayload = (payload as { payload?: T })?.payload ?? (payload as T);
          handler({ payload: eventPayload });
        });

        let eventId: unknown;
        try {
          eventId = await invoke('plugin:event|listen', {
            event,
            target: { kind: 'Any' },
            handler: callbackId
          });
        } catch (error) {
          internals.unregisterCallback?.(callbackId);
          throw error;
        }

        return async () => {
          await invoke('plugin:event|unlisten', {
            event,
            eventId
          });
          internals.unregisterCallback?.(callbackId);
        };
      };
      HostClient.cachedListen = listen;
      return listen;
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

    let raw: unknown;
    try {
      raw = await this.invoke('host_invoke', { request });
    } catch (error) {
      const message = HostClient.formatUnknownError(error);
      throw new Error(`host_invoke transport failed for ${method}: ${message}`);
    }
    const response = raw as JsonRpcResponse<T>;

    if (response.jsonrpc !== '2.0' || response.id !== request.id) {
      throw new Error(`Invalid JSON-RPC envelope for method ${method}`);
    }

    if (response.error) {
      const data =
        typeof response.error.data === 'undefined'
          ? ''
          : ` data=${HostClient.formatUnknownError(response.error.data)}`;
      throw new Error(
        `Host error in ${method} (${response.error.code}): ${response.error.message}${data}`
      );
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

  async resolveWindowConfig(): Promise<Record<string, unknown>> {
    if (!this.windowConfigPromise) {
      this.windowConfigPromise = this.invokeMethod<Record<string, unknown>>('desktop.resolveWindowConfig', {})
        .catch(error => {
          this.windowConfigPromise = undefined;
          throw error;
        });
    }

    return this.windowConfigPromise;
  }

  async desktopChannelCall(
    channel: string,
    method: string,
    args: unknown[] = []
  ): Promise<unknown> {
    return this.invokeMethod<unknown>('desktop.channelCall', {
      channel,
      method,
      args
    });
  }

  async desktopChannelListen(
    channel: string,
    event: string,
    arg: unknown,
    handler: (payload: unknown) => void
  ): Promise<() => Promise<void>> {
    let dispatcherReady = true;
    try {
      await this.ensureDesktopChannelEventListener();
    } catch {
      // Some Tauri capability configurations disallow event.listen.
      // Fail fast so callers can choose immediate fallbacks instead of
      // waiting for events that can never arrive in this renderer session.
      dispatcherReady = false;
    }

    if (!dispatcherReady) {
      throw new Error('desktop.channelEvent listener is unavailable');
    }

    const response = await this.invokeMethod<{ subscriptionId: string }>('desktop.channelListen', {
      channel,
      event,
      arg
    });

    const subscriptionId = response.subscriptionId;
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
      throw new Error('desktop.channelListen returned an invalid subscription id.');
    }

    this.desktopChannelHandlers.set(subscriptionId, handler);
    const buffered = this.desktopChannelBufferedEvents.get(subscriptionId);
    if (buffered && buffered.length > 0) {
      this.desktopChannelBufferedEvents.delete(subscriptionId);
      for (const payload of buffered) {
        handler(payload);
      }
    }

    return async () => {
      this.desktopChannelHandlers.delete(subscriptionId);
      this.desktopChannelBufferedEvents.delete(subscriptionId);
      await this.invokeMethod('desktop.channelUnlisten', { subscriptionId });
    };
  }

  private async ensureDesktopChannelEventListener(): Promise<void> {
    if (this.desktopChannelEventStop) {
      return;
    }

    if (this.desktopChannelEventReady) {
      return this.desktopChannelEventReady;
    }

    this.desktopChannelEventReady = this.listenEvent('desktop.channelEvent', payload => {
      const subscriptionId = payload.subscriptionId;
      if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
        return;
      }

      const normalizedPayload = HostClient.normalizeDesktopChannelPayload(payload);

      const handler = this.desktopChannelHandlers.get(subscriptionId);
      if (handler) {
        handler(normalizedPayload);
        return;
      }

      const buffered = this.desktopChannelBufferedEvents.get(subscriptionId) ?? [];
      buffered.push(normalizedPayload);
      if (buffered.length > 32) {
        buffered.shift();
      }
      this.desktopChannelBufferedEvents.set(subscriptionId, buffered);
    })
      .then(stop => {
        this.desktopChannelEventStop = stop;
      })
      .finally(() => {
        this.desktopChannelEventReady = undefined;
      });

    return this.desktopChannelEventReady;
  }

  async listenEvent<E extends HostEventName>(
    eventName: E,
    handler: (payload: HostEventPayload<E>) => void
  ): Promise<() => void> {
    const listen = HostClient.resolveListen();
    const tauriEventName = HostClient.toTauriEventName(eventName as string);
    try {
      return await listen<HostEventPayload<E>>(tauriEventName, event => {
        handler(event.payload);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to listen to host event '${String(eventName)}' as '${tauriEventName}': ${message}`
      );
    }
  }
}
