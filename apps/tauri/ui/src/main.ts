import { HostClient } from './hostClient';
import { installDesktopSandbox } from './desktopSandbox';

type StatusLevel = 'info' | 'error';
type StartupStepTiming = {
  label: string;
  durationMs: number;
};
type StartupLongTaskTiming = {
  name: string;
  startTime: number;
  duration: number;
};
type StartupResourceTiming = {
  name: string;
  initiatorType: string;
  startTime: number;
  duration: number;
  transferSize?: number;
};
type StartupPhaseDurations = {
  windowConfig?: number;
  cssLoader?: number;
  workbenchMainImport?: number;
  sharedProcessConnect?: number;
  postMainToRender?: number;
};
type StartupProfileReport = {
  totalStartupMs: number;
  firstRenderWaitMs: number;
  loadedWorkbenchPath: string;
  phases: StartupPhaseDurations;
  steps: StartupStepTiming[];
  longTasks: StartupLongTaskTiming[];
  topResources: StartupResourceTiming[];
  workbenchImportResources: StartupResourceTiming[];
  fallbackCounts?: Record<string, number>;
};

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

function shouldShowVerboseStartupStatus(): boolean {
  return (
    new URLSearchParams(window.location.search).get('hostDebug') === '1' ||
    (() => {
      try {
        return window.localStorage?.getItem('tauriHostDebug') === '1';
      } catch {
        return false;
      }
    })()
  );
}

function shouldEnableStartupProfile(): boolean {
  const queryValue = new URLSearchParams(window.location.search).get('startupProfile');
  if (queryValue === '1' || queryValue === 'true' || queryValue === 'on') {
    return true;
  }
  if (queryValue === '0' || queryValue === 'false' || queryValue === 'off') {
    return false;
  }

  try {
    return window.localStorage?.getItem('tauriStartupProfile') === '1';
  } catch {
    return false;
  }
}

function shouldAutoDownloadStartupProfile(): boolean {
  const queryValue = new URLSearchParams(window.location.search).get('startupProfile');
  if (queryValue === 'download') {
    return true;
  }

  try {
    return window.localStorage?.getItem('tauriStartupProfileDownload') === '1';
  } catch {
    return false;
  }
}

const WORKBENCH_BOOTSTRAP_QUERY_KEY = 'workbenchBundle';
const LEGACY_WORKBENCH_BOOTSTRAP_PATH = '/out/vs/code/electron-browser/workbench/workbench.js';
const MIN_WORKBENCH_BOOTSTRAP_PATH = '/out-vscode-min/vs/code/electron-browser/workbench/workbench.js';
const WORKBENCH_BOOTSTRAP_SUFFIX = '/vs/code/electron-browser/workbench/workbench.js';
const WORKBENCH_DESKTOP_MAIN_SUFFIX = '/vs/workbench/workbench.desktop.main.js';

function isHttpOrigin(): boolean {
  return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}

function toFileUrlFromAppRoot(appRoot: string, pathFromAppRoot: string): string {
  const root = appRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const absoluteRoot = root.startsWith('/') ? root : `/${root}`;
  const suffix = pathFromAppRoot.startsWith('/') ? pathFromAppRoot : `/${pathFromAppRoot}`;
  return encodeURI(`file://${absoluteRoot}${suffix}`).replace(/#/g, '%23');
}

function createOutModuleCandidates(appRoot: string, modulePathFromOut: string): string[] {
  const normalized = modulePathFromOut.startsWith('/') ? modulePathFromOut : `/${modulePathFromOut}`;
  const candidates = new Set<string>([
    `/out${normalized}`
  ]);
  if (appRoot) {
    if (isHttpOrigin()) {
      candidates.add(`/@fs${appRoot}/out${normalized}`);
    } else {
      candidates.add(toFileUrlFromAppRoot(appRoot, `/out${normalized}`));
    }
  }

  return [...candidates];
}

function getWorkbenchDesktopMainPath(workbenchBootstrapPath: string): string {
  if (workbenchBootstrapPath.endsWith(WORKBENCH_BOOTSTRAP_SUFFIX)) {
    return `${workbenchBootstrapPath.slice(0, -WORKBENCH_BOOTSTRAP_SUFFIX.length)}${WORKBENCH_DESKTOP_MAIN_SUFFIX}`;
  }

  if (workbenchBootstrapPath.includes('/out-vscode-min/')) {
    return '/out-vscode-min/vs/workbench/workbench.desktop.main.js';
  }

  return '/out/vs/workbench/workbench.desktop.main.js';
}

function resolveWorkbenchBootstrapCandidates(appRoot: string): string[] {
  const searchParams = new URLSearchParams(window.location.search);
  const bundleOverride = searchParams.get(WORKBENCH_BOOTSTRAP_QUERY_KEY);
  const canUseFsCandidates = isHttpOrigin();
  const isHttp = isHttpOrigin();
  const legacyCandidates = appRoot && canUseFsCandidates
    ? [LEGACY_WORKBENCH_BOOTSTRAP_PATH, `/@fs${appRoot}${LEGACY_WORKBENCH_BOOTSTRAP_PATH}`]
    : [LEGACY_WORKBENCH_BOOTSTRAP_PATH];
  const minCandidates = appRoot && canUseFsCandidates
    ? [MIN_WORKBENCH_BOOTSTRAP_PATH, `/@fs${appRoot}${MIN_WORKBENCH_BOOTSTRAP_PATH}`]
    : [MIN_WORKBENCH_BOOTSTRAP_PATH];
  const dedupe = (values: string[]): string[] => [...new Set(values)];

  if (bundleOverride === 'legacy') {
    return dedupe(legacyCandidates);
  }
  if (bundleOverride === 'min') {
    return dedupe([...minCandidates, ...legacyCandidates]);
  }

  // Keep legacy default stable until min bundle parity is validated for both
  // dev and packaged Tauri runtime shims. In packaged runtime, avoid implicit
  // fallback into min to prevent startup landing on known min-only failures.
  if (!isHttp) {
    return dedupe(legacyCandidates);
  }

  return dedupe(legacyCandidates);
}

function installWorkbenchModulePreloadHints(workbenchBootstrapCandidates: readonly string[]): void {
  if (!isHttpOrigin()) {
    return;
  }

  const moduleUrls = new Set<string>();
  const primaryBootstrapPath = workbenchBootstrapCandidates[0];
  if (primaryBootstrapPath) {
    moduleUrls.add(primaryBootstrapPath);
    moduleUrls.add(getWorkbenchDesktopMainPath(primaryBootstrapPath));
  }

  for (const moduleUrl of moduleUrls) {
    const href = new URL(moduleUrl, window.location.origin).toString();
    if (document.head.querySelector(`link[rel="modulepreload"][href="${href}"]`)) {
      continue;
    }

    const preload = document.createElement('link');
    preload.rel = 'modulepreload';
    preload.href = href;
    document.head.appendChild(preload);
  }
}

function getLatestPerformanceMark(name: string): number | undefined {
  const entries = performance.getEntriesByName(name, 'mark');
  if (entries.length === 0) {
    return undefined;
  }

  return entries[entries.length - 1].startTime;
}

function getDurationFromMarks(startMark: string, endMark: string): number | undefined {
  const start = getLatestPerformanceMark(startMark);
  const end = getLatestPerformanceMark(endMark);
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) {
    return undefined;
  }

  return Math.round(end - start);
}

function getStartupPhaseDurations(): StartupPhaseDurations {
  return {
    windowConfig: getDurationFromMarks('code/willWaitForWindowConfig', 'code/didWaitForWindowConfig'),
    cssLoader: getDurationFromMarks('code/willAddCssLoader', 'code/didAddCssLoader'),
    workbenchMainImport: getDurationFromMarks('code/willLoadWorkbenchMain', 'code/didLoadWorkbenchMain'),
    sharedProcessConnect: getDurationFromMarks('code/willConnectSharedProcess', 'code/didConnectSharedProcess'),
    postMainToRender: getDurationFromMarks('code/didLoadWorkbenchMain', 'tauri/workbenchFirstRender')
  };
}

function logStartupBreakdown(waitDurationMs: number): void {
  const phaseDurations = getStartupPhaseDurations();

  const formatted = Object.entries(phaseDurations)
    .map(([phase, ms]) => `${phase}=${typeof ms === 'number' ? `${ms}ms` : 'n/a'}`)
    .join(' ');

  console.info(`[startup.breakdown] wait=${waitDurationMs}ms ${formatted}`);
}

function collectTopStartupResources(limit = 25): StartupResourceTiming[] {
  return performance
    .getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
    .filter(entry => {
      return (
        entry.name.includes('/out/') ||
        entry.name.includes('/out-vscode-min/') ||
        entry.name.includes('/@fs/') ||
        entry.initiatorType === 'script'
      );
    })
    .sort((left, right) => right.duration - left.duration)
    .slice(0, limit)
    .map(entry => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: Math.round(entry.startTime),
      duration: Math.round(entry.duration),
      transferSize: typeof entry.transferSize === 'number' ? entry.transferSize : undefined
    }));
}

function collectWorkbenchImportResources(limit = 50): StartupResourceTiming[] {
  const importWindowStart = getLatestPerformanceMark('code/willLoadWorkbenchMain');
  const importWindowEnd = getLatestPerformanceMark('code/didLoadWorkbenchMain');
  if (typeof importWindowStart !== 'number' || typeof importWindowEnd !== 'number' || importWindowEnd < importWindowStart) {
    return [];
  }

  return performance
    .getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
    .filter(entry => entry.startTime >= importWindowStart && entry.startTime <= importWindowEnd)
    .filter(entry => entry.initiatorType === 'script' || entry.name.includes('/out/'))
    .sort((left, right) => right.duration - left.duration)
    .slice(0, limit)
    .map(entry => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: Math.round(entry.startTime - importWindowStart),
      duration: Math.round(entry.duration),
      transferSize: typeof entry.transferSize === 'number' ? entry.transferSize : undefined
    }));
}

function publishStartupProfile(report: StartupProfileReport, autoDownload: boolean): void {
  (window as Window & { __TAURI_STARTUP_PROFILE__?: StartupProfileReport }).__TAURI_STARTUP_PROFILE__ = report;
  console.info('[startup.profile]', report);

  if (!autoDownload) {
    return;
  }

  const payload = JSON.stringify(report, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tauri-startup-profile-${Date.now()}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const SHARED_PROCESS_PATCH_MARKER = '__tauriSharedProcessPatched';

async function installSharedProcessConnectionPatch(appRoot: string): Promise<void> {
  const candidatePaths = createOutModuleCandidates(
    appRoot,
    '/vs/workbench/services/sharedProcess/electron-browser/sharedProcessService.js'
  );

  for (const modulePath of candidatePaths) {
    try {
      const module = (await import(
        /* @vite-ignore */ modulePath
      )) as {
        SharedProcessService?: {
          prototype?: Record<string, unknown>;
        };
      };

      const prototype = module.SharedProcessService?.prototype;
      if (!prototype || prototype[SHARED_PROCESS_PATCH_MARKER] === true) {
        continue;
      }

      const originalConnect = prototype.connect;
      if (typeof originalConnect !== 'function') {
        continue;
      }

      prototype.connect = function patchedConnect(this: Record<string, unknown>, ...args: unknown[]) {
        this.disableMessagePortTransport = true;
        return (originalConnect as (...innerArgs: unknown[]) => unknown).apply(this, args);
      };
      prototype[SHARED_PROCESS_PATCH_MARKER] = true;
    } catch (error) {
      console.warn('[tauri.compat] failed to patch shared process connection path', { modulePath, error });
    }
  }
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
    const parts: string[] = [];
    if (error.name || error.message) {
      parts.push(`${error.name || 'Error'}: ${error.message || '<no-message>'}`);
    }
    if (error.stack && error.stack.length > 0) {
      parts.push(error.stack);
    }
    return parts.join('\n');
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

async function installVsCodeUnexpectedErrorHooks(modulePaths: readonly string[]): Promise<void> {
  for (const modulePath of [...new Set(modulePaths)]) {
    await installVsCodeUnexpectedErrorHookForPath(modulePath);
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

const TAURI_DISK_FS_CAPABILITIES_MASK =
  2 | // FileReadWrite
  8 | // FileFolderCopy
  1024 | // PathCaseSensitive
  4096 | // Trash
  131072 | // FileClone
  262144; // FileRealpath

type GlobalWithVscodeFileRoot = typeof globalThis & {
  _VSCODE_FILE_ROOT?: unknown;
  _VSCODE_TAURI_FS_CAPABILITIES_MASK?: unknown;
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
  globalWithFileRoot._VSCODE_TAURI_FS_CAPABILITIES_MASK = TAURI_DISK_FS_CAPABILITIES_MASK;
}

async function main(): Promise<void> {
  const startupStartTime = performance.now();
  installGlobalStartupErrorHandlers();
  const verboseStartupStatus = shouldShowVerboseStartupStatus();
  const startupProfileEnabled = shouldEnableStartupProfile();
  const autoDownloadStartupProfile = shouldAutoDownloadStartupProfile();
  const stepTimings: StartupStepTiming[] = [];
  const longTaskTimings: StartupLongTaskTiming[] = [];
  let longTaskObserver: PerformanceObserver | undefined;
  if (startupProfileEnabled && typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          longTaskTimings.push({
            name: entry.name,
            startTime: Math.round(entry.startTime),
            duration: Math.round(entry.duration)
          });
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
      console.info('[startup.profile] enabled');
    } catch (error) {
      console.warn('[startup.profile] failed to enable longtask observer', error);
    }
  }
  setStatus('Launching Tauri host...');
  const host = new HostClient();

  const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    setStatus(label);
    const stepStart = performance.now();
    try {
      const result = await run();
      const durationMs = Math.round(performance.now() - stepStart);
      stepTimings.push({ label, durationMs });
      if (startupProfileEnabled) {
        console.info(`[startup.step] ${label} ${durationMs}ms`);
      }
      return result;
    } catch (error) {
      const detail = formatErrorDetails(error);
      console.error('[startup.step.error]', { label, error, detail });
      throw new Error(`${label} failed:\n${detail}`);
    }
  };

  const handshake = await step('Handshake with Tauri host...', () => host.handshake());
  const windowConfig = await step('Resolving window config...', () => host.resolveWindowConfig());
  const appRoot =
    typeof windowConfig.appRoot === 'string' ? windowConfig.appRoot : '';
  console.info('[startup] using appRoot', appRoot);
  const workbenchBootstrapCandidates = resolveWorkbenchBootstrapCandidates(appRoot);
  console.info('[startup] workbench bootstrap candidates', workbenchBootstrapCandidates);
  // Kick modulepreload early so network/parse can overlap with sandbox/compat setup.
  installWorkbenchModulePreloadHints(workbenchBootstrapCandidates);
  const errorModuleCandidates = createOutModuleCandidates(appRoot, '/vs/base/common/errors.js');

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

  setStatus('Loading desktop workbench runtime...');
  const loadedWorkbenchPath = await step('Loading desktop workbench runtime...', async () => {
    const candidateFailures: string[] = [];
    for (const candidatePath of workbenchBootstrapCandidates) {
      try {
        await import(/* @vite-ignore */ candidatePath);
        return candidatePath;
      } catch (error) {
        candidateFailures.push(`${candidatePath}: ${formatErrorDetails(error)}`);
        console.warn('[startup] failed to load workbench runtime candidate', {
          candidatePath,
          error
        });
      }
    }

    const detail = candidateFailures.join('\n\n');
    throw new Error(
      detail.length > 0
        ? `Unable to load desktop workbench runtime from any candidate path.\n${detail}`
        : 'Unable to load desktop workbench runtime from any candidate path.'
    );
  });
  console.info(`[startup] loaded workbench runtime from ${loadedWorkbenchPath}`);

  if (verboseStartupStatus) {
    setStatus('Desktop runtime loaded. Waiting for workbench render...');
  } else {
    setStatus('', 'info', false);
  }

  const waitStart = performance.now();
  const rendered = await waitForWorkbenchRender();
  const waitDurationMs = Math.round(performance.now() - waitStart);
  if (rendered) {
    performance.mark('tauri/workbenchFirstRender');
  }
  if (waitDurationMs >= 500) {
    console.info(`[startup] waited ${waitDurationMs}ms for first workbench render`);
    logStartupBreakdown(waitDurationMs);
  }

  if (rendered) {
    setStatus('', 'info', false);
    const runDeferredStartupPatches = () => {
      void installSharedProcessConnectionPatch(appRoot).catch(error => {
        console.warn('[tauri.compat] shared-process compatibility patch failed', error);
      });

      void installVsCodeUnexpectedErrorHooks(errorModuleCandidates).catch(error => {
        console.warn('[tauri.compat] failed to install VS Code unexpected error hooks', error);
      });
    };

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => runDeferredStartupPatches(), { timeout: 2000 });
    } else {
      window.setTimeout(runDeferredStartupPatches, 0);
    }

    if (startupProfileEnabled) {
      let fallbackCounts: Record<string, number> | undefined;
      try {
        fallbackCounts = await host.getFallbackCounts();
      } catch (error) {
        console.warn('[startup.profile] failed to read fallback counts', error);
      }

      publishStartupProfile(
        {
          totalStartupMs: Math.round(performance.now() - startupStartTime),
          firstRenderWaitMs: waitDurationMs,
          loadedWorkbenchPath,
          phases: getStartupPhaseDurations(),
          steps: stepTimings,
          longTasks: longTaskTimings.sort((left, right) => right.duration - left.duration),
          topResources: collectTopStartupResources(),
          workbenchImportResources: collectWorkbenchImportResources(),
          fallbackCounts
        },
        autoDownloadStartupProfile
      );
    }

    longTaskObserver?.disconnect();

    return;
  }

  longTaskObserver?.disconnect();

  setStatus(
    'Workbench did not render within 15s.\n' +
      'Run with ?hostDebug=1 and share console errors.',
    'error',
    true
  );
}

main().catch(error => {
  const message =
    error instanceof Error
      ? error.message || error.stack || String(error)
      : String(error);
  setStatus(`Startup failed:\n${message}`, 'error', true);
  console.error(error);
});
