import { HostClient } from './hostClient';

interface WorkbenchWebApi {
  create(domElement: HTMLElement, options: Record<string, unknown>): { dispose(): void };
}

interface WorkbenchWindow extends Window {
  __VSCODE_WORKBENCH_MODULE__?: string;
}

export async function bootWorkbench(container: HTMLElement, host: HostClient): Promise<void> {
  const workbenchModulePath = (window as WorkbenchWindow).__VSCODE_WORKBENCH_MODULE__
    ?? '/out/vs/workbench/workbench.web.main.internal.js';

  const webApi = await import(/* @vite-ignore */ workbenchModulePath) as WorkbenchWebApi;

  webApi.create(container, {
    remoteAuthority: undefined,
    serverBasePath: '/',
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
