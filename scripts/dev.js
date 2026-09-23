// Runs the API server (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch', 'server/index.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'client/vite.config.js'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
