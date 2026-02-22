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
