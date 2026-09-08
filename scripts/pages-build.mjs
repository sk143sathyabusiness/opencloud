import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 1. Build frontend
const env = { ...process.env, VITE_API_BASE_URL: '/api', VITE_WS_BASE_URL: '/ws/uploads' };
const run = spawnSync('npm', ['--prefix', 'frontend', 'run', 'build'], { stdio: 'inherit', env, shell: true });
if (run.status !== 0) process.exit(run.status ?? 1);

// 2. Copy source files into frontend/dist at correct relative paths
//    Then patch imports so Cloudflare's server-side bundler can resolve them.
//    Original paths assume cloudflare/ is one level below root, with ../backend/ reaching root/backend/.
//    In dist/, we flatten cloudflare/ to root, so ../backend/ must become ./backend/.
const distDir = path.join(root, 'frontend', 'dist');

function copyDir(src, dest) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.cjs')) {
      copyFileSync(srcPath, destPath);
    }
  }
}

// Copy cloudflare/_worker.js → dist/_worker.js
copyFileSync(path.join(root, 'cloudflare', '_worker.js'), path.join(distDir, '_worker.js'));

// Copy cloudflare/*.js → dist/*.js (same directory as _worker.js)
for (const entry of readdirSync(path.join(root, 'cloudflare'))) {
  if (entry === '_worker.js' || entry === 'tests' || entry === 'require-shim.mjs') continue;
  const srcPath = path.join(root, 'cloudflare', entry);
  if (statSync(srcPath).isFile() && (entry.endsWith('.js') || entry.endsWith('.mjs'))) {
    copyFileSync(srcPath, path.join(distDir, entry));
  }
}

// Copy cloudflare/routes/, adapters/, services/, utils/ → dist/routes/, adapters/, services/, utils/
for (const subdir of ['routes', 'adapters', 'services', 'utils']) {
  const srcDir = path.join(root, 'cloudflare', subdir);
  if (existsSync(srcDir)) copyDir(srcDir, path.join(distDir, subdir));
}

// Copy backend/src/config/ → dist/backend/src/config/
// Copy backend/src/utils/ → dist/backend/src/utils/
for (const subdir of ['config', 'utils']) {
  const srcDir = path.join(root, 'backend', 'src', subdir);
  if (existsSync(srcDir)) copyDir(srcDir, path.join(distDir, 'backend', 'src', subdir));
}

// 3. Patch import paths in copied files.
//    In original: _worker.js at cloudflare/_worker.js uses '../backend/' → resolves to root/backend/
//    In dist:     _worker.js at dist/_worker.js uses '../backend/' → resolves to parent/backend/ (WRONG)
//    Fix: change '../backend/' to './backend/' in root-level files,
//         change '../../backend/' to '../backend/' in routes/adapters (1 level deep),
//         change '../../backend/' to '../backend/' in services (1 level deep),
//         change '../utils/' to './utils/' in services (same level).
function patchFile(filePath) {
  let content = readFileSync(filePath, 'utf8');
  const original = content;

  // Root-level files (middleware.js, _worker.js): ../backend/ → ./backend/
  // Routes/adapters/services (1 level deep): ../../backend/ → ../backend/
  // Services: ../utils/ → ./utils/ (services imports from cloudflare/utils which is now ./utils)
  content = content.replace(/'\.\.\/backend\//g, "'./backend/");
  content = content.replace(/"\.\.\/backend\//g, '"./backend/');
  content = content.replace(/'\.\.\/\.\.\/backend\//g, "'../backend/");
  content = content.replace(/"\.\.\/\.\.\/backend\//g, '"../backend/');

  if (content !== original) {
    writeFileSync(filePath, content);
    return true;
  }
  return false;
}

let patchedCount = 0;

// Patch root-level files
for (const entry of readdirSync(distDir)) {
  const filePath = path.join(distDir, entry);
  if (statSync(filePath).isFile() && entry.endsWith('.js')) {
    if (patchFile(filePath)) patchedCount++;
  }
}

// Patch routes/, adapters/, services/ subdirectories
for (const subdir of ['routes', 'adapters', 'services']) {
  const dirPath = path.join(distDir, subdir);
  if (!existsSync(dirPath)) continue;
  for (const entry of readdirSync(dirPath)) {
    const filePath = path.join(dirPath, entry);
    if (statSync(filePath).isFile() && entry.endsWith('.js')) {
      if (patchFile(filePath)) patchedCount++;
    }
  }
}

console.log(`copied source files into frontend/dist (${patchedCount} files patched)`);
