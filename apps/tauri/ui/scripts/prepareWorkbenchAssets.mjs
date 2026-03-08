import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(uiRoot, '../../..');

const sourceOutRoot = path.join(repoRoot, 'out');
const sourceVsRoot = path.join(sourceOutRoot, 'vs');
const requiredWorkbenchBootstrap = path.join(
  sourceVsRoot,
  'code/electron-browser/workbench/workbench.js'
);
const sourceMinRoot = path.join(repoRoot, 'out-vscode-min', 'vs');
const fallbackNodeModulePackages = [
  '@xterm/xterm',
  '@xterm/addon-clipboard',
  '@xterm/addon-image',
  '@xterm/addon-ligatures',
  '@xterm/addon-progress',
  '@xterm/addon-search',
  '@xterm/addon-serialize',
  '@xterm/addon-unicode11',
  '@xterm/addon-webgl',
  'vscode-textmate',
  'vscode-oniguruma',
  '@vscode/tree-sitter-wasm'
];
const minWorkbenchFiles = [
  'code/electron-browser/workbench/workbench.js',
  'code/electron-browser/workbench/workbench.html',
  'workbench/workbench.desktop.main.js',
  'workbench/workbench.desktop.main.css'
];

const distRoot = path.join(uiRoot, 'dist');
const targetOutRoot = path.join(distRoot, 'out');
const targetVsRoot = path.join(targetOutRoot, 'vs');
const targetMinRoot = path.join(distRoot, 'out-vscode-min', 'vs');
const targetDevMinRoot = path.join(uiRoot, 'out-vscode-min', 'vs');
const targetNodeModulesRoot = path.join(distRoot, 'node_modules');

function stripSourceMappingUrlDirectives(contents) {
  return contents
    .replace(/\/\/[@#]\s*sourceMappingURL=.*$/gm, '')
    .replace(/\/\*[@#]\s*sourceMappingURL=.*?\*\//g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}

function rewriteCssImportsInJavaScript(contents) {
  return contents.replace(
    /(^|\n)([ \t]*)import\s*(["'])([^"']+\.css)\3;[ \t]*/g,
    (_match, prefix, indent, quote, specifier) =>
      `${prefix}${indent}globalThis._VSCODE_CSS_LOAD?.(new URL(${quote}${specifier}${quote}, import.meta.url).href);\n`
  );
}

function sanitizeJavaScriptAsset(contents) {
  return rewriteCssImportsInJavaScript(stripSourceMappingUrlDirectives(contents));
}

async function copyMinAsset(sourceFile, targetFile) {
  const extension = path.extname(sourceFile).toLowerCase();
  if (extension !== '.js' && extension !== '.css') {
    await fs.copyFile(sourceFile, targetFile);
    return;
  }

  const raw = await fs.readFile(sourceFile, 'utf8');
  const sanitized =
    extension === '.js'
      ? sanitizeJavaScriptAsset(raw)
      : stripSourceMappingUrlDirectives(raw);
  await fs.writeFile(targetFile, sanitized, 'utf8');
}

async function copyMinAssetsTo(targetMinVsRoot) {
  await fs.rm(path.dirname(targetMinVsRoot), { recursive: true, force: true });
  await fs.mkdir(targetMinVsRoot, { recursive: true });
  for (const relativePath of minWorkbenchFiles) {
    const sourceFile = path.join(sourceMinRoot, relativePath);
    const targetFile = path.join(targetMinVsRoot, relativePath);
    await assertFile(sourceFile, `Min workbench asset (${relativePath})`);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await copyMinAsset(sourceFile, targetFile);
  }
}

async function copyFallbackNodeModules() {
  await fs.rm(targetNodeModulesRoot, { recursive: true, force: true });
  await fs.mkdir(targetNodeModulesRoot, { recursive: true });
  for (const packageName of fallbackNodeModulePackages) {
    const sourcePackageRoot = path.join(repoRoot, 'node_modules', packageName);
    const targetPackageRoot = path.join(targetNodeModulesRoot, packageName);
    await assertDir(sourcePackageRoot, `Fallback node module (${packageName})`);
    await fs.cp(sourcePackageRoot, targetPackageRoot, {
      recursive: true,
      dereference: true,
      filter: source => !source.endsWith('.map')
    });
  }
}

async function assertFile(filePath, label) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is missing (${filePath}): ${detail}`);
  }
}

async function assertDir(dirPath, label) {
  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${dirPath}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is missing (${dirPath}): ${detail}`);
  }
}

async function rewriteCopiedJavaScriptAssets(currentDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await rewriteCopiedJavaScriptAssets(entryPath);
      continue;
    }

    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.js') {
      continue;
    }

    const raw = await fs.readFile(entryPath, 'utf8');
    const rewritten = rewriteCssImportsInJavaScript(raw);
    if (rewritten !== raw) {
      await fs.writeFile(entryPath, rewritten, 'utf8');
    }
  }
}

await assertDir(distRoot, 'UI dist directory');
await assertDir(sourceVsRoot, 'VS Code out/vs directory');
await assertFile(requiredWorkbenchBootstrap, 'Workbench bootstrap module');

await fs.rm(targetOutRoot, { recursive: true, force: true });
await fs.mkdir(targetOutRoot, { recursive: true });
await fs.cp(sourceVsRoot, targetVsRoot, {
  recursive: true,
  dereference: true,
  filter: source => !source.endsWith('.map')
});
await rewriteCopiedJavaScriptAssets(targetVsRoot);
await copyFallbackNodeModules();

try {
  await assertDir(sourceMinRoot, 'VS Code out-vscode-min/vs directory');
  await copyMinAssetsTo(targetMinRoot);
  await copyMinAssetsTo(targetDevMinRoot);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[tauri.ui] skipping out-vscode-min assets: ${detail}`);
}

console.log(
  `[tauri.ui] prepared desktop runtime assets at ${path.relative(uiRoot, targetOutRoot)}`
);
