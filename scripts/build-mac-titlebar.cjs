const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function nodeHeaders(cache) {
  const configured = process.env.npm_config_nodedir || process.env.npm_package_config_node_gyp_nodedir;
  const candidates = configured ? [configured] : [
    path.dirname(path.dirname(fs.realpathSync(process.execPath))),
    process.config.variables.node_prefix,
    path.join(cache, process.versions.node),
    path.join(os.homedir(), 'Library/Caches/node-gyp', process.versions.node),
    path.join(os.homedir(), '.cache/node-gyp', process.versions.node),
  ];
  const headers = candidates.find(directory => directory && ['node_api.h', 'common.gypi', 'config.gypi']
    .every(file => fs.existsSync(path.join(directory, 'include/node', file))));
  if (configured && !headers) throw new Error(`Incomplete Node headers in ${configured}`);
  return headers;
}

function buildMacTitlebar({ root = path.join(__dirname, '..'), platform = process.platform, arch = process.arch, run = execFileSync } = {}) {
  if (platform !== 'darwin') return;
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  const directory = path.join(root, 'native/mac-titlebar');
  const build = path.join(directory, 'build');
  const output = path.join(build, 'Release/mac_titlebar.node');
  const stamp = path.join(build, 'build-state.json');
  const addonApi = path.dirname(require.resolve('node-addon-api'));
  const identity = JSON.stringify({ arch, napi: 8, addonApi: require('node-addon-api/package.json').version,
    nodeGyp: require('node-gyp/package.json').version });
  const sources = [__filename, path.join(directory, 'binding.gyp'), path.join(directory, 'titlebar.mm'),
    path.join(addonApi, 'napi.h'), path.join(addonApi, 'napi-inl.h')];
  const outputTime = fs.statSync(output, { throwIfNoEntry: false })?.mtimeMs;
  if (outputTime !== undefined && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === identity
    && sources.every(file => fs.statSync(file).mtimeMs <= outputTime)) {
    console.log(`mac-titlebar: up to date (${arch}, N-API 8)`);
    return output;
  }
  const cache = path.join(build, 'node-headers');
  const temporary = path.join(build, 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
  const options = { cwd: directory, stdio: 'inherit',
    env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, PYTHONDONTWRITEBYTECODE: '1' } };
  try {
    // gyp also splits SDK dependency paths containing spaces; discard only this target's old objects.
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
    let headers = nodeHeaders(cache);
    console.log(`mac-titlebar: building ${arch} (${headers ? `local headers: ${headers}` : 'download Node headers if not cached'})`);
    if (!headers) {
      run(process.execPath, [nodeGyp, 'install', `--target=${process.versions.node}`, `--devdir=${cache}`,
        '--dist-url=https://nodejs.org/download/release'], options);
      headers = path.join(cache, process.versions.node);
    }
    // gyp's make generator does not quote absolute include paths containing spaces.
    for (const [name, target] of [['node-include', headers], ['node-addon-api', addonApi]]) {
      const link = path.join(build, name);
      try { fs.unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.symlinkSync(path.resolve(target), link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    run(process.execPath, [nodeGyp, 'configure', 'build', `--arch=${arch}`, `--target=${process.versions.node}`,
      `--devdir=${cache}`, '--nodedir=build/node-include'], options);
    if (!fs.existsSync(output)) throw new Error(`Build did not produce ${output}`);
    fs.writeFileSync(stamp, identity);
  } catch (error) {
    // A failed optional rebuild must not load an older, incompatible binary.
    fs.rmSync(output, { force: true });
    fs.rmSync(stamp, { force: true });
    throw error;
  }
  console.log(`mac-titlebar: built ${output}`);
  return output;
}

if (require.main === module) {
  try {
    const arch = process.argv.find(argument => argument.startsWith('--arch='))?.slice(7)
      || process.env.npm_config_arch || process.arch;
    buildMacTitlebar({ arch });
  } catch (error) {
    console.warn(`mac-titlebar: ${error.message}`);
    if (!process.argv.includes('--optional') || process.env.CI) process.exitCode = 1;
  }
}

module.exports = { buildMacTitlebar };
