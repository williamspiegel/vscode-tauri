import {
  hostProtocol,
  isKnownMethod,
  JsonRpcRequest,
  JsonRpcResponse,
  ProtocolHandshakeRequest,
  ProtocolHandshakeResponse,
  validateRequiredParams
} from './hostProtocol';

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriWindow extends Window {
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke;
    };
    event?: {
      listen?: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
    };
  };
}

export class HostClient {
  private nextId = 1;
  private readonly invoke: TauriInvoke;

  constructor() {
    this.invoke = HostClient.resolveInvoke();
  }

  private static resolveInvoke(): TauriInvoke {
    const candidate = (window as TauriWindow).__TAURI__?.core?.invoke;
    if (!candidate) {
      throw new Error('Tauri invoke API is unavailable. Run this UI inside the Tauri host.');
    }

    return candidate;
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
    const counts = await this.invoke('fallback_counts');
    return counts as Record<string, number>;
  }
}
