import { HostClient } from './hostClient';

interface WorkbenchWebApi {
  create(domElement: HTMLElement, options: Record<string, unknown>): { dispose(): void };
  commands?: {
    executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  };
}

interface WorkbenchWindow extends Window {
  __VSCODE_WORKBENCH_MODULE__?: string;
  _VSCODE_FILE_ROOT?: string;
  _VSCODE_CSS_LOAD?: (moduleUrl: string) => void;
}

interface PickFolderAndOpenOptions {
  forceNewWindow?: boolean;
  forceReuseWindow?: boolean;
}

interface UriComponents {
  scheme: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

interface FolderWorkspaceToOpen {
  folderUri: UriComponents;
}

interface FileWorkspaceToOpen {
  workspaceUri: UriComponents;
}

type WorkspaceToOpen = FolderWorkspaceToOpen | FileWorkspaceToOpen | undefined;

interface WorkspaceOpenOptions {
  reuse?: boolean;
  payload?: object;
}

interface WorkspaceProvider {
  workspace: WorkspaceToOpen;
  payload?: object;
  trusted: boolean | undefined;
  open(workspace: WorkspaceToOpen, options?: WorkspaceOpenOptions): Promise<boolean>;
}

const QUERY_PARAM_EMPTY_WINDOW = 'ew';
const QUERY_PARAM_FOLDER = 'folder';
const QUERY_PARAM_WORKSPACE = 'workspace';
const QUERY_PARAM_PAYLOAD = 'payload';

export async function bootWorkbench(container: HTMLElement, host: HostClient): Promise<void> {
  const workbenchWindow = window as WorkbenchWindow;
  const workbenchModulePath = workbenchWindow.__VSCODE_WORKBENCH_MODULE__;
  const resolvedWorkbenchModulePath = workbenchModulePath ?? '/out/vs/workbench/workbench.web.main.internal.js';
  const fileRoot = new URL('/out/', window.location.origin).toString();
  const workspaceProvider = createWorkspaceProvider();
  workbenchWindow._VSCODE_FILE_ROOT = fileRoot;

  const cssModules = await host.getWorkbenchCssModules();
  installCssModuleImportMap(cssModules, fileRoot);

  const webApi = await import(/* @vite-ignore */ resolvedWorkbenchModulePath) as WorkbenchWebApi;

  webApi.create(container, {
    remoteAuthority: undefined,
    serverBasePath: '/',
    workspaceProvider,
    enableWorkspaceTrust: true,
    additionalTrustedDomains: [],
    secretStorageProvider: {
      type: 'in-memory',
      async get() {
        return undefined;
      },
      async set() {
      },
      async delete() {
      },
      async keys() {
        return [];
      }
    },
    commands: [
      {
        id: 'workbench.action.files.openFolder',
        handler: async (options?: PickFolderAndOpenOptions) => {
          await openFolderViaWorkbenchPicker(webApi, options);
        }
      },
      {
        id: 'workbench.action.files.openFolderInNewWindow',
        handler: async (options?: PickFolderAndOpenOptions) => {
          await openFolderViaWorkbenchPicker(webApi, { forceNewWindow: true, ...options });
        }
      },
      {
        id: 'workbench.action.files.openFolderViaWorkspace',
        handler: async (options?: PickFolderAndOpenOptions) => {
          await openFolderViaWorkbenchPicker(webApi, { forceReuseWindow: true, ...options });
        }
      },
      {
        id: 'workbench.action.files.openFileFolder',
        handler: async (options?: PickFolderAndOpenOptions) => {
          await openFolderViaWorkbenchPicker(webApi, { forceReuseWindow: true, ...options });
        }
      },
      {
        id: '_files.pickFolderAndOpen',
        handler: async (options?: PickFolderAndOpenOptions) => {
          await openFolderViaWorkbenchPicker(webApi, options);
        }
      },
      {
        id: 'tauri.host.showFallbackCounts',
        label: 'Tauri: Show Fallback Counts',
        handler: async () => {
          const counts = await host.getFallbackCounts();
          // Keep this simple and non-blocking while parity work continues.
          console.log('Tauri fallback counts', counts);
          return counts;
        }
      }
    ]
  });
}

async function openFolderViaWorkbenchPicker(
  webApi: WorkbenchWebApi,
  options?: PickFolderAndOpenOptions
): Promise<boolean> {
  const executeCommand = webApi.commands?.executeCommand;
  if (!executeCommand) {
    return false;
  }

  const commandOptions = {
    forceNewWindow: options?.forceNewWindow,
    forceReuseWindow: options?.forceReuseWindow
  };
  await executeCommand('setRootFolder', commandOptions);
  return true;
}

function createWorkspaceProvider(): WorkspaceProvider {
  let workspace: WorkspaceToOpen = undefined;
  let payload: object = {};
  let foundWorkspace = false;

  const query = new URL(window.location.href).searchParams;
  query.forEach((value, key) => {
    switch (key) {
      case QUERY_PARAM_FOLDER:
        workspace = { folderUri: parseWorkspaceUri(value) };
        foundWorkspace = true;
        break;
      case QUERY_PARAM_WORKSPACE:
        workspace = { workspaceUri: parseWorkspaceUri(value) };
        foundWorkspace = true;
        break;
      case QUERY_PARAM_EMPTY_WINDOW:
        workspace = undefined;
        foundWorkspace = true;
        break;
      case QUERY_PARAM_PAYLOAD:
        try {
          const parsed = JSON.parse(value) as unknown;
          payload = parsed && typeof parsed === 'object' ? parsed as object : {};
        } catch {
          payload = {};
        }
        break;
      default:
        break;
    }
  });

  if (!foundWorkspace) {
    workspace = undefined;
  }

  return {
    workspace,
    payload,
    trusted: true,
    open: async (nextWorkspace: WorkspaceToOpen, options?: WorkspaceOpenOptions): Promise<boolean> => {
      if (options?.reuse && !options.payload && areSameWorkspace(workspace, nextWorkspace)) {
        return true;
      }

      const targetHref = createTargetUrl(nextWorkspace, options?.payload);
      if (!targetHref) {
        return false;
      }

      if (options?.reuse) {
        window.location.href = targetHref;
        return true;
      }

      const opened = window.open(targetHref, '_blank', 'toolbar=no');
      return opened !== null;
    }
  };
}

function parseWorkspaceUri(value: string): UriComponents {
  if (value.startsWith('/')) {
    return {
      scheme: 'file',
      authority: '',
      path: value
    };
  }

  try {
    const parsed = new URL(value);
    return {
      scheme: parsed.protocol.replace(/:$/, ''),
      authority: parsed.host,
      path: decodeURIComponent(parsed.pathname),
      query: parsed.search ? parsed.search.slice(1) : undefined,
      fragment: parsed.hash ? parsed.hash.slice(1) : undefined
    };
  } catch {
    const absolute = value.startsWith('/') ? value : `/${value}`;
    return {
      scheme: 'file',
      authority: '',
      path: absolute
    };
  }
}

function createTargetUrl(workspace: WorkspaceToOpen, payload?: object): string | undefined {
  let targetHref: string | undefined;
  if (!workspace) {
    targetHref = `${window.location.origin}${window.location.pathname}?${QUERY_PARAM_EMPTY_WINDOW}=true`;
  } else if ('folderUri' in workspace) {
    targetHref = `${window.location.origin}${window.location.pathname}?${QUERY_PARAM_FOLDER}=${encodeURIComponent(uriComponentsToString(workspace.folderUri))}`;
  } else if ('workspaceUri' in workspace) {
    targetHref = `${window.location.origin}${window.location.pathname}?${QUERY_PARAM_WORKSPACE}=${encodeURIComponent(uriComponentsToString(workspace.workspaceUri))}`;
  }

  if (!targetHref) {
    return undefined;
  }

  if (payload && Object.keys(payload).length > 0) {
    targetHref += `&${QUERY_PARAM_PAYLOAD}=${encodeURIComponent(JSON.stringify(payload))}`;
  }

  return targetHref;
}

function uriComponentsToString(uri: UriComponents): string {
  const scheme = uri.scheme || 'file';
  const authority = uri.authority ?? '';
  const rawPath = uri.path && uri.path.length > 0 ? uri.path : '/';
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const query = uri.query ? `?${uri.query}` : '';
  const fragment = uri.fragment ? `#${uri.fragment}` : '';

  if (authority.length > 0) {
    return `${scheme}://${authority}${path}${query}${fragment}`;
  }

  if (scheme === 'file') {
    return `file://${path}${query}${fragment}`;
  }

  return `${scheme}:${path}${query}${fragment}`;
}

function areSameWorkspace(current: WorkspaceToOpen, next: WorkspaceToOpen): boolean {
  if (!current || !next) {
    return current === next;
  }

  if ('folderUri' in current && 'folderUri' in next) {
    return uriComponentsToString(current.folderUri) === uriComponentsToString(next.folderUri);
  }

  if ('workspaceUri' in current && 'workspaceUri' in next) {
    return uriComponentsToString(current.workspaceUri) === uriComponentsToString(next.workspaceUri);
  }

  return false;
}

let previousCssImportBlobs: string[] = [];

function installCssModuleImportMap(cssModules: readonly string[], fileRoot: string): void {
  const styleElementId = 'vscode-css-modules';
  let styleElement = document.getElementById(styleElementId) as HTMLStyleElement | null;
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = styleElementId;
    styleElement.type = 'text/css';
    styleElement.media = 'screen';
    document.head.appendChild(styleElement);
  }

  const sheet = styleElement.sheet;
  if (!sheet) {
    throw new Error('Unable to initialize CSS module stylesheet for VS Code workbench.');
  }

  const currentWindow = window as WorkbenchWindow;
  currentWindow._VSCODE_CSS_LOAD = (url: string) => {
    sheet.insertRule(`@import url(${JSON.stringify(url)});`);
  };

  for (const blobUrl of previousCssImportBlobs) {
    URL.revokeObjectURL(blobUrl);
  }
  previousCssImportBlobs = [];

  const imports: Record<string, string> = {};
  for (const cssModule of cssModules) {
    const cssUrl = new URL(cssModule, fileRoot).href;
    const jsSource = `globalThis._VSCODE_CSS_LOAD(${JSON.stringify(cssUrl)});\nexport {};`;
    const blob = new Blob([jsSource], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    imports[cssUrl] = blobUrl;
    previousCssImportBlobs.push(blobUrl);
  }

  const previousImportMap = document.querySelector('script[data-vscode-css-import-map="1"]');
  if (previousImportMap?.parentNode) {
    previousImportMap.parentNode.removeChild(previousImportMap);
  }

  const importMapScript = document.createElement('script');
  importMapScript.type = 'importmap';
  importMapScript.dataset.vscodeCssImportMap = '1';
  importMapScript.textContent = JSON.stringify({ imports });
  document.head.appendChild(importMapScript);
}
