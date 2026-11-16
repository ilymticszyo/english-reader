// Zips dist/ (index.html at the zip root) to english-reader-dist.zip. Uses the system `zip` tool (or Python as a fallback).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const out = resolve(ROOT, 'english-reader-dist.zip');
rmSync(out, { force: true });
try {
  execFileSync('zip', ['-qr', '-X', out, '.'], { cwd: resolve(ROOT, 'dist') });
} catch {
  execFileSync('python3', ['-c', `import shutil,sys; shutil.make_archive(sys.argv[1][:-4],'zip',sys.argv[2])`, out, resolve(ROOT, 'dist')]);
}
console.log('[zip] wrote', out);
