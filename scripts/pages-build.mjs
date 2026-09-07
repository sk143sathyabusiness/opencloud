import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const env = { ...process.env, VITE_API_BASE_URL: '/api', VITE_WS_BASE_URL: '/ws/uploads' };
const run = spawnSync('npm', ['--prefix', 'frontend', 'run', 'build'], { stdio: 'inherit', env, shell: true });
if (run.status !== 0) process.exit(run.status ?? 1);

copyFileSync(path.join(root, 'cloudflare', '_worker.js'), path.join(root, 'frontend', 'dist', '_worker.js'));
console.log('copied _worker.js into frontend/dist');
