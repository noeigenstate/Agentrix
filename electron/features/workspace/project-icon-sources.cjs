const path = require('node:path');

const ICON_EXTENSIONS = ['.png', '.ico', '.svg', '.jpg', '.jpeg', '.webp', '.gif'];
const PLATFORMS = ['win', 'mac', 'linux'];
function json(text) {
  try { const data = JSON.parse(text); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch { return {}; }
}

// This is deliberately not a YAML parser: only scalar icon paths and directories.buildResources at known keys.
function builderYaml(text) {
  const data = {}; let section = '';
  for (const line of text.split(/\r?\n/)) {
    const match = /^( *)([\w]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, indent, key, raw] = match;
    if (!indent) section = key;
    const scalar = /^(?:"([^"]*)"|'([^']*)'|([^#]*?))\s*(?:#.*)?$/.exec(raw);
    if (!scalar) continue;
    const value = (scalar[1] ?? scalar[2] ?? scalar[3]).trim();
    if (key === 'icon' && (!indent || PLATFORMS.includes(section))) {
      if (!indent) data.icon = value;
      else (data[section] ??= {}).icon = value;
    } else if (indent && section === 'directories' && key === 'buildResources') data.directories = { buildResources: value };
  }
  return data;
}

function htmlIcons(text) {
  const icons = [];
  for (const [link] of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<link\b[^>]*>/gi)) {
    const attributes = {};
    for (const match of link.matchAll(/\b(rel|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
    if (/(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(attributes.rel || '')) icons.push(attributes.href);
  }
  return icons;
}

function nativeIcons(file, text) {
  if (/\.csproj$/i.test(file)) return [...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<ApplicationIcon\b[^>]*>\s*([^<]+?)\s*<\/ApplicationIcon>/gi)].map(match => match[1]);
  const source = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
  return [...source.matchAll(/^\s*[\w]+\s+ICON\b[^\r\n"]*"([^"\r\n]+)"/gmi)].map(match => match[1]);
}

async function projectIcons(directory, { readText, list, addTarget, resourceIcons, add }) {
  const packageData = json(await readText(path.join(directory, 'package.json')) || '');
  const forge = packageData.config?.forge?.packagerConfig?.icon;
  for (const target of [packageData.icon, forge]) addTarget(directory, target, 0);
  const builders = [packageData.build];
  for (const name of ['electron-builder.yml', 'electron-builder.yaml', 'electron-builder.json']) {
    const text = await readText(path.join(directory, name));
    if (text) builders.push(name.endsWith('.json') ? json(text) : builderYaml(text));
  }
  const resources = new Set(['build']);
  for (const data of builders) {
    if (!data || typeof data !== 'object') continue;
    for (const target of [data.icon, ...PLATFORMS.map(platform => data[platform]?.icon)]) addTarget(directory, target, 0);
    if (typeof data.directories?.buildResources === 'string') resources.add(data.directories.buildResources);
  }
  for (const resource of resources) await resourceIcons(directory, resource);

  const tauriDirectory = path.join(directory, 'src-tauri');
  const tauri = json(await readText(path.join(tauriDirectory, 'tauri.conf.json')) || '');
  const bundle = tauri.bundle || tauri.tauri?.bundle;
  for (const target of Array.isArray(bundle?.icon) ? bundle.icon : []) addTarget(tauriDirectory, target, 0);
  for (const file of ['index.html', 'public/index.html']) {
    const text = await readText(path.join(directory, file));
    if (text) for (const target of htmlIcons(text)) addTarget(path.dirname(path.join(directory, file)), target, 0, true);
  }

  // Android's fixed resource path is deeper than the generic walk. Never recurse into its build/runtime trees.
  const res = path.join(directory, 'android/app/src/main/res');
  const densities = ['mipmap-xxxhdpi', 'mipmap-xxhdpi', 'mipmap-xhdpi', 'mipmap-hdpi', 'mipmap-mdpi', 'mipmap-ldpi'];
  for (const entry of await list(res)) if (entry.isDirectory() && densities.includes(entry.name.toLowerCase())) {
    add(path.join(res, entry.name, 'ic_launcher.png'), 'icon', 10, densities.length - densities.indexOf(entry.name.toLowerCase()));
  }
}

module.exports = { projectIcons, nativeIcons, ICON_EXTENSIONS };
