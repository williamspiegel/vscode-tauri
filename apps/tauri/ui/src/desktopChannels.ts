import { HostClient } from './hostClient';

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
      ['readFile', result => (asRecord(result).buffer instanceof Uint8Array ? result : { buffer: new Uint8Array(0) })]
    ])
  ]
]);

const EVENT_NORMALIZERS = new Map<string, Map<string, EventNormalizer>>([
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
      const normalizeResult = RESULT_NORMALIZERS.get(channel)?.get(method);
      const fallback = DEFAULT_CALL_RESPONSES.get(channel)?.get(method);

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

        return normalizeResult ? normalizeResult(result, normalized) : result;
      } catch (error) {
        if (fallback) {
          console.warn('[desktop.channelCall:fallback-default]', { channel, method, error });
          const fallbackResult = fallback(normalized);
          return normalizeResult ? normalizeResult(fallbackResult, normalized) : fallbackResult;
        }

        if (normalizeResult) {
          console.warn('[desktop.channelCall:normalized-fallback]', { channel, method, error });
          return normalizeResult(undefined, normalized);
        }

        throw error;
      }
    },
    async listen(channel, event, arg, onEvent) {
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
        console.warn('[desktop.channelListen:noop]', { channel, event, error });
        return () => {
          return;
        };
      }
    }
  };
}
