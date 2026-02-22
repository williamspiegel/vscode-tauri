import { HostClient } from './hostClient';

function readDebugFlag(
  queryKey: string,
  storageKey: string
): boolean | undefined {
  const queryValue = new URLSearchParams(window.location.search).get(queryKey);
  if (queryValue === '1') {
    return true;
  }
  if (queryValue === '0') {
    return false;
  }

  try {
    const stored = window.localStorage?.getItem(storageKey);
    if (stored === '1') {
      return true;
    }
    if (stored === '0') {
      return false;
    }
  } catch {
    // ignore storage access failures
  }

  return undefined;
}

const ENABLE_CHANNEL_TRACE = readDebugFlag('hostDebug', 'tauriHostDebug') === true;
const ENABLE_FS_TRACE = readDebugFlag('fsDebug', 'tauriFsDebug') ?? ENABLE_CHANNEL_TRACE;

export interface DesktopChannelRegistry {
  readonly channels: readonly string[];
  has(channel: string): boolean;
  call(channel: string, method: string, args: unknown[]): Promise<unknown>;
  listen(
    channel: string,
    event: string,
    arg: unknown,
    onEvent: (payload: unknown) => void
  ): Promise<() => void>;
}

type DefaultCallHandler = (args: unknown[]) => unknown;
type ResultNormalizer = (result: unknown, args: unknown[]) => unknown;
type EventNormalizer = (payload: unknown, arg: unknown) => unknown;

const BOOT_CRITICAL_CHANNELS = [
  'nativeHost',
  'storage',
  'logger',
  'policy',
  'sign',
  'userDataProfiles',
  'url',
  'workspaces',
  'keyboardLayout',
  'localFilesystem',
  'localPty',
  'update',
  'menubar',
  'externalTerminal',
  'extensionhostdebugservice',
  'extensionHostStarter',
  'extensions',
  'mcpManagement',
  'NativeMcpDiscoveryHelper',
  'userDataSync',
  'userDataSyncAccount',
  'userDataSyncStoreManagement',
  'userDataSyncMachines',
  'userDataAutoSync',
  'languagePacks',
  'extensionTipsService',
  'checksum',
  'customEndpointTelemetry',
  'remoteTunnel',
  'sharedWebContentExtractor',
  'playwright',
  'mcpGalleryManifest',
  'extensionGalleryManifest'
] as const;

const OPTIONAL_CHANNELS = [
  'watcher',
  'profileStorageListener',
  'telemetryAppender',
  'browserElements',
  'urlHandler'
] as const;

function normalizeArgs(args: unknown[]): unknown[] {
  return Array.isArray(args) ? args : [];
}

function fallbackUri(path: string): { scheme: string; authority: string; path: string } {
  return {
    scheme: 'file',
    authority: '',
    path
  };
}

function fallbackWorkspaceIdentifier(seed = 'tauri-workspace'): { id: string; configPath: string } {
  return {
    id: `${seed}-id`,
    configPath: `${seed}.code-workspace`
  };
}

function fallbackUserDataProfile(id = 'default', name = 'Default'): Record<string, unknown> {
  const base = '/tmp/vscode-tauri/profiles';
  return {
    id,
    isDefault: id === 'default',
    name,
    location: { scheme: 'file', authority: '', path: `${base}/${id}` },
    globalStorageHome: { scheme: 'file', authority: '', path: `${base}/${id}/globalStorage` },
    settingsResource: { scheme: 'file', authority: '', path: `${base}/${id}/settings.json` },
    keybindingsResource: { scheme: 'file', authority: '', path: `${base}/${id}/keybindings.json` },
    tasksResource: { scheme: 'file', authority: '', path: `${base}/${id}/tasks.json` },
    snippetsHome: { scheme: 'file', authority: '', path: `${base}/${id}/snippets` },
    promptsHome: { scheme: 'file', authority: '', path: `${base}/${id}/prompts` },
    extensionsResource: { scheme: 'file', authority: '', path: `${base}/${id}/extensions.json` },
    mcpResource: { scheme: 'file', authority: '', path: `${base}/${id}/mcp.json` },
    cacheHome: { scheme: 'file', authority: '', path: `${base}/${id}/cache` }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toUint8Array(value: unknown): Uint8Array | undefined {
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

  const objectValue = asRecord(value);
  if (typeof objectValue.type === 'string' && objectValue.type === 'Buffer' && Array.isArray(objectValue.data)) {
    return Uint8Array.from(objectValue.data.map(item => Number(item) & 0xff));
  }

  if (Array.isArray(objectValue.data)) {
    return Uint8Array.from(objectValue.data.map(item => Number(item) & 0xff));
  }

  const hasNumericKeys = Object.keys(objectValue).some(key => /^\d+$/.test(key));
  if (
    hasNumericKeys &&
    typeof objectValue.length === 'number' &&
    Number.isFinite(objectValue.length) &&
    objectValue.length >= 0
  ) {
    const asArrayLike = Array.from({ length: Math.floor(objectValue.length) }, (_, index) => {
      const candidate = objectValue[String(index)];
      if (typeof candidate !== 'number') {
        return 0;
      }
      return Number(candidate) & 0xff;
    });
    return Uint8Array.from(asArrayLike);
  }

  if (objectValue.buffer !== undefined) {
    return toUint8Array(objectValue.buffer);
  }

  return undefined;
}

function decodeBase64ToUint8Array(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i) & 0xff;
    }
    return out;
  } catch {
    return undefined;
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? '');
}

function toFileSystemError(error: unknown): Error {
  const message = normalizeErrorMessage(error);
  const fileSystemError = new Error(message);
  fileSystemError.name = 'Unknown (FileSystemError)';

  if (
    message.includes('ENOENT') ||
    message.includes('No such file or directory') ||
    message.includes('(os error 2)')
  ) {
    fileSystemError.name = 'EntryNotFound (FileSystemError)';
  } else if (
    message.includes('EEXIST') ||
    message.includes('File exists') ||
    message.includes('(os error 17)')
  ) {
    fileSystemError.name = 'EntryExists (FileSystemError)';
  } else if (
    message.includes('ENOTDIR') ||
    message.includes('Not a directory') ||
    message.includes('(os error 20)')
  ) {
    fileSystemError.name = 'EntryNotADirectory (FileSystemError)';
  } else if (
    message.includes('EISDIR') ||
    message.includes('Is a directory') ||
    message.includes('(os error 21)')
  ) {
    fileSystemError.name = 'EntryIsADirectory (FileSystemError)';
  } else if (
    message.includes('EACCES') ||
    message.includes('EPERM') ||
    message.includes('Permission denied') ||
    message.includes('(os error 13)')
  ) {
    fileSystemError.name = 'NoPermissions (FileSystemError)';
  }

  return fileSystemError;
}

function isEntryNotFoundError(error: unknown): boolean {
  const message = normalizeErrorMessage(error);
  return (
    message.includes('ENOENT') ||
    message.includes('No such file or directory') ||
    message.includes('(os error 2)')
  );
}

function inferStatTypeFromArgs(args: unknown[]): number {
  const candidate = asRecord(args[0]);
  const rawPath = typeof candidate.path === 'string' ? candidate.path : '';
  const path = rawPath.toLowerCase();
  if (!path) {
    return 2;
  }

  if (path.endsWith('/')) {
    return 2;
  }

  const last = path.split('/').pop() ?? '';
  if (!last) {
    return 2;
  }

  const knownDirNames = new Set([
    'user',
    'profiles',
    'default',
    'snippets',
    'prompts',
    'logs',
    'cache',
    'globalstorage',
    'workspace',
    'tmp'
  ]);
  if (knownDirNames.has(last)) {
    return 2;
  }

  return last.includes('.') ? 1 : 2;
}

function createWorkspaceNavigationUrl(key: 'folder' | 'workspace', path: string): string {
  return `${window.location.origin}${window.location.pathname}?${key}=${encodeURIComponent(path)}`;
}

function extractPickedPath(result: unknown): string | undefined {
  const payload = asRecord(result);
  if (payload.canceled === true) {
    return undefined;
  }

  const filePaths = asArray<string>(payload.filePaths).filter((value): value is string => typeof value === 'string');
  if (filePaths.length > 0) {
    return filePaths[0];
  }

  if (typeof payload.filePath === 'string') {
    return payload.filePath;
  }

  return undefined;
}

async function handleNativeHostPickAndOpen(host: HostClient, method: string, args: unknown[]): Promise<null> {
  const options = asRecord(args[0]);
  const forceNewWindow = options.forceNewWindow === true;
  const forceReuseWindow = options.forceReuseWindow === true;
  const dialogProperties =
    method === 'pickWorkspaceAndOpen'
      ? ['openFile', 'createDirectory']
      : method === 'pickFileFolderAndOpen'
        ? ['openFile', 'openDirectory', 'createDirectory']
        : ['openDirectory', 'createDirectory'];

  try {
    const result = await host.desktopChannelCall('nativeHost', 'showOpenDialog', [
      {
        title: method === 'pickWorkspaceAndOpen' ? 'Open Workspace' : 'Open Folder',
        properties: dialogProperties
      }
    ]);

    const pickedPath = extractPickedPath(result);
    if (!pickedPath) {
      return null;
    }

    const key: 'folder' | 'workspace' =
      method === 'pickWorkspaceAndOpen' || pickedPath.toLowerCase().endsWith('.code-workspace') ? 'workspace' : 'folder';
    const targetUrl = createWorkspaceNavigationUrl(key, pickedPath);

    if (forceNewWindow && !forceReuseWindow) {
      const opened = window.open(targetUrl, '_blank', 'toolbar=no');
      if (!opened) {
        window.location.href = targetUrl;
      }
      return null;
    }

    window.location.href = targetUrl;
    return null;
  } catch (error) {
    if (ENABLE_CHANNEL_TRACE) {
      console.warn('[desktop.nativeHost.pickAndOpen.failed]', { method, options, error });
    }
    return null;
  }
}

const DEFAULT_CALL_RESPONSES = new Map<string, Map<string, DefaultCallHandler>>([
  [
    'logger',
    new Map<string, DefaultCallHandler>([
      ['getRegisteredLoggers', () => []],
      ['createLogger', () => null],
      ['log', () => null],
      ['consoleLog', () => null],
      ['registerLogger', () => null],
      ['deregisterLogger', () => null],
      ['setLogLevel', () => null],
      ['setVisibility', () => null]
    ])
  ],
  [
    'storage',
    new Map<string, DefaultCallHandler>([
      ['getItems', () => []],
      ['updateItems', () => null],
      ['optimize', () => null],
      ['isUsed', () => false]
    ])
  ],
  [
    'policy',
    new Map<string, DefaultCallHandler>([['updatePolicyDefinitions', () => ({})]])
  ],
  [
    'sign',
    new Map<string, DefaultCallHandler>([
      ['sign', args => (typeof args[0] === 'string' ? args[0] : '')],
      ['createNewMessage', args => ({ id: 'tauri-sign-message', data: typeof args[0] === 'string' ? args[0] : '' })],
      ['validate', () => true]
    ])
  ],
  [
    'url',
    new Map<string, DefaultCallHandler>([
      ['open', () => true],
      ['handleURL', () => true]
    ])
  ],
  [
    'workspaces',
    new Map<string, DefaultCallHandler>([
      ['getRecentlyOpened', () => ({ workspaces: [], files: [] })],
      ['getDirtyWorkspaces', () => []],
      ['getWorkspaceIdentifier', () => fallbackWorkspaceIdentifier('tauri-existing')],
      ['createUntitledWorkspace', () => fallbackWorkspaceIdentifier('tauri-untitled')],
      ['enterWorkspace', () => ({ workspace: fallbackWorkspaceIdentifier('tauri-entered') })],
      ['addRecentlyOpened', () => null],
      ['removeRecentlyOpened', () => null],
      ['clearRecentlyOpened', () => null],
      ['deleteUntitledWorkspace', () => null]
    ])
  ],
  [
    'userDataProfiles',
    new Map<string, DefaultCallHandler>([
      ['createNamedProfile', args => fallbackUserDataProfile('named', typeof args[0] === 'string' ? args[0] : 'Named')],
      ['createProfile', args => fallbackUserDataProfile(typeof args[0] === 'string' ? args[0] : 'profile', typeof args[1] === 'string' ? args[1] : 'Profile')],
      ['createTransientProfile', () => fallbackUserDataProfile('transient', 'Transient')],
      ['updateProfile', args => (typeof args[0] === 'object' && args[0] ? args[0] : fallbackUserDataProfile('updated', 'Updated'))],
      ['removeProfile', () => null],
      ['setProfileForWorkspace', () => null],
      ['resetWorkspaces', () => null],
      ['cleanUp', () => null],
      ['cleanUpTransientProfiles', () => null]
    ])
  ],
  [
    'keyboardLayout',
    new Map<string, DefaultCallHandler>([
      [
        'getKeyboardLayoutData',
        () => ({
          keyboardLayoutInfo: {
            id: 'tauri-us',
            lang: 'en',
            layout: 'US'
          },
          keyboardMapping: {}
        })
      ]
    ])
  ],
  [
    'nativeHost',
    new Map<string, DefaultCallHandler>([
      ['notifyReady', () => null],
      ['focusWindow', () => null],
      ['openWindow', () => null],
      ['openSessionsWindow', () => null],
      ['toggleFullScreen', () => null],
      ['setBackgroundThrottling', () => null],
      ['saveWindowSplash', () => null],
      ['setRepresentedFilename', () => null],
      ['setDocumentEdited', () => null],
      ['openDevTools', () => null],
      ['toggleDevTools', () => null],
      ['reload', () => null],
      ['relaunch', () => null],
      ['quit', () => null],
      ['exit', () => null],
      ['showItemInFolder', () => null],
      ['pickFileFolderAndOpen', () => null],
      ['pickFileAndOpen', () => null],
      ['pickFolderAndOpen', () => null],
      ['pickWorkspaceAndOpen', () => null],
      ['isFullScreen', () => false],
      ['isMaximized', () => false],
      ['isWindowAlwaysOnTop', () => false],
      ['isOnBatteryPower', () => false],
      ['getWindowCount', () => 1],
      ['getActiveWindowId', () => 1],
      ['getProcessId', () => 1],
      ['getWindows', () => []],
      ['getOSColorScheme', () => ({ dark: false, highContrast: false })],
      [
        'getOSProperties',
        () => ({
          type: 'Darwin',
          release: '0.0.0',
          arch: 'x64',
          platform: 'darwin',
          cpus: []
        })
      ],
      ['getOSStatistics', () => ({ totalmem: 0, freemem: 0, loadavg: [0, 0, 0] })],
      ['getSystemIdleState', () => 'active'],
      ['getSystemIdleTime', () => 0],
      ['getCurrentThermalState', () => 'nominal'],
      ['startPowerSaveBlocker', () => 1],
      ['isPowerSaveBlockerStarted', () => false],
      ['stopPowerSaveBlocker', () => true],
      ['showMessageBox', () => ({ response: 0, checkboxChecked: false })],
      ['showOpenDialog', () => ({ canceled: true, filePaths: [] })],
      ['showSaveDialog', () => ({ canceled: true })],
      ['openExternal', () => true],
      ['readClipboardText', () => ''],
      ['readClipboardFindText', () => ''],
      ['writeClipboardText', () => null],
      ['writeClipboardFindText', () => null],
      ['readImage', () => []],
      ['isAdmin', () => false],
      ['hasWSLFeatureInstalled', () => false],
      ['isRunningUnderARM64Translation', () => false],
      ['resolveProxy', () => undefined]
    ])
  ],
  [
    'extensionHostStarter',
    new Map<string, DefaultCallHandler>([
      ['createExtensionHost', () => ({ id: 'tauri-extension-host' })],
      ['start', () => ({ pid: undefined })],
      ['enableInspectPort', () => false],
      ['kill', () => null]
    ])
  ],
  [
    'externalTerminal',
    new Map<string, DefaultCallHandler>([
      ['openTerminal', () => null],
      ['runInTerminal', () => undefined],
      [
        'getDefaultTerminalForPlatforms',
        () => ({
          windows: 'cmd.exe',
          linux: 'xterm',
          osx: 'Terminal.app'
        })
      ]
    ])
  ],
  [
    'localPty',
    new Map<string, DefaultCallHandler>([
      ['getPerformanceMarks', () => []],
      ['getLatency', () => []],
      ['getProfiles', () => []],
      ['getDefaultSystemShell', () => '/bin/zsh'],
      ['getEnvironment', () => ({})],
      ['getShellEnvironment', () => ({})],
      ['getTerminalLayoutInfo', () => undefined],
      ['setTerminalLayoutInfo', () => null],
      ['reduceConnectionGraceTime', () => null],
      ['persistTerminalState', () => null],
      ['requestDetachInstance', () => undefined],
      ['acceptDetachInstanceReply', () => null]
    ])
  ],
  [
    'localFilesystem',
    new Map<string, DefaultCallHandler>([
      ['stat', args => ({ type: inferStatTypeFromArgs(args), ctime: 0, mtime: 0, size: 0 })],
      ['realpath', () => '/'],
      ['readdir', () => []],
      ['readFile', () => ({ buffer: new Uint8Array(0) })],
      ['writeFile', () => null],
      ['mkdir', () => null],
      ['delete', () => null],
      ['rename', () => null],
      ['copy', () => null],
      ['cloneFile', () => null],
      ['open', () => 1],
      ['close', () => null],
      ['read', () => [{ buffer: new Uint8Array(0) }, 0]],
      ['write', () => 0],
      ['watch', () => null],
      ['unwatch', () => null]
    ])
  ]
]);

const RESULT_NORMALIZERS = new Map<string, Map<string, ResultNormalizer>>([
  [
    'extensions',
    new Map<string, ResultNormalizer>([
      ['getInstalled', result => (Array.isArray(result) ? result : [])],
      [
        'getExtensionsControlManifest',
        result => {
          const objectResult = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
          return {
            malicious: Array.isArray(objectResult.malicious) ? objectResult.malicious : [],
            deprecated: objectResult.deprecated && typeof objectResult.deprecated === 'object' ? objectResult.deprecated : {},
            search: objectResult.search && typeof objectResult.search === 'object' ? objectResult.search : {},
            autoUpdate: objectResult.autoUpdate && typeof objectResult.autoUpdate === 'object' ? objectResult.autoUpdate : {}
          };
        }
      ]
    ])
  ],
  [
    'mcpManagement',
    new Map<string, ResultNormalizer>([['getInstalled', result => (Array.isArray(result) ? result : [])]])
  ],
  [
    'userDataSync',
    new Map<string, ResultNormalizer>([
      [
        '_getInitialData',
        result => {
          if (!Array.isArray(result) || result.length !== 3) {
            return ['uninitialized', [], undefined];
          }

          const [status, conflicts, lastSyncTime] = result;
          return [
            typeof status === 'string' ? status : 'uninitialized',
            Array.isArray(conflicts) ? conflicts : [],
            typeof lastSyncTime === 'number' ? lastSyncTime : undefined
          ];
        }
      ]
    ])
  ],
  [
    'userDataSyncStoreManagement',
    new Map<string, ResultNormalizer>([
      [
        'getPreviousUserDataSyncStore',
        result => {
          const objectResult = result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
          if (objectResult?.url && objectResult?.defaultUrl && objectResult?.insidersUrl && objectResult?.stableUrl) {
            return objectResult;
          }

          const fallbackStore = fallbackUri('/tmp/vscode-tauri/sync');
          return {
            url: fallbackStore,
            type: 'stable',
            defaultUrl: fallbackStore,
            insidersUrl: fallbackStore,
            stableUrl: fallbackStore,
            canSwitch: false,
            authenticationProviders: {}
          };
        }
      ]
    ])
  ],
  [
    'update',
    new Map<string, ResultNormalizer>([
      ['_getInitialState', result => (result && typeof result === 'object' ? result : { type: 'uninitialized' })]
    ])
  ],
  [
    'extensionHostStarter',
    new Map<string, ResultNormalizer>([
      ['createExtensionHost', result => (typeof asRecord(result).id === 'string' ? result : { id: 'tauri-extension-host' })],
      [
        'start',
        result => {
          const objectResult = asRecord(result);
          return {
            pid: typeof objectResult.pid === 'number' ? objectResult.pid : undefined
          };
        }
      ]
    ])
  ],
  [
    'externalTerminal',
    new Map<string, ResultNormalizer>([
      [
        'getDefaultTerminalForPlatforms',
        result => {
          const terminals = asRecord(result);
          return {
            windows: typeof terminals.windows === 'string' ? terminals.windows : 'cmd.exe',
            linux: typeof terminals.linux === 'string' ? terminals.linux : 'xterm',
            osx: typeof terminals.osx === 'string' ? terminals.osx : 'Terminal.app'
          };
        }
      ]
    ])
  ],
  [
    'localPty',
    new Map<string, ResultNormalizer>([
      ['getPerformanceMarks', result => asArray(result)],
      ['getLatency', result => asArray(result)],
      ['getProfiles', result => asArray(result)],
      ['getDefaultSystemShell', result => (typeof result === 'string' ? result : '/bin/zsh')],
      ['getEnvironment', result => (result && typeof result === 'object' ? result : {})],
      ['getShellEnvironment', result => (result && typeof result === 'object' ? result : {})]
    ])
  ],
  [
    'localFilesystem',
    new Map<string, ResultNormalizer>([
      [
        'stat',
        (result, args) => {
          const stat = asRecord(result);
          return {
            type: typeof stat.type === 'number' ? stat.type : inferStatTypeFromArgs(args),
            ctime: typeof stat.ctime === 'number' ? stat.ctime : 0,
            mtime: typeof stat.mtime === 'number' ? stat.mtime : 0,
            size: typeof stat.size === 'number' ? stat.size : 0
          };
        }
      ],
      ['readdir', result => asArray(result)],
      [
        'readFile',
        (result, args) => {
          const payload = asRecord(result);
          const decoded =
            toUint8Array(payload.buffer) ??
            toUint8Array(payload.bytes) ??
            toUint8Array(payload.data) ??
            decodeBase64ToUint8Array(payload.base64) ??
            toUint8Array(result);
          if (!decoded) {
            const arg0 = asRecord(args[0]);
            const path =
              (typeof arg0.fsPath === 'string' ? arg0.fsPath : undefined) ??
              (typeof arg0.path === 'string' ? arg0.path : undefined) ??
              '';
            throw toFileSystemError(
              new Error(
                `Unable to decode localFilesystem.readFile payload for '${path}' with keys [${Object.keys(payload).join(', ')}]`
              )
            );
          }

          // Keep a legacy-compatible shape (`buffer: number[]`) so existing
          // DiskFileSystemProviderClient builds can decode without needing
          // the newer base64-aware normalizer.
          return Array.from(decoded);
        }
      ]
    ])
  ]
]);

const EVENT_NORMALIZERS = new Map<string, Map<string, EventNormalizer>>([
  [
    'nativeHost',
    new Map<string, EventNormalizer>([
      [
        'onDidChangeWindowAlwaysOnTop',
        payload => {
          const event = asRecord(payload);
          return {
            windowId: typeof event.windowId === 'number' ? event.windowId : 1,
            alwaysOnTop: event.alwaysOnTop === true
          };
        }
      ],
      [
        'onDidChangeColorScheme',
        payload => {
          const event = asRecord(payload);
          return {
            dark: event.dark === true,
            highContrast: event.highContrast === true
          };
        }
      ]
    ])
  ],
  [
    'userDataSync',
    new Map<string, EventNormalizer>([
      ['onDidChangeConflicts', payload => asArray(payload)],
      ['onSyncErrors', payload => asArray(payload)]
    ])
  ],
  [
    'userDataProfiles',
    new Map<string, EventNormalizer>([
      [
        'onDidChangeProfiles',
        payload => {
          const event = asRecord(payload);
          return {
            all: asArray(event.all),
            added: asArray(event.added),
            removed: asArray(event.removed),
            updated: asArray(event.updated)
          };
        }
      ]
    ])
  ],
  [
    'storage',
    new Map<string, EventNormalizer>([
      [
        'onDidChangeStorage',
        payload => {
          const event = asRecord(payload);
          return {
            changed: Array.isArray(event.changed) ? event.changed : undefined,
            deleted: Array.isArray(event.deleted) ? event.deleted : undefined
          };
        }
      ]
    ])
  ],
  [
    'mcpManagement',
    new Map<string, EventNormalizer>([
      ['onDidInstallMcpServers', payload => asArray(payload)],
      ['onDidUpdateMcpServers', payload => asArray(payload)],
      ['onInstallMcpServer', payload => (payload && typeof payload === 'object' ? payload : {})],
      ['onUninstallMcpServer', payload => (payload && typeof payload === 'object' ? payload : {})],
      ['onDidUninstallMcpServer', payload => (payload && typeof payload === 'object' ? payload : {})]
    ])
  ],
  [
    'localFilesystem',
    new Map<string, EventNormalizer>([['fileChange', payload => (Array.isArray(payload) || typeof payload === 'string' ? payload : [])]])
  ],
  [
    'watcher',
    new Map<string, EventNormalizer>([
      [
        'onDidChangeFile',
        payload => (Array.isArray(payload) ? payload : [])
      ],
      [
        'onDidLogMessage',
        payload => {
          const event = asRecord(payload);
          const type = typeof event.type === 'string' ? event.type : 'trace';
          const message =
            typeof event.message === 'string'
              ? event.message
              : typeof payload === 'string'
                ? payload
                : '';
          return { type, message };
        }
      ],
      [
        'onDidError',
        payload => {
          const event = asRecord(payload);
          const error =
            typeof event.error === 'string'
              ? event.error
              : typeof event.message === 'string'
                ? event.message
              : typeof payload === 'string'
                ? payload
                : undefined;
          if (typeof error !== 'string' || error.length === 0) {
            return {};
          }
          const request = event.request;
          return request ? { error, request } : { error };
        }
      ]
    ])
  ],
  [
    'extensionHostStarter',
    new Map<string, EventNormalizer>([
      ['onDynamicExit', payload => (payload && typeof payload === 'object' ? payload : { code: 0, signal: '' })]
    ])
  ]
]);

export function createDesktopChannelRegistry(host: HostClient): DesktopChannelRegistry {
  const channels = [...BOOT_CRITICAL_CHANNELS, ...OPTIONAL_CHANNELS];
  const channelSet: Set<string> = new Set(channels as readonly string[]);

  return {
    channels,
    has(channel) {
      return channelSet.has(channel);
    },
    async call(channel, method, args) {
      const normalized = normalizeArgs(args);
      if (ENABLE_FS_TRACE && channel === 'localFilesystem') {
        const target = asRecord(normalized[0]);
        const path =
          (typeof target.fsPath === 'string' ? target.fsPath : undefined) ??
          (typeof target.path === 'string' ? target.path : undefined) ??
          undefined;
        console.debug('[desktop.fs.call]', { method, path });
      }
      if (
        channel === 'nativeHost' &&
        (method === 'pickFolderAndOpen' || method === 'pickFileFolderAndOpen' || method === 'pickWorkspaceAndOpen')
      ) {
        return handleNativeHostPickAndOpen(host, method, normalized);
      }
      const normalizeResult = RESULT_NORMALIZERS.get(channel)?.get(method);
      const fallback = channel === 'localFilesystem' ? undefined : DEFAULT_CALL_RESPONSES.get(channel)?.get(method);

      try {
        const result = await host.desktopChannelCall(channel, method, normalized);
        if (result == null) {
          if (fallback) {
            const fallbackResult = fallback(normalized);
            return normalizeResult ? normalizeResult(fallbackResult, normalized) : fallbackResult;
          }
          if (normalizeResult) {
            return normalizeResult(undefined, normalized);
          }
        }

        const normalizedResult = normalizeResult ? normalizeResult(result, normalized) : result;
        if (ENABLE_FS_TRACE && channel === 'localFilesystem') {
          if (method === 'readFile') {
            const byteLength =
              normalizedResult instanceof Uint8Array
                ? normalizedResult.byteLength
                : Array.isArray(normalizedResult)
                  ? normalizedResult.length
                  : undefined;
            console.debug('[desktop.fs.result]', { method, byteLength });
          } else {
            console.debug('[desktop.fs.result]', { method });
          }
        }

        return normalizedResult;
      } catch (error) {
        if (channel === 'localFilesystem') {
          if (ENABLE_FS_TRACE) {
            const target = asRecord(normalized[0]);
            const path =
              (typeof target.fsPath === 'string' ? target.fsPath : undefined) ??
              (typeof target.path === 'string' ? target.path : undefined) ??
              undefined;
            const errorMessage = normalizeErrorMessage(error);
            const expectedNotFoundProbe =
              isEntryNotFoundError(error) && (method === 'stat' || method === 'readdir');
            if (expectedNotFoundProbe) {
              console.debug('[desktop.fs.miss]', { method, path, errorMessage });
            } else {
              console.error('[desktop.fs.error]', { method, path, errorMessage });
            }
          }
          throw toFileSystemError(error);
        }

        if (fallback) {
          if (ENABLE_CHANNEL_TRACE) {
            console.warn('[desktop.channelCall:fallback-default]', { channel, method, error });
          }
          const fallbackResult = fallback(normalized);
          return normalizeResult ? normalizeResult(fallbackResult, normalized) : fallbackResult;
        }

        if (normalizeResult) {
          if (ENABLE_CHANNEL_TRACE) {
            console.warn('[desktop.channelCall:normalized-fallback]', { channel, method, error });
          }
          return normalizeResult(undefined, normalized);
        }

        throw error;
      }
    },
    async listen(channel, event, arg, onEvent) {
      if (ENABLE_FS_TRACE && channel === 'localFilesystem') {
        console.debug('[desktop.fs.listen]', { event });
      }
      if (channel === 'localFilesystem' && event === 'readFileStream') {
        let stop: (() => Promise<void>) | undefined;
        let didReceiveStreamPayload = false;
        let fallbackActive = false;
        let streamClosed = false;
        let streamChunkCount = 0;
        let streamTotalBytes = 0;
        const streamArgs = Array.isArray(arg) ? arg : [arg];
        const readTarget = streamArgs[0];
        const readOptions = streamArgs.length > 1 ? streamArgs[1] : undefined;

        const emitDecodedBytes = (bytes: Uint8Array): void => {
          if (streamClosed) {
            return;
          }
          streamChunkCount += 1;
          streamTotalBytes += bytes.byteLength;
          if (ENABLE_FS_TRACE) {
            console.debug('[desktop.fs.stream.chunk]', {
              bytes: bytes.byteLength,
              chunks: streamChunkCount,
              totalBytes: streamTotalBytes
            });
          }
          onEvent(bytes);
        };

        const emitStreamEnd = (): void => {
          if (streamClosed) {
            return;
          }
          streamClosed = true;
          if (ENABLE_FS_TRACE) {
            console.debug('[desktop.fs.stream.end]', {
              chunks: streamChunkCount,
              totalBytes: streamTotalBytes
            });
          }
          onEvent('end');
        };

        const fallbackTimer = window.setTimeout(() => {
          if (didReceiveStreamPayload || fallbackActive || streamClosed) {
            return;
          }

          if (typeof readTarget === 'undefined') {
            onEvent(
              toFileSystemError(new Error('readFileStream fallback missing resource argument'))
            );
            return;
          }

          fallbackActive = true;
          void host
            .desktopChannelCall('localFilesystem', 'readFile', [readTarget, readOptions])
            .then(result => {
              const payload = asRecord(result);
              const decoded =
                toUint8Array(payload.buffer) ??
                toUint8Array(payload.bytes) ??
                toUint8Array(payload.data) ??
                decodeBase64ToUint8Array(payload.base64) ??
                toUint8Array(result);
              if (!decoded) {
                onEvent(
                  toFileSystemError(new Error('Invalid readFile fallback payload for readFileStream'))
                );
                return;
              }

              emitDecodedBytes(decoded);
              emitStreamEnd();
            })
            .catch(error => {
              if (!streamClosed) {
                streamClosed = true;
                if (ENABLE_FS_TRACE) {
                  console.error('[desktop.fs.stream.fallback.error]', {
                    errorMessage: normalizeErrorMessage(error)
                  });
                }
                onEvent(toFileSystemError(error));
              }
            });
        }, 250);

        try {
          stop = await host.desktopChannelListen(channel, event, arg, payload => {
            if (fallbackActive) {
              return;
            }

            didReceiveStreamPayload = true;
            window.clearTimeout(fallbackTimer);

            if (payload === 'end') {
              emitStreamEnd();
              return;
            }

            if (payload instanceof Error) {
              if (ENABLE_FS_TRACE) {
                console.error('[desktop.fs.stream.error]', {
                  errorMessage: payload.message
                });
              }
              onEvent(payload);
              return;
            }

            const payloadRecord = asRecord(payload);
            const decoded =
              toUint8Array(payloadRecord.buffer) ??
              toUint8Array(payloadRecord.bytes) ??
              toUint8Array(payloadRecord.data) ??
              decodeBase64ToUint8Array(payloadRecord.base64) ??
              toUint8Array(payload);
            if (decoded) {
              emitDecodedBytes(decoded);
              return;
            }

            if (
              typeof payloadRecord.message === 'string' ||
              typeof payloadRecord.name === 'string' ||
              typeof payloadRecord.code === 'string'
            ) {
              const message =
                typeof payloadRecord.message === 'string'
                  ? payloadRecord.message
                  : 'Unknown readFileStream error';
              const streamError = {
                message,
                name:
                  typeof payloadRecord.name === 'string'
                    ? payloadRecord.name
                    : undefined,
                code:
                  typeof payloadRecord.code === 'string'
                    ? payloadRecord.code
                    : undefined
              };
              if (!streamClosed) {
                streamClosed = true;
                if (ENABLE_FS_TRACE) {
                  console.error('[desktop.fs.stream.error]', {
                    errorMessage: message,
                    errorName: streamError.name,
                    errorCode: streamError.code
                  });
                }
                onEvent(streamError);
              }
              return;
            }

            if (!streamClosed) {
              streamClosed = true;
              if (ENABLE_FS_TRACE) {
                console.error('[desktop.fs.stream.error]', {
                  errorMessage: 'Invalid readFileStream payload from host'
                });
              }
              onEvent(toFileSystemError(new Error('Invalid readFileStream payload from host')));
            }
          });
        } catch (error) {
          window.clearTimeout(fallbackTimer);
          fallbackActive = true;
          if (typeof readTarget === 'undefined') {
            onEvent(toFileSystemError(error));
          } else {
            try {
              const result = await host.desktopChannelCall('localFilesystem', 'readFile', [readTarget, readOptions]);
              const payload = asRecord(result);
              const decoded =
                toUint8Array(payload.buffer) ??
                toUint8Array(payload.bytes) ??
                toUint8Array(payload.data) ??
                decodeBase64ToUint8Array(payload.base64) ??
                toUint8Array(result);
              if (!decoded) {
                onEvent(toFileSystemError(new Error('Invalid readFile fallback payload for readFileStream')));
              } else {
                emitDecodedBytes(decoded);
                emitStreamEnd();
              }
            } catch (fallbackError) {
              onEvent(toFileSystemError(fallbackError));
            }
          }
          return async () => {
            return;
          };
        }
        return async () => {
          fallbackActive = true;
          streamClosed = true;
          window.clearTimeout(fallbackTimer);
          await stop?.();
        };
      }

      const normalizeEvent = EVENT_NORMALIZERS.get(channel)?.get(event);
      const normalizeEventByName: EventNormalizer | undefined =
        event === 'onDidChangeStorage'
          ? payload => {
              const e = asRecord(payload);
              return {
                changed: Array.isArray(e.changed) ? e.changed : undefined,
                deleted: Array.isArray(e.deleted) ? e.deleted : undefined
              };
            }
          : event === 'onDidChangeProfiles'
            ? payload => {
                const e = asRecord(payload);
                return {
                  all: asArray(e.all),
                  added: asArray(e.added),
                  removed: asArray(e.removed),
                  updated: asArray(e.updated)
                };
              }
            : undefined;
      try {
        const stop = await host.desktopChannelListen(channel, event, arg, payload => {
          const effectiveNormalizer = normalizeEvent ?? normalizeEventByName;
          onEvent(effectiveNormalizer ? effectiveNormalizer(payload, arg) : payload);
        });
        return async () => {
          await stop();
        };
      } catch (error) {
        if (ENABLE_FS_TRACE && channel === 'localFilesystem') {
          const errorMessage = normalizeErrorMessage(error);
          console.error('[desktop.fs.listen.error]', { event, errorMessage });
        }
        if (ENABLE_CHANNEL_TRACE) {
          console.warn('[desktop.channelListen:noop]', { channel, event, error });
        }
        return () => {
          return;
        };
      }
    }
  };
}
