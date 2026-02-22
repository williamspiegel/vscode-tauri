import { HostClient } from './hostClient';
import { bootWorkbench } from './workbenchBoot';

type StatusLevel = 'info' | 'error';

function setStatus(message: string, level: StatusLevel = 'info', visible = true): void {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = message;
    status.dataset.level = level;
    status.dataset.visible = visible ? '1' : '0';
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
}

async function main(): Promise<void> {
  const workbench = document.getElementById('workbench');
  if (!workbench) {
    throw new Error('Missing #workbench container');
  }

  setStatus('Launching Tauri host...');
  const host = new HostClient();
  const handshake = await host.handshake();
  await attachDebugHostListeners(host);
  setStatus(
    `Host: ${handshake.serverName} ${handshake.serverVersion} | Protocol ${handshake.protocolVersion}`
  );

  await bootWorkbench(workbench, host);
  setStatus('', 'info', false);
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  setStatus(`Startup failed:\n${message}`, 'error', true);
  console.error(error);
});
