// The desktop suites share one physical desktop. Children inherit the lock and private output root.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { withGuiLock } from './gui-lock.mjs';
const suites = ['smoke','restore-slow','session','completion','gpu-terminal','workspace','editor-terminals','themes-markdown','visual','navigation','git','cmd','clipboard','material','composer','reading','dashboard','native-question','native-session','native-session-runtime','reading-hierarchy','path-refresh'];
const selected = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only')+1].split(',') : suites;
if (selected.some(name => !suites.includes(name))) throw new Error('Unknown GUI suite');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'agx-windows-gui-'));
const results = [];
console.log('GUI evidence: '+output);
await withGuiLock('windows-gui', async () => {
  for (const name of selected) {
    const file = name === 'smoke' ? 'scripts/smoke.mjs' : 'scripts/'+name.replace('-runtime','')+'-smoke.mjs';
    const args = [file, ...(name.endsWith('-runtime') ? ['--runtime'] : []), ...(process.argv.includes('--packaged') ? ['--packaged'] : [])];
    const start = Date.now(); let log = '', timedOut = false;
    const child = spawn(process.execPath, args, { windowsHide: true, env: { ...process.env, AGENTRIX_TEST_OUTPUT_ROOT: output, GIT_CEILING_DIRECTORIES: [output, os.tmpdir()].join(path.delimiter) }, stdio: ['ignore','pipe','pipe'] });
    child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    const timer = setTimeout(() => { timedOut = true; spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000,stdio:'ignore'}); }, 240000);
    const code = await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',resolve); }); clearTimeout(timer);
    await fs.writeFile(path.join(output,name+'.log'),log);
    results.push({ name, code, timedOut, ms:Date.now()-start });
    await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));
    console.log(name+': '+(code === 0 ? 'PASS' : 'FAIL')+' ('+Math.round((Date.now()-start)/1000)+' s)');
  }
});
process.exit(results.every(item=>item.code===0) ? 0 : 1);
