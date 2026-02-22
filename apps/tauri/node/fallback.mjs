#!/usr/bin/env node

import { stdin, stdout, stderr } from 'node:process';

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

async function main() {
  try {
    const raw = await readStdin();
    const request = raw.trim().length > 0 ? JSON.parse(raw) : {};
    const { method = 'unknown', domain = 'unknown', params = {} } = request;

    writeJson({
      ok: true,
      result: {
        fallback: true,
        method,
        domain,
        params,
        note: 'Node fallback placeholder. Replace with upstream-compatible adapter implementation.'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    writeJson({ ok: false, error: message });
    process.exitCode = 1;
  }
}

main();
