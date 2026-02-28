import { Worker, MessageChannel } from 'node:worker_threads';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseConfig() {
  const flagIndex = process.argv.indexOf('--config-base64');
  if (flagIndex === -1 || flagIndex + 1 >= process.argv.length) {
    throw new Error('missing --config-base64 argument');
  }

  const encoded = process.argv[flagIndex + 1];
  const json = Buffer.from(encoded, 'base64').toString('utf8');
  const parsed = JSON.parse(json);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid bridge config payload');
  }

  const entryPoint = typeof parsed.entryPoint === 'string' ? parsed.entryPoint : '';
  if (!entryPoint) {
    throw new Error('bridge config is missing entryPoint');
  }

  return {
    entryPoint,
    args: Array.isArray(parsed.args) ? parsed.args.filter(value => typeof value === 'string') : [],
    execArgv: Array.isArray(parsed.execArgv)
      ? parsed.execArgv.filter(value => typeof value === 'string')
      : [],
    env: Array.isArray(parsed.env)
      ? parsed.env.filter(value => value && typeof value === 'object')
      : [],
    vscodeVersion: typeof parsed.vscodeVersion === 'string' ? parsed.vscodeVersion : '',
  };
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value.map(item => Number(item) & 0xff));
  }

  if (value && typeof value === 'object') {
    if (Array.isArray(value.data)) {
      return Uint8Array.from(value.data.map(item => Number(item) & 0xff));
    }
    if (Array.isArray(value.buffer)) {
      return Uint8Array.from(value.buffer.map(item => Number(item) & 0xff));
    }
  }

  return new Uint8Array(0);
}

function writeFrame(payload) {
  const bytes = toUint8Array(payload);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(bytes.byteLength, 0);
  process.stdout.write(header);
  if (bytes.byteLength > 0) {
    process.stdout.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
}

function createFrameReader(onFrame) {
  let buffered = Buffer.alloc(0);

  return (chunk) => {
    if (!Buffer.isBuffer(chunk)) {
      chunk = Buffer.from(chunk);
    }

    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

    while (buffered.length >= 4) {
      const payloadLength = buffered.readUInt32LE(0);
      if (buffered.length < 4 + payloadLength) {
        return;
      }

      const payload = buffered.subarray(4, 4 + payloadLength);
      buffered = buffered.subarray(4 + payloadLength);
      onFrame(payload);
    }
  };
}

function forwardStream(stream, prefix) {
  if (!stream) {
    return;
  }

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    if (typeof chunk !== 'string' || chunk.length === 0) {
      return;
    }

    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) {
        continue;
      }
      process.stderr.write(`${prefix}${line}\n`);
    }
  });
}

function sanitizeWorkerExecArgv(execArgv) {
  const sanitized = execArgv.filter(value => value !== '--expose-gc');
  if (sanitized.length !== execArgv.length) {
    process.stderr.write('[bridge] dropping unsupported Worker execArgv: --expose-gc\n');
  }

  return sanitized;
}

const config = parseConfig();
const workerScript = new URL('./extension-host-worker.mjs', import.meta.url);
const workerExecArgv = sanitizeWorkerExecArgv(config.execArgv);

const worker = new Worker(workerScript, {
  type: 'module',
  workerData: {
    entryPoint: pathToFileURL(config.entryPoint).href,
    args: config.args,
    execArgv: config.execArgv,
    env: config.env,
    vscodeVersion: config.vscodeVersion,
  },
  stdout: true,
  stderr: true,
  execArgv: workerExecArgv,
});

forwardStream(worker.stdout, '[ext-host:stdout] ');
forwardStream(worker.stderr, '[ext-host:stderr] ');

const { port1, port2 } = new MessageChannel();
let closed = false;

port2.on('message', (value) => {
  if (closed) {
    return;
  }
  writeFrame(value);
});
port2.start();

worker.postMessage({ ports: [port1] }, [port1]);

const onFrame = createFrameReader((payload) => {
  if (closed) {
    return;
  }

  const cloned = Buffer.from(payload);
  port2.postMessage(cloned);
});

process.stdin.on('data', onFrame);
process.stdin.on('end', () => {
  closed = true;
  try {
    port2.close();
  } catch {
    // ignore
  }
});

worker.on('error', (error) => {
  process.stderr.write(`[ext-host:error] ${error?.stack || String(error)}\n`);
  process.exitCode = 1;
  closed = true;
  try {
    port2.close();
  } catch {
    // ignore
  }
});

worker.on('exit', (code) => {
  closed = true;
  try {
    port2.close();
  } catch {
    // ignore
  }

  if (typeof code === 'number') {
    process.exitCode = code;
  }
});
