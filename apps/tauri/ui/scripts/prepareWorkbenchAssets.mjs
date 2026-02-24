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

try {
  await assertDir(sourceMinRoot, 'VS Code out-vscode-min/vs directory');
  await fs.rm(path.join(distRoot, 'out-vscode-min'), { recursive: true, force: true });
  await fs.mkdir(targetMinRoot, { recursive: true });
  for (const relativePath of minWorkbenchFiles) {
    const sourceFile = path.join(sourceMinRoot, relativePath);
    const targetFile = path.join(targetMinRoot, relativePath);
    await assertFile(sourceFile, `Min workbench asset (${relativePath})`);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.copyFile(sourceFile, targetFile);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[tauri.ui] skipping out-vscode-min assets: ${detail}`);
}

console.log(
  `[tauri.ui] prepared desktop runtime assets at ${path.relative(uiRoot, targetOutRoot)}`
);
