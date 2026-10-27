// Skills are committed and pushed with the project. Remove personal data and secrets before they leave the machine.
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PLACEHOLDER = /(<(?:private-key|secret|user|email|phone|id-number|ip|home|host|redacted)>)/g;
const EXTENSIONS = new Set(['', '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.sh', '.ps1', '.py', '.js', '.cjs', '.mjs', '.ts']);
const MAX_BYTES = 1024 * 1024;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET_KEY = '(?:[A-Za-z_][\\w.-]*[_-])?(?:password|passwd|pwd|secret|token|api_key|apikey|access_key|client_secret|密码|口令|密钥)';
const SECRET_VALUE = '(?:"(?:\\\\[^\\r\\n]|[^"\\\\\\r\\n])*"|\'(?:\\\\[^\\r\\n]|[^\'\\\\\\r\\n])*\'|`[^`\\r\\n]*`|[^\\s,;#{}\\[\\]()"\'`<>]+)';
const SECRET_ASSIGNMENT = new RegExp(`(?<![\\p{L}\\p{N}_-])(["']?${SECRET_KEY}["']?)([ \\t]*(?:=|[:：]|是)[ \\t]*)(${SECRET_VALUE})`, 'giu');
const SECRET_ARGUMENT = new RegExp(`(--${SECRET_KEY})([ \\t]+)(${SECRET_VALUE})`, 'gi');

function literals(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.trim().length >= 3)
    .map(value => value.toLowerCase()))].sort((a, b) => b.length - a.length);
}

function scrubText(text, context = {}) {
  const findings = {};
  const hosts = literals(context.hosts).map(host => new RegExp(escapeRegex(host), 'gi'));
  const homes = literals(context.homes).map(home => {
    const base = home.replace(/[\\/]+$/, '') || home;
    return new RegExp(`(?<![\\p{L}\\p{N}_/\\\\])${escapeRegex(base)}(?=$|[\\\\/\\s"'\x60<>),;\\]])`, 'giu');
  });
  const users = literals(context.users).map(user => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(user)}(?![\\p{L}\\p{N}_])`, 'giu'));
  const words = literals(context.words).map(word => new RegExp(escapeRegex(word), 'gi'));
  // Work only between placeholders, including those supplied by an earlier scrub.
  function replace(pattern, kind, replacement) {
    text = text.split(PLACEHOLDER).map((part, index) => {
      if (index % 2) return part;
      return part.replace(pattern, (...args) => {
        const result = typeof replacement === 'function' ? replacement(...args) : replacement;
        if (result !== args[0]) findings[kind] = (findings[kind] || 0) + 1;
        return result;
      });
    }).join('');
  }

  function scrubPass() {
    replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi, 'private-key', '<private-key>');

    const hideValue = (match, name, separator, original) => {
      const quote = /^["'`]/.test(original) ? original[0] : '';
      if (original === quote + quote) return match;
      return name + separator + quote + '<secret>' + quote;
    };
    replace(SECRET_ASSIGNMENT, 'secret', hideValue);
    replace(SECRET_ARGUMENT, 'secret', hideValue);
    replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@<>]+:[^\s/@<>]*@/g, 'url-credentials', match => match.slice(0, match.indexOf('://') + 3) + '<user>:<secret>@');
    replace(/\b(Bearer[ \t]+)[A-Za-z0-9._~+\/-]+=*/gi, 'secret', (match, prefix) => prefix + '<secret>');
    replace(/\b(?:sk-(?:(?:ant|proj)-)?[A-Za-z0-9_-]{8,}|gh[pos]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})(?![\w-])/g, 'secret', '<secret>');
    replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\w-])/g, 'secret', '<secret>');
    replace(/(?<![\w.!#$%&'*+/=?^`{|}~-])[A-Za-z0-9.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![\w-])/g, 'email', '<email>');
    replace(/(?<![\w])\d{17}[\dX](?![\w])/gi, 'id-number', match => {
      const year = Number(match.slice(6, 10)), month = Number(match.slice(10, 12)), day = Number(match.slice(12, 14));
      const date = new Date(Date.UTC(year, month - 1, day));
      return year >= 1800 && date <= new Date() && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? '<id-number>' : match;
    });
    replace(/(?<![\w+])\+(?:\d[ \t-]*){7,14}\d(?![\w]|[ \t-]*\d)/g, 'phone', '<phone>');
    replace(/(?<![\w+])(?:86[ \t-]*)?1[ \t-]*[3-9](?:[ \t-]*\d){9}(?![\w]|[ \t-]*\d)/g, 'phone', '<phone>');
    for (const pattern of hosts) replace(pattern, 'host', '<host>');
    for (const pattern of homes) replace(pattern, 'home', '<home>');
    replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g, 'ip', (match, offset, source) => {
      const prefix = source.slice(0, offset);
      if (/(?:\b(?:version|ver)[ \t]*(?:[:=][ \t]*)?|\bv[ \t]*)$/i.test(prefix)) return match;
      // npm versions use package@version; SSH user@host and URL authorities still contain private IPs.
      if (/(?:[\w.-]+|@[\w.-]+\/[\w.-]+)@$/.test(prefix)
        && !/\b(?:root|admin|ubuntu|ec2-user)@$/.test(prefix)
        && !/\b(?:ssh|scp|sftp|rsync)\b[^\r\n]*@$/.test(prefix)) return match;
      const parts = match.split('.').map(Number);
      if (parts.some(part => part > 255)) return match;
      if (['127.0.0.1', '0.0.0.0', '255.255.255.255'].includes(match) || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(match)) return match;
      return '<ip>';
    });

    replace(/\b[A-Z]:[\\/]+Users[\\/]+(?:[^\\/\r\n"'`<>:;,()[\]{}]+(?=[\\/])|[^\\/\s"'`<>:;,()[\]{}]+)/gi, 'home', match => /[\\/]Public$/i.test(match) ? match : '<home>');
    replace(/(?<![\w./:-])\/(?:home|Users)\/[^/\s"'`<>:;,()[\]{}]+/gi, 'home', '<home>');
    for (const pattern of users) replace(pattern, 'user', '<user>');
    for (const pattern of words) replace(pattern, 'word', '<redacted>');
  }
  // A literal replacement can expose a token or word boundary. Finish that work in this call.
  let previous;
  do { previous = text; scrubPass(); } while (text !== previous);
  return { text, findings };
}

async function scrubSkills(folder, context = {}) {
  const changed = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  async function walk(directory) {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ['node_modules', '.git'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
      const bytes = await fs.readFile(file);
      if (bytes.length > MAX_BYTES || bytes.some(byte => byte < 9 || byte === 11 || (byte > 13 && byte < 32))) continue;
      let original;
      try { original = decoder.decode(bytes); } catch { continue; }
      const result = scrubText(original, context);
      if (result.text === original) continue;
      await fs.writeFile(file, result.text, 'utf8');
      changed.push({ file: path.relative(folder, file).split(path.sep).join('/'), findings: result.findings });
    }
  }
  try { await walk(folder); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return changed;
}

module.exports = { scrubText, scrubSkills };
