import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const fixtures = fileURLToPath(new URL('../tests/fixtures/', import.meta.url)), protocol = path.join(fixtures, 'gui-codex-app-server.cjs');
export const guiCodexEnvironment = () => ({ AGENTRIX_FAKE_NODE: process.execPath, AGENTRIX_GUI_CODEX_RPC: protocol });

// The app-server stand-in as codex.exe in `bin`, for a Windows PATH: started as an app-server it runs the protocol file
// guiCodexEnvironment names. It never runs Codex and reaches no model.
export const windowsCodexStandIn = bin => promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(fixtures, 'restore-codex.cs')], { windowsHide: true });

// The same stand-in as the `codex` on a POSIX PATH. A shell script that names its interpreter and the .cjs file: Node
// decides what a file without an extension is from its folder's package.json, and a test folder inside this
// repository ("type": "module") would make a `#!node` script an ES module, where require does not exist.
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const posixCodexStandIn = () => `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(protocol)} "$@"\n`;
