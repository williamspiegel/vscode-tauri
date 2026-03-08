import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, defineConfig } from 'vite';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(uiRoot, '../../..');
const uiNodeModulesRoot = path.join(uiRoot, 'node_modules');
const repoNodeModulesRoot = path.join(repoRoot, 'node_modules');
const fallbackNodeModulePackages = new Set([
  'vscode-textmate',
  'vscode-oniguruma',
  '@vscode/tree-sitter-wasm'
]);

const logger = createLogger();
const loggerWarn = logger.warn;
const loggerWarnOnce = logger.warnOnce?.bind(logger);

function shouldSuppressWarning(message: string): boolean {
  return (
    (message.includes('Sourcemap for "') && message.includes('points to missing source files')) ||
    message.includes('The above dynamic import cannot be analyzed by Vite.') ||
    message.includes('Plugin: vite:import-analysis') ||
    message.includes('packages/dynamic-import-vars#limitations')
  );
}

logger.warn = (message, options) => {
  if (typeof message === 'string' && shouldSuppressWarning(message)) {
    return;
  }

  loggerWarn(message, options);
};

if (loggerWarnOnce) {
  logger.warnOnce = (message, options) => {
    if (typeof message === 'string' && shouldSuppressWarning(message)) {
      return;
    }

    loggerWarnOnce(message, options);
  };
}

function getPackageName(relativePath: string): string | undefined {
  const sanitized = relativePath.replace(/^\/+/, '');
  if (!sanitized) {
    return undefined;
  }

  const parts = sanitized.split('/');
  if (parts[0].startsWith('@') && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0];
}

function resolveFallbackNodeModulePath(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  const pathname = url.split('?', 1)[0].split('#', 1)[0];
  if (!pathname.startsWith('/node_modules/')) {
    return undefined;
  }

  const relativePath = pathname.slice('/node_modules/'.length);
  if (!relativePath || relativePath.includes('\0')) {
    return undefined;
  }

  const packageName = getPackageName(relativePath);
  if (!packageName || !fallbackNodeModulePackages.has(packageName)) {
    return undefined;
  }

  const uiCandidate = path.join(uiNodeModulesRoot, relativePath);
  if (fs.existsSync(uiCandidate)) {
    return undefined;
  }

  const fallbackPath = path.resolve(repoNodeModulesRoot, relativePath);
  if (!fallbackPath.startsWith(`${repoNodeModulesRoot}${path.sep}`)) {
    return undefined;
  }

  try {
    if (fs.statSync(fallbackPath).isFile()) {
      return fallbackPath;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isFallbackNodeModuleRequest(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  const pathname = url.split('?', 1)[0].split('#', 1)[0];
  if (!pathname.startsWith('/node_modules/')) {
    return false;
  }

  const relativePath = pathname.slice('/node_modules/'.length);
  if (!relativePath || relativePath.includes('\0')) {
    return false;
  }

  const packageName = getPackageName(relativePath);
  return !!packageName && fallbackNodeModulePackages.has(packageName);
}

function contentTypeForPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    case '.wasm':
      return 'application/wasm';
    case '.map':
      return 'application/json';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return undefined;
  }
}

function serveStaticFile(
  req: { method?: string },
  res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(chunk?: string): void;
  },
  filePath: string
): boolean {
  const contentType = contentTypeForPath(filePath);
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.end();
    return true;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (res.statusCode < 400) {
      res.statusCode = 500;
    }
    res.end();
  });
  stream.pipe(res as unknown as NodeJS.WritableStream);
  return true;
}

function resolveOutAssetPath(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  const pathname = url.split('?', 1)[0].split('#', 1)[0];
  if (!pathname.startsWith('/out/') && !pathname.startsWith('/out-vscode-min/')) {
    return undefined;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relativePath = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(repoRoot, relativePath);
  if (!candidate.startsWith(`${repoRoot}${path.sep}`)) {
    return undefined;
  }

  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return candidate;
}

function installOutAssetRawMiddleware(req: { url?: string; method?: string }, res: {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}, next: () => void): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }

  const outPath = resolveOutAssetPath(req.url);
  if (!outPath) {
    next();
    return;
  }

  if (!serveStaticFile(req, res, outPath)) {
    next();
  }
}

function installNodeModulesFallbackMiddleware(req: { url?: string; method?: string }, res: {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}, next: () => void): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }

  const fallbackPath = resolveFallbackNodeModulePath(req.url);
  if (!fallbackPath) {
    if (isFallbackNodeModuleRequest(req.url)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    next();
    return;
  }

  serveStaticFile(req, res, fallbackPath);
}

export default defineConfig({
  customLogger: logger,
  plugins: [
    {
      name: 'tauri-node-modules-fallback',
      configureServer(server) {
        server.middlewares.use(installOutAssetRawMiddleware);
        server.middlewares.use(installNodeModulesFallbackMiddleware);
      },
      configurePreviewServer(server) {
        server.middlewares.use(installOutAssetRawMiddleware);
        server.middlewares.use(installNodeModulesFallbackMiddleware);
      }
    }
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    warmup: {
      clientFiles: [
        '../../../out/vs/code/electron-browser/workbench/workbench.js',
        '../../../out/vs/workbench/workbench.desktop.main.js',
        '../../../out/vs/base/common/errors.js'
      ]
    },
    fs: {
      allow: ['..', '../../..', '../../../..']
    }
  }
});
