import protocol from '../../protocol/host-v1.json';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ProtocolHandshakeRequest {
  protocolVersion: string;
  clientName: string;
  clientVersion: string;
  requestedCapabilities?: string[];
}

export interface ProtocolHandshakeResponse {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  supportedCapabilities: string[];
}

export type HostProtocolSpec = typeof protocol;

export const hostProtocol: HostProtocolSpec = protocol;

export function isKnownMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(hostProtocol.methods, method);
}

export function validateRequiredParams(method: string, params: unknown): void {
  const methodSpec = hostProtocol.methods[method as keyof typeof hostProtocol.methods] as {
    params?: { required?: string[]; type?: string };
    paramsRef?: string;
  } | undefined;

  if (!methodSpec) {
    throw new Error(`Unknown method: ${method}`);
  }

  if (!methodSpec.params || methodSpec.params.type !== 'object') {
    return;
  }

  const required = methodSpec.params.required ?? [];
  if (required.length === 0) {
    return;
  }

  if (!params || typeof params !== 'object') {
    throw new Error(`Method ${method} expects object params.`);
  }

  const objectParams = params as Record<string, unknown>;
  for (const key of required) {
    if (!(key in objectParams)) {
      throw new Error(`Method ${method} missing required param: ${key}`);
    }
  }
}
