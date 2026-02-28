import { EventEmitter } from 'node:events';
import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('extension-host-worker requires parentPort');
}

if (process.env.VSCODE_TAURI_INTEGRATION === '1') {
  console.error(`[worker] process.arch=${process.arch} process.execPath=${process.execPath}`);
}

function wrapTransferredPort(port) {
  return {
    on(event, listener) {
      if (event === 'message') {
        port.on('message', (value) => listener({ data: value }));
        return this;
      }

      if (event === 'close') {
        port.on('close', listener);
        return this;
      }

      port.on(event, listener);
      return this;
    },
    start() {
      port.start();
    },
    postMessage(value, transferList) {
      port.postMessage(value, transferList);
    },
    close() {
      port.close();
    }
  };
}

const parentPortBridge = new EventEmitter();
parentPort.on('message', (message) => {
  if (message && typeof message === 'object' && Array.isArray(message.ports)) {
    parentPortBridge.emit('message', {
      ...message,
      ports: message.ports.map(port => wrapTransferredPort(port))
    });
    return;
  }

  parentPortBridge.emit('message', message);
});

Object.defineProperty(process, 'parentPort', {
  configurable: true,
  enumerable: false,
  writable: true,
  value: parentPortBridge,
});

if (Array.isArray(workerData?.env)) {
  for (const entry of workerData.env) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const key = typeof entry.key === 'string' ? entry.key : undefined;
    if (!key) {
      continue;
    }

    const value = entry.value;
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

if (Array.isArray(workerData?.execArgv)) {
  Object.defineProperty(process, 'execArgv', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: [...workerData.execArgv],
  });
}

if (typeof workerData?.vscodeVersion === 'string' && workerData.vscodeVersion.length > 0) {
  Object.defineProperty(process.versions, 'vscode', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: workerData.vscodeVersion,
  });
}

if (Array.isArray(workerData?.args)) {
  const entry = typeof workerData.entryPoint === 'string' ? workerData.entryPoint : 'extensionHostProcess.js';
  Object.defineProperty(process, 'argv', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: [process.argv[0] ?? 'node', entry, ...workerData.args],
  });
}

const entryPoint = typeof workerData?.entryPoint === 'string' ? workerData.entryPoint : undefined;
if (!entryPoint) {
  throw new Error('extension-host-worker missing entryPoint');
}

await import(entryPoint);
