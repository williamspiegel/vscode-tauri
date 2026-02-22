import { HostClient } from './hostClient';
import { installDesktopSandbox } from './desktopSandbox';

type StatusLevel = 'info' | 'error';

const SOURCEMAP_WARNING_PATTERN = /Sourcemap for ".*" points to missing source files/;
const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (
    args.some(
      value =>
        typeof value === 'string' &&
        SOURCEMAP_WARNING_PATTERN.test(value)
    )
  ) {
    return;
  }
  originalConsoleWarn(...args);
};

function setStatus(message: string, level: StatusLevel = 'info', visible = true): void {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = message;
    status.dataset.level = level;
    status.dataset.visible = visible ? '1' : '0';
  }
}

function isWorkbenchRendered(): boolean {
  return !!document.querySelector('.monaco-workbench');
}

function waitForWorkbenchRender(timeoutMs = 15000): Promise<boolean> {
  if (isWorkbenchRendered()) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    const deadline = window.setTimeout(() => {
      observer.disconnect();
      resolve(isWorkbenchRendered());
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      if (!isWorkbenchRendered()) {
        return;
      }

      window.clearTimeout(deadline);
      observer.disconnect();
      resolve(true);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  });
}

function installGlobalStartupErrorHandlers(): void {
  window.addEventListener('error', event => {
    const detailParts: string[] = [];
    if (event.error instanceof Error) {
      if (event.error.message) {
        detailParts.push(event.error.message);
      }
      if (event.error.stack) {
        detailParts.push(event.error.stack);
      }
    }
    if (event.message) {
      detailParts.push(String(event.message));
    }
    if (event.filename || event.lineno || event.colno) {
      detailParts.push(`at ${event.filename || '<unknown>'}:${event.lineno || 0}:${event.colno || 0}`);
    }
    const message =
      detailParts.length > 0 ? detailParts.join('\n') : 'Unknown window error';
    setStatus(`Startup failed:\n${message}`, 'error', true);
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.stack ?? reason.message
        : String(reason ?? 'Unknown rejection');
    setStatus(`Startup failed:\n${message}`, 'error', true);
  });
}

function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    if (error.stack && error.stack.length > 0) {
      return error.stack;
    }

    return `${error.name}: ${error.message}`;
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

async function installVsCodeUnexpectedErrorHook(): Promise<void> {
  return;
}

async function installVsCodeUnexpectedErrorHookForPath(modulePath: string): Promise<void> {
  try {
    const errorsModule = (await import(
      /* @vite-ignore */ modulePath
    )) as {
      setUnexpectedErrorHandler?: (handler: (error: unknown) => void) => void;
      errorHandler?: {
        getUnexpectedErrorHandler?: () => ((error: unknown) => void) | undefined;
      };
    };

    if (typeof errorsModule.setUnexpectedErrorHandler !== 'function') {
      return;
    }

    const existingHandler = errorsModule.errorHandler?.getUnexpectedErrorHandler?.();
    errorsModule.setUnexpectedErrorHandler((error: unknown) => {
      try {
        existingHandler?.(error);
      } catch {
        // If existing handler throws, still prefer surfacing original details.
      }

      const details = formatErrorDetails(error);
      console.error('[vscode unexpected error]', error);
      setStatus(`Startup failed:\n${details}`, 'error', true);
    });
  } catch (error) {
    console.warn(`[startup] failed to install VS Code unexpected error hook for ${modulePath}`, error);
  }
}

async function attachDebugHostListeners(host: HostClient): Promise<void> {
  const debugEnabled = new URLSearchParams(window.location.search).get('hostDebug') === '1';
  if (!debugEnabled) {
    return;
  }

  await host.listenEvent('host.lifecycle', payload => {
    console.debug('[host.lifecycle]', payload);
  });

  await host.listenEvent('filesystem.changed', payload => {
    console.debug('[filesystem.changed]', payload);
  });

  await host.listenEvent('terminal.data', payload => {
    console.debug('[terminal.data]', {
      id: payload.id,
      stream: payload.stream,
      bytes: payload.data.length
    });
  });

  await host.listenEvent('process.exit', payload => {
    console.debug('[process.exit]', payload);
  });

  await host.listenEvent('process.data', payload => {
    console.debug('[process.data]', {
      pid: payload.pid,
      stream: payload.stream,
      bytes: payload.data.length
    });
  });

  await host.listenEvent('fallback.used', payload => {
    console.debug('[fallback.used]', payload);
  });

  await host.listenEvent('desktop.channelEvent', payload => {
    console.debug('[desktop.channelEvent]', payload);
  });
}

function normalizeReadFileBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value.map(item => Number(item) & 0xff));
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const objectValue = value as Record<string, unknown>;

  if (typeof objectValue.type === 'string' && objectValue.type === 'Buffer' && Array.isArray(objectValue.data)) {
    return Uint8Array.from(objectValue.data.map(item => Number(item) & 0xff));
  }

  if (Array.isArray(objectValue.data)) {
    return Uint8Array.from(objectValue.data.map(item => Number(item) & 0xff));
  }

  if (typeof objectValue.base64 === 'string' && objectValue.base64.length > 0) {
    try {
      const binary = atob(objectValue.base64);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i) & 0xff;
      }
      return out;
    } catch {
      // ignore and continue with other representations
    }
  }

  if (objectValue.buffer !== undefined) {
    const nested = normalizeReadFileBytes(objectValue.buffer);
    if (nested) {
      const requestedLength =
        typeof objectValue.byteLength === 'number' && Number.isFinite(objectValue.byteLength)
          ? Math.max(0, Math.floor(objectValue.byteLength))
          : undefined;
      return typeof requestedLength === 'number' ? nested.slice(0, requestedLength) : nested;
    }
  }

  const hasNumericKeys = Object.keys(objectValue).some(key => /^\d+$/.test(key));
  if (
    hasNumericKeys &&
    typeof objectValue.length === 'number' &&
    Number.isFinite(objectValue.length) &&
    objectValue.length >= 0
  ) {
    const length = Math.floor(objectValue.length);
    const bytes = Array.from({ length }, (_, index) => {
      const candidate = objectValue[String(index)];
      if (typeof candidate !== 'number') {
        return 0;
      }
      return Number(candidate) & 0xff;
    });
    return Uint8Array.from(bytes);
  }

  return undefined;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

function disposeMaybe(value: unknown): void {
  if (!value) {
    return;
  }

  if (typeof value === 'function') {
    try {
      value();
    } catch {
      // ignore cleanup errors
    }
    return;
  }

  if (typeof value === 'object' && typeof (value as { dispose?: () => void }).dispose === 'function') {
    try {
      (value as { dispose: () => void }).dispose();
    } catch {
      // ignore cleanup errors
    }
  }
}

const DISK_FS_PATCH_MARKER = '__tauriDiskFsPatched';
const OPEN_READ_STATE_BY_CLIENT = new WeakMap<object, { nextFd: number; files: Map<number, Uint8Array> }>();

function getOpenReadState(client: object): { nextFd: number; files: Map<number, Uint8Array> } {
  const existing = OPEN_READ_STATE_BY_CLIENT.get(client);
  if (existing) {
    return existing;
  }

  const created = { nextFd: 1, files: new Map<number, Uint8Array>() };
  OPEN_READ_STATE_BY_CLIENT.set(client, created);
  return created;
}

type GlobalWithVscodeFileRoot = typeof globalThis & {
  _VSCODE_FILE_ROOT?: unknown;
};

function installFileRootCompatibilityPatch(): void {
  const desiredFileRoot = new URL('/out/', window.location.origin).toString();
  const globalWithFileRoot = globalThis as GlobalWithVscodeFileRoot;
  let currentFileRoot = desiredFileRoot;

  Object.defineProperty(globalWithFileRoot, '_VSCODE_FILE_ROOT', {
    configurable: true,
    enumerable: false,
    get() {
      return currentFileRoot;
    },
    set(nextValue: unknown) {
      if (typeof nextValue === 'string' && nextValue.startsWith(desiredFileRoot)) {
        currentFileRoot = nextValue;
        return;
      }

      currentFileRoot = desiredFileRoot;
    }
  });

  globalWithFileRoot._VSCODE_FILE_ROOT = desiredFileRoot;
}

async function installFilesystemCompatibilityPatch(appRoot: string): Promise<void> {
  let newWriteableStream:
    | ((reducer: (data: Uint8Array[]) => Uint8Array) => {
        write(data: Uint8Array): void;
        error(error: Error): void;
        end(result?: Uint8Array): void;
      })
    | undefined;
  const streamModuleCandidates = [
    '/out/vs/base/common/stream.js',
    appRoot ? `/@fs${appRoot}/out/vs/base/common/stream.js` : ''
  ].filter(Boolean);
  for (const streamModulePath of streamModuleCandidates) {
    try {
      const streamModule = (await import(
        /* @vite-ignore */ streamModulePath
      )) as {
        newWriteableStream?: (
          reducer: (data: Uint8Array[]) => Uint8Array
        ) => {
          write(data: Uint8Array): void;
          error(error: Error): void;
          end(result?: Uint8Array): void;
        };
      };
      if (typeof streamModule.newWriteableStream === 'function') {
        newWriteableStream = streamModule.newWriteableStream;
        break;
      }
    } catch {
      // continue trying alternate module locations
    }
  }

  const candidatePaths = new Set<string>([
    '/out/vs/platform/files/common/diskFileSystemProviderClient.js'
  ]);
  if (appRoot) {
    candidatePaths.add(`/@fs${appRoot}/out/vs/platform/files/common/diskFileSystemProviderClient.js`);
  }

  for (const modulePath of candidatePaths) {
    try {
      const diskFsModule = (await import(
        /* @vite-ignore */ modulePath
      )) as {
        DiskFileSystemProviderClient?: { prototype?: Record<string, unknown> };
      };

      const prototype = diskFsModule.DiskFileSystemProviderClient?.prototype;
      if (!prototype) {
        continue;
      }

      if (prototype[DISK_FS_PATCH_MARKER] === true) {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'capabilities');
      if (descriptor?.get && descriptor.configurable !== false) {
        Object.defineProperty(prototype, 'capabilities', {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          get: function getPatchedCapabilities(this: unknown): number {
            const current = descriptor.get?.call(this);
            if (typeof current !== 'number') {
              return 0;
            }

            // Keep only capabilities that are implemented by the Tauri
            // localFilesystem channel to avoid the workbench taking unsupported
            // low-level paths (open/read/close, read streams, append, unlock, atomic flags).
            const unsupportedCapabilitiesMask =
              4 | // FileOpenReadWriteClose
              16 | // FileReadStream
              8192 | // FileWriteUnlock
              16384 | // FileAtomicRead
              32768 | // FileAtomicWrite
              65536 | // FileAtomicDelete
              524288; // FileAppend
            return current & ~unsupportedCapabilitiesMask;
          }
        });
      }

      const readFileImpl = prototype.readFile;
      if (typeof readFileImpl === 'function') {
        prototype.readFile = async function patchedReadFile(this: unknown, resource: unknown, opts: unknown): Promise<Uint8Array> {
          const self = this as {
            channel?: {
              call?: (command: string, arg?: unknown) => Promise<unknown>;
            };
          };

          let raw: unknown;
          if (self.channel && typeof self.channel.call === 'function') {
            try {
              raw = await self.channel.call('readFile', [resource, opts]);
            } catch {
              // Fall back to the original implementation if direct channel call fails.
              raw = await (readFileImpl as (resource: unknown, opts: unknown) => Promise<unknown>).call(this, resource, opts);
            }
          } else {
            raw = await (readFileImpl as (resource: unknown, opts: unknown) => Promise<unknown>).call(this, resource, opts);
          }

          const normalized =
            normalizeReadFileBytes(raw) ??
            (raw && typeof raw === 'object' ? normalizeReadFileBytes((raw as Record<string, unknown>).buffer) : undefined);

          const path = (resource && typeof resource === 'object' && typeof (resource as Record<string, unknown>).path === 'string')
            ? ((resource as Record<string, unknown>).path as string)
            : '<unknown>';

          if (!normalized) {
            throw new Error(
              `[tauri.compat] Unable to normalize DiskFileSystemProviderClient.readFile payload for ${path} ` +
                `(raw keys: ${
                  raw && typeof raw === 'object' ? Object.keys(raw as Record<string, unknown>).join(',') : '<non-object>'
                })`
            );
          }

          return normalized;
        };
      }

      const readFileStreamImpl = prototype.readFileStream;
      if (typeof readFileStreamImpl === 'function' && typeof newWriteableStream === 'function') {
        prototype.readFileStream = function patchedReadFileStream(
          this: unknown,
          resource: unknown,
          opts: unknown,
          token: unknown
        ) {
          const stream = newWriteableStream!(concatUint8Arrays);
          const self = this as Record<string, unknown>;
          let cancellationListener: unknown;
          if (token && typeof token === 'object') {
            const cancellationToken = token as {
              isCancellationRequested?: boolean;
              onCancellationRequested?: (callback: () => void) => unknown;
            };
            if (cancellationToken.isCancellationRequested === true) {
              stream.error(new Error('Canceled'));
              stream.end();
              return stream;
            }
            if (typeof cancellationToken.onCancellationRequested === 'function') {
              cancellationListener = cancellationToken.onCancellationRequested(() => {
                stream.error(new Error('Canceled'));
                stream.end();
              });
            }
          }

          void (async () => {
            try {
              const readFileCandidate = self.readFile;
              let bytes: Uint8Array;
              if (typeof readFileCandidate === 'function') {
                bytes = await (
                  readFileCandidate as (resource: unknown, opts: unknown) => Promise<Uint8Array>
                ).call(this, resource, opts);
              } else if (typeof readFileImpl === 'function') {
                bytes = await (
                  readFileImpl as (resource: unknown, opts: unknown) => Promise<Uint8Array>
                ).call(this, resource, opts);
              } else {
                throw new Error('readFile is unavailable');
              }

              stream.write(bytes);
              stream.end();
            } catch (error) {
              stream.error(error instanceof Error ? error : new Error(String(error)));
              stream.end();
            } finally {
              disposeMaybe(cancellationListener);
            }
          })();

          return stream;
        };
      }

      const openImpl = prototype.open;
      const readImpl = prototype.read;
      const closeImpl = prototype.close;
      if (typeof openImpl === 'function' && typeof readImpl === 'function' && typeof closeImpl === 'function') {
        prototype.open = async function patchedOpen(this: unknown, resource: unknown, opts: unknown): Promise<number> {
          const optionRecord = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : undefined;
          if (
            optionRecord?.create === true ||
            optionRecord?.unlock === true ||
            optionRecord?.write === true
          ) {
            return (openImpl as (resource: unknown, opts: unknown) => Promise<number>).call(this, resource, opts);
          }

          const self = this as Record<string, unknown>;
          const readFileCandidate = self.readFile;
          if (typeof readFileCandidate !== 'function' || !this || typeof this !== 'object') {
            return (openImpl as (resource: unknown, opts: unknown) => Promise<number>).call(this, resource, opts);
          }

          const bytes = await (
            readFileCandidate as (resource: unknown, opts: unknown) => Promise<Uint8Array>
          ).call(this, resource, opts);
          const state = getOpenReadState(this as object);
          const fd = state.nextFd++;
          state.files.set(fd, bytes);
          return fd;
        };

        prototype.read = async function patchedRead(
          this: unknown,
          fd: number,
          pos: number,
          data: Uint8Array,
          offset: number,
          length: number
        ): Promise<number> {
          if (!this || typeof this !== 'object') {
            return (readImpl as (fd: number, pos: number, data: Uint8Array, offset: number, length: number) => Promise<number>).call(
              this,
              fd,
              pos,
              data,
              offset,
              length
            );
          }

          const state = getOpenReadState(this as object);
          const bytes = state.files.get(fd);
          if (!bytes) {
            return (readImpl as (fd: number, pos: number, data: Uint8Array, offset: number, length: number) => Promise<number>).call(
              this,
              fd,
              pos,
              data,
              offset,
              length
            );
          }

          const safePos = Math.max(0, Math.floor(pos));
          const safeOffset = Math.max(0, Math.floor(offset));
          const safeLength = Math.max(0, Math.floor(length));
          const end = Math.min(bytes.byteLength, safePos + safeLength);
          const chunk = bytes.subarray(safePos, end);
          data.set(chunk, safeOffset);
          return chunk.byteLength;
        };

        prototype.close = async function patchedClose(this: unknown, fd: number): Promise<void> {
          if (this && typeof this === 'object') {
            const state = getOpenReadState(this as object);
            if (state.files.delete(fd)) {
              return;
            }
          }
          return (closeImpl as (fd: number) => Promise<void>).call(this, fd);
        };
      }

      prototype[DISK_FS_PATCH_MARKER] = true;
    } catch (error) {
      console.warn('[tauri.compat] failed to apply filesystem compatibility patch', { modulePath, error });
    }
  }
}

async function main(): Promise<void> {
  installGlobalStartupErrorHandlers();
  setStatus('Launching Tauri host...');
  const host = new HostClient();

  setStatus('Handshake with Tauri host...');
  const handshake = await host.handshake();
  const windowConfig = await host.resolveWindowConfig();
  const appRoot =
    typeof windowConfig.appRoot === 'string' ? windowConfig.appRoot : '';
  const errorModuleCandidates = [
    '/out/vs/base/common/errors.js',
    appRoot ? `/@fs${appRoot}/out/vs/base/common/errors.js` : ''
  ].filter(Boolean);
  for (const modulePath of errorModuleCandidates) {
    await installVsCodeUnexpectedErrorHookForPath(modulePath);
  }

  await attachDebugHostListeners(host);
  setStatus(
    `Host: ${handshake.serverName} ${handshake.serverVersion} | Protocol ${handshake.protocolVersion}`
  );

  setStatus('Installing desktop sandbox...');
  await installDesktopSandbox(host);
  installFileRootCompatibilityPatch();
  await installFilesystemCompatibilityPatch(appRoot);

  setStatus('Loading desktop workbench runtime...');
  const desktopWorkbenchPath = '/out/vs/code/electron-browser/workbench/workbench.js';
  await import(/* @vite-ignore */ desktopWorkbenchPath);

  for (const modulePath of errorModuleCandidates) {
    await installVsCodeUnexpectedErrorHookForPath(modulePath);
  }

  setStatus('Desktop runtime loaded. Waiting for workbench render...');
  const rendered = await waitForWorkbenchRender();
  if (rendered) {
    setStatus('', 'info', false);
    return;
  }

  setStatus(
    'Workbench did not render within 15s.\n' +
      'Run with ?hostDebug=1 and share console errors.',
    'error',
    true
  );
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  setStatus(`Startup failed:\n${message}`, 'error', true);
  console.error(error);
});
