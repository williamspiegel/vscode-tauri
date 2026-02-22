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
  const debugEnabled =
    new URLSearchParams(window.location.search).get('hostDebug') === '1' ||
    (() => {
      try {
        return window.localStorage?.getItem('tauriHostDebug') === '1';
      } catch {
        return false;
      }
    })();
  if (!debugEnabled) {
    return;
  }

  const tryListen = async <E extends Parameters<HostClient['listenEvent']>[0]>(
    eventName: E,
    handler: Parameters<HostClient['listenEvent']>[1]
  ): Promise<void> => {
    try {
      await host.listenEvent(eventName, handler as never);
    } catch (error) {
      console.warn('[tauri.logs] failed to attach debug listener', { eventName, error });
    }
  };

  await tryListen('host.lifecycle', payload => {
    console.debug('[host.lifecycle]', payload);
  });

  await tryListen('filesystem.changed', payload => {
    console.debug('[filesystem.changed]', payload);
  });

  await tryListen('terminal.data', payload => {
    console.debug('[terminal.data]', {
      id: payload.id,
      stream: payload.stream,
      bytes: payload.data.length
    });
  });

  await tryListen('process.exit', payload => {
    console.debug('[process.exit]', payload);
  });

  await tryListen('process.data', payload => {
    console.debug('[process.data]', {
      pid: payload.pid,
      stream: payload.stream,
      bytes: payload.data.length
    });
  });

  await tryListen('fallback.used', payload => {
    console.debug('[fallback.used]', payload);
  });

  await tryListen('desktop.channelEvent', payload => {
    console.debug('[desktop.channelEvent]', payload);
  });
}

const DISK_FS_PATCH_MARKER = '__tauriDiskFsPatched';

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

      // Disable legacy read/open monkey-patch path; it is fragile in the
      // Tauri runtime and can throw during startup with unexpected call contexts.
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

  const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    setStatus(label);
    try {
      return await run();
    } catch (error) {
      const detail = formatErrorDetails(error);
      throw new Error(`${label} failed:\n${detail}`);
    }
  };

  const handshake = await step('Handshake with Tauri host...', () => host.handshake());
  const windowConfig = await step('Resolving window config...', () => host.resolveWindowConfig());
  const appRoot =
    typeof windowConfig.appRoot === 'string' ? windowConfig.appRoot : '';
  const errorModuleCandidates = [
    '/out/vs/base/common/errors.js',
    appRoot ? `/@fs${appRoot}/out/vs/base/common/errors.js` : ''
  ].filter(Boolean);
  for (const modulePath of errorModuleCandidates) {
    await installVsCodeUnexpectedErrorHookForPath(modulePath);
  }

  try {
    await attachDebugHostListeners(host);
  } catch (error) {
    console.warn('[startup] failed to attach debug listeners', error);
  }
  setStatus(
    `Host: ${handshake.serverName} ${handshake.serverVersion} | Protocol ${handshake.protocolVersion}`
  );

  await step('Installing desktop sandbox...', () => installDesktopSandbox(host));
  installFileRootCompatibilityPatch();
  await step('Installing filesystem compatibility patch...', () => installFilesystemCompatibilityPatch(appRoot));

  setStatus('Loading desktop workbench runtime...');
  const desktopWorkbenchPath = '/out/vs/code/electron-browser/workbench/workbench.js';
  await step('Loading desktop workbench runtime...', () => import(/* @vite-ignore */ desktopWorkbenchPath).then(() => undefined));

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
