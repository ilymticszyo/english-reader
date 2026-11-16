// Post-build step: writes dist/sw.js (precache list) and dist/version.json.
// Version = package version + short hash of all shipped files, so any content change updates the cache.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(DIST, p).split('\\').join('/'));
  }
})(DIST);

const shipped = files.filter((f) => f !== 'sw.js' && f !== 'version.json' && !f.endsWith('.map'));
const hash = createHash('sha256');
for (const f of shipped) hash.update(f).update(readFileSync(join(DIST, f)));
const version = `${pkg.version}+${hash.digest('hex').slice(0, 8)}`;

// "./" (the page itself) + every file, as relative URLs
const precache = ['./', ...shipped.map((f) => './' + f), './version.json'];
const tpl = readFileSync(resolve(import.meta.dirname, 'sw-template.js'), 'utf8');
writeFileSync(join(DIST, 'sw.js'), tpl.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(precache, null, 1)));
writeFileSync(join(DIST, 'version.json'), JSON.stringify({ version, files: precache.length, builtAt: new Date().toISOString() }));
console.log(`[sw] version ${version}, precaching ${precache.length} URLs`);
