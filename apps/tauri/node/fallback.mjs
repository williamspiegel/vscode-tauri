#!/usr/bin/env node

import crypto from 'node:crypto';
import { stdin, stdout, stderr, env, pid, platform, arch } from 'node:process';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

function writeJson(value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function normalizeRequest(raw) {
  const request = raw && typeof raw === 'object' ? raw : {};
  if (request.kind === 'channel' || request.channel) {
    return {
      kind: 'channel',
      channel: String(request.channel ?? 'unknown'),
      method: String(request.method ?? 'unknown'),
      args: Array.isArray(request.args) ? request.args : []
    };
  }

  return {
    kind: 'capability',
    domain: String(request.domain ?? 'unknown'),
    method: String(request.method ?? 'unknown'),
    params: request.params && typeof request.params === 'object' ? request.params : {}
  };
}

function fallbackProfile(id = 'default', name = 'Default') {
  const root = '/tmp/vscode-tauri/profiles';
  return {
    id,
    isDefault: id === 'default',
    name,
    location: { scheme: 'file', authority: '', path: `${root}/${id}` },
    globalStorageHome: { scheme: 'file', authority: '', path: `${root}/${id}/globalStorage` },
    settingsResource: { scheme: 'file', authority: '', path: `${root}/${id}/settings.json` },
    keybindingsResource: { scheme: 'file', authority: '', path: `${root}/${id}/keybindings.json` },
    tasksResource: { scheme: 'file', authority: '', path: `${root}/${id}/tasks.json` },
    snippetsHome: { scheme: 'file', authority: '', path: `${root}/${id}/snippets` },
    promptsHome: { scheme: 'file', authority: '', path: `${root}/${id}/prompts` },
    extensionsResource: { scheme: 'file', authority: '', path: `${root}/${id}/extensions.json` },
    mcpResource: { scheme: 'file', authority: '', path: `${root}/${id}/mcp.json` },
    cacheHome: { scheme: 'file', authority: '', path: `${root}/${id}/cache` }
  };
}

function workspaceIdentifier(seed = 'tauri-workspace') {
  return {
    id: `${seed}-id`,
    configPath: `${seed}.code-workspace`
  };
}

function parseUrl(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object' && typeof value.scheme === 'string') {
    const authority = typeof value.authority === 'string' ? value.authority : '';
    const path = typeof value.path === 'string' ? value.path : '/';
    const query = typeof value.query === 'string' && value.query.length > 0 ? `?${value.query}` : '';
    const fragment = typeof value.fragment === 'string' && value.fragment.length > 0 ? `#${value.fragment}` : '';
    return `${value.scheme}://${authority}${path}${query}${fragment}`;
  }

  return undefined;
}

function defaultByMethodName(method) {
  if (method.startsWith('is') || method.startsWith('has')) {
    return false;
  }
  if (method.startsWith('get')) {
    return null;
  }

  return null;
}

function capabilityFallback(domain, method, params) {
  return {
    fallback: true,
    kind: 'capability',
    domain,
    method,
    params,
    note: 'Node fallback placeholder for capability method.'
  };
}

function channelFallback(channel, method, args) {
  switch (channel) {
    case 'logger':
      if (method === 'getRegisteredLoggers') {
        return [];
      }
      return null;

    case 'storage':
      if (method === 'getItems') {
        return [];
      }
      if (method === 'isUsed') {
        return false;
      }
      return null;

    case 'policy':
      if (method === 'updatePolicyDefinitions') {
        return {};
      }
      return null;

    case 'sign':
      if (method === 'sign') {
        return typeof args[0] === 'string' ? args[0] : '';
      }
      if (method === 'createNewMessage') {
        const value = typeof args[0] === 'string' ? args[0] : '';
        return {
          id: crypto.createHash('sha1').update(value).digest('hex').slice(0, 8),
          data: value
        };
      }
      if (method === 'validate') {
        return true;
      }
      return null;

    case 'userDataProfiles': {
      if (method === 'createNamedProfile') {
        return fallbackProfile('named', typeof args[0] === 'string' ? args[0] : 'Named');
      }
      if (method === 'createProfile') {
        return fallbackProfile(
          typeof args[0] === 'string' ? args[0] : 'profile',
          typeof args[1] === 'string' ? args[1] : 'Profile'
        );
      }
      if (method === 'createTransientProfile') {
        return fallbackProfile('transient', 'Transient');
      }
      if (method === 'updateProfile') {
        return args[0] ?? fallbackProfile('updated', 'Updated');
      }
      return null;
    }

    case 'url': {
      if (method === 'open' || method === 'handleURL') {
        return Boolean(parseUrl(args[0]));
      }
      return null;
    }

    case 'workspaces':
      if (method === 'getRecentlyOpened') {
        return { workspaces: [], files: [] };
      }
      if (method === 'getDirtyWorkspaces') {
        return [];
      }
      if (method === 'createUntitledWorkspace') {
        return workspaceIdentifier('tauri-untitled');
      }
      if (method === 'getWorkspaceIdentifier') {
        return workspaceIdentifier('tauri-existing');
      }
      if (method === 'enterWorkspace') {
        return { workspace: workspaceIdentifier('tauri-entered') };
      }
      return null;

    case 'keyboardLayout':
      if (method === 'getKeyboardLayoutData') {
        return {
          keyboardLayoutInfo: {
            id: 'tauri-us',
            lang: 'en',
            layout: 'US'
          },
          keyboardMapping: {}
        };
      }
      return null;

    case 'nativeHost': {
      switch (method) {
        case 'isFullScreen':
        case 'isMaximized':
        case 'isWindowAlwaysOnTop':
        case 'isOnBatteryPower':
        case 'hasWSLFeatureInstalled':
        case 'isAdmin':
        case 'isRunningUnderARM64Translation':
          return false;
        case 'getWindowCount':
        case 'getActiveWindowId':
          return 1;
        case 'getProcessId':
          return pid;
        case 'getWindows':
          return [];
        case 'getCursorScreenPoint':
          return {
            point: { x: 0, y: 0 },
            display: { x: 0, y: 0, width: 0, height: 0 }
          };
        case 'getOSColorScheme':
          return { dark: false, highContrast: false };
        case 'getOSProperties':
          return {
            type: platform,
            release: '0.0.0',
            arch,
            platform,
            cpus: []
          };
        case 'getOSStatistics':
          return { totalmem: 0, freemem: 0, loadavg: [0, 0, 0] };
        case 'getSystemIdleState':
          return 'active';
        case 'getSystemIdleTime':
          return 0;
        case 'getCurrentThermalState':
          return 'nominal';
        case 'startPowerSaveBlocker':
          return 1;
        case 'stopPowerSaveBlocker':
          return true;
        case 'isPowerSaveBlockerStarted':
          return false;
        case 'showMessageBox':
          return { response: 0, checkboxChecked: false };
        case 'showOpenDialog':
          return { canceled: true, filePaths: [] };
        case 'showSaveDialog':
          return { canceled: true };
        case 'openExternal':
          return true;
        case 'readClipboardText':
        case 'readClipboardFindText':
          return '';
        case 'readImage':
          return [];
        case 'resolveProxy':
          return undefined;
        default:
          return null;
      }
    }

    default:
      return defaultByMethodName(method);
  }
}

async function main() {
  try {
    const raw = await readStdin();
    const parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
    const request = normalizeRequest(parsed);

    const result =
      request.kind === 'channel'
        ? channelFallback(request.channel, request.method, request.args)
        : capabilityFallback(request.domain, request.method, request.params);

    writeJson({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    writeJson({ ok: false, error: message });
    process.exitCode = 1;
  }
}

main();
