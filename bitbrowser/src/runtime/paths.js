/** Configurable state paths, independent of the Agent's working directory. */
import path from 'node:path';
import { homedir } from 'node:os';

/** Return the persistent application state root; never use the skill source as storage. */
export function stateDirectory() {
  return path.resolve(
    process.env.BITBROWSER_STATE_DIR ||
      (process.platform === 'win32'
        ? path.join(
            process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'),
            'bitbrowser',
          )
        : path.join(homedir(), '.local', 'state', 'bitbrowser')),
  );
}

/** All copies on a host must share this directory to coordinate requests and windows. */
export function coordinationDirectory() {
  return path.resolve(
    process.env.BITBROWSER_COORDINATION_DIR ||
      (process.platform === 'win32'
        ? path.join(
            process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'),
            'bitbrowser-coordination',
          )
        : path.join(homedir(), '.local', 'state', 'bitbrowser-coordination')),
  );
}
