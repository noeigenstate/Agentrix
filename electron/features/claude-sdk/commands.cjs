const local = new Set(['compact', 'context']);
// Query renewal reapplies host model/effort/fast settings. Do not advertise a
// CLI-only change that the next safe budget boundary would silently discard.
const unavailable = new Set(['clear', 'reset', 'new', 'model', 'effort', 'fast']);
const nameOf = value => typeof value === 'string' ? value.replace(/^\//, '') : '';
function claudeCommands(rows, fallback, terminal) {
  const files = new Map(fallback.map(row => [nameOf(row.name), row]));
  const blocked = new Set((terminal || []).map(nameOf));
  const candidates = rows ?? fallback.filter(row => row.view === 'reading' || local.has(nameOf(row.name)));
  const result = new Map();
  // SDK built-ins win a same-name collision, as the CLI resolves typed input.
  for (const row of candidates.filter(row => row && typeof row === 'object').slice(0, 600).sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin))) {
    const name = nameOf(row.name), file = files.get(name);
    if (!/^[\w][\w:.-]{0,159}$/.test(name) || name.startsWith('__') || unavailable.has(name) || blocked.has(name) || result.has(name)
      || row.builtin && /^\(removed\)/i.test(row.description || '')) continue;
    if (!terminal && file?.view === 'terminal' && !local.has(name)) continue;
    const source = row.builtin ? 'builtin' : file?.source || row.source || 'skill';
    result.set(name, { name: '/' + name, description: String(row.description || file?.description || '').slice(0, 1024),
      source: ['builtin', 'project', 'user', 'skill'].includes(source) ? source : 'skill', view: 'reading' });
  }
  return [...result.values()].slice(0, 300);
}
module.exports = { claudeCommands };
