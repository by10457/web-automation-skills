/** Verify syntax, formatting and JS-only sources without executing browser operations. */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const folders = ['src', 'adapters', 'scripts', 'tests'];
let count = 0;
let failed = false;

/** Traverse only project source folders; installed dependency formats are not project policy. */
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(file);
    else if (entry.name.endsWith('.mjs')) {
      console.error(`不允许项目源码使用 MJS: ${file}`);
      failed = true;
    } else if (entry.name.endsWith('.js')) {
      count++;
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) failed = true;
    }
  }
}

folders.forEach((folder) => inspect(path.join(root, folder)));
const setupCheck = spawnSync(process.execPath, ['--check', path.join(root, 'setup.js')], {
  stdio: 'inherit',
});
count++;
if (setupCheck.status !== 0) failed = true;
const formatted = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/prettier/bin/prettier.cjs'), '--check', 'setup.js', ...folders],
  { cwd: root, stdio: 'inherit' },
);
if (formatted.status !== 0) failed = true;
console.log(`Checked ${count} JavaScript files.`);
process.exitCode = failed ? 1 : 0;
