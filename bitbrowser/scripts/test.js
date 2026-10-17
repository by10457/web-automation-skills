/** Run the project's tests with rebuildable artifacts in an isolated scratch directory. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Allow callers to choose a scratch disk without requiring a machine-specific drive.
const scratch = process.env.BITBROWSER_TEST_ROOT || path.join(tmpdir(), 'bitbrowser-tests');
mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(path.join(scratch, 'run-'));
const result = spawnSync(
  process.execPath,
  ['--test', ...(process.argv.slice(2).length ? process.argv.slice(2) : ['tests/*.test.js'])],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      TEMP: run,
      TMP: run,
      TMPDIR: run,
      BITBROWSER_COORDINATION_DIR: path.join(run, 'coordination'),
      BITBROWSER_STATE_DIR: path.join(run, 'state'),
    },
  },
);
process.exitCode = result.status ?? 1;
