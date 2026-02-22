import { HostClient } from './hostClient';
import { bootWorkbench } from './workbenchBoot';

function setStatus(message: string): void {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = message;
  }
}

async function main(): Promise<void> {
  const workbench = document.getElementById('workbench');
  if (!workbench) {
    throw new Error('Missing #workbench container');
  }

  setStatus('Connecting to Tauri host...');
  const host = new HostClient();
  const handshake = await host.handshake();

  setStatus(`Host: ${handshake.serverName} ${handshake.serverVersion} | Protocol ${handshake.protocolVersion}`);

  await bootWorkbench(workbench, host);
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  setStatus(`Startup failed:\n${message}`);
  console.error(error);
});
