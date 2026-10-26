const { TextDecoder } = require('node:util');

// Icons are small text pictures. Bound both parsing work and the persisted data URL, without truncating XML.
const SVG_MAX_BYTES = 100 * 1024;
const SVG_URL = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/]+={0,2})$/;
const ELEMENTS = new Set(('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc style image ' +
  'linearGradient radialGradient stop pattern clipPath mask marker filter feBlend feColorMatrix feComponentTransfer feComposite ' +
  'feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR ' +
  'feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence').split(' '));
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const FRAGMENT = /^#[^\s"'()<>\\#]+$/;

function xmlText(value) {
  let valid = true;
  const decoded = value.replace(/&([^;\s<&]*);|&/g, (entity, name) => {
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
    const code = /^#\d+$/.test(name) ? Number(name.slice(1)) : /^#x[\da-f]+$/i.test(name) ? Number.parseInt(name.slice(2), 16) : 0;
    if (code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff) return String.fromCodePoint(code);
    valid = false; return entity;
  });
  return valid && !/javascript:/i.test(decoded) ? decoded : null;
}

function staticUrls(value, stylesheet = false) {
  // Escaped CSS identifiers can hide url/import. Icons do not need them; do not try to repair CSS.
  if (value.includes('\\') || /@import/i.test(value)) return false;
  const css = value.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@(?:import|(?:-[\w]+-)?keyframes)\b|\b(?:animation|transition)(?:-[\w-]+)?\s*:/i.test(css)) return false;
  if (stylesheet) return !/url\s*\(/i.test(css);
  const rest = css.replace(/url\s*\(([^()]*)\)/gi, (whole, target) => {
    target = target.trim();
    if ((target[0] === '"' || target[0] === "'") && target.at(-1) === target[0]) target = target.slice(1, -1);
    return FRAGMENT.test(target) ? '' : whole;
  });
  return !/url\s*\(/i.test(rest);
}

// Only a static SVG tree is accepted. This data URL belongs exclusively in <img src>, never in a document/DOM.
// The only transformation is literal currentColor -> the card's primary ink.
function sanitizeProjectSvg(input) {
  let bytes = input;
  if (typeof input === 'string') {
    if (input.length > Math.ceil(SVG_MAX_BYTES / 3) * 4 + 26) return null;
    const match = SVG_URL.exec(input);
    if (!match) return null;
    bytes = Buffer.from(match[1], 'base64');
    if (bytes.toString('base64') !== match[1]) return null;
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > SVG_MAX_BYTES) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|<!DOCTYPE|<!ENTITY|javascript:|<(?:script|foreignObject|iframe|embed|object)\b/i.test(text)) return null;
  const stack = []; let at = 0, root = false, declaration = false;
  const tag = /<(\/?)([A-Za-z][\w.-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*)(\/?)>/y;
  const attribute = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  while (at < text.length) {
    if (text.startsWith('<!--', at)) {
      if (stack.at(-1) === 'style') return null;
      const end = text.indexOf('-->', at + 4);
      if (end < 0 || text.slice(at + 4, end).includes('--')) return null;
      at = end + 3; continue;
    }
    if (text.startsWith('<?xml', at)) {
      if (root || declaration || text.slice(0, at).trim()) return null;
      const xml = /^<\?xml\s+version\s*=\s*(['"])1\.[01]\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>/i.exec(text.slice(at));
      if (!xml) return null;
      declaration = true; at += xml[0].length; continue;
    }
    if (text[at] !== '<') {
      const end = text.indexOf('<', at), value = text.slice(at, end < 0 ? text.length : end), decoded = xmlText(value);
      if (decoded === null || value.includes(']]>') || !stack.length && value.trim() || !staticUrls(decoded, stack.at(-1) === 'style')) return null;
      at += value.length; continue;
    }
    tag.lastIndex = at;
    const match = tag.exec(text);
    if (!match) return null;
    const [, closing, name, attributes, selfClosing] = match;
    if (!ELEMENTS.has(name)) return null;
    if (closing) {
      if (selfClosing || attributes.trim() || stack.pop() !== name) return null;
    } else {
      if (stack.at(-1) === 'style') return null;
      if (!stack.length) { if (root || name !== 'svg') return null; root = true; }
      const seen = new Set(); attribute.lastIndex = 0;
      for (const attr of attributes.matchAll(attribute)) {
        const key = attr[1], value = xmlText(attr[2] ?? attr[3]);
        if (seen.has(key) || /^on/i.test(key) || value === null || !staticUrls(value)) return null;
        if (key === 'xmlns' && value !== 'http://www.w3.org/2000/svg' || key === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink') return null;
        if (key.includes(':') && !['xmlns:xlink', 'xlink:href', 'xml:space', 'xml:lang'].includes(key)) return null;
        if (/^(?:xlink:)?href$/i.test(key) && !FRAGMENT.test(value.trim())) return null;
        seen.add(key);
      }
      if (!selfClosing) stack.push(name);
    }
    at = tag.lastIndex;
  }
  if (!root || stack.length) return null;
  text = text.replace(/currentColor/gi, '#f0f0f0');
  // Encoded currentColor is safe but would remain black; reject it rather than rewriting XML attributes.
  if (/currentcolor/i.test(xmlText(text) || '')) return null;
  const sanitized = Buffer.from(text, 'utf8');
  return sanitized.length <= SVG_MAX_BYTES ? `data:image/svg+xml;base64,${sanitized.toString('base64')}` : null;
}

module.exports = { sanitizeProjectSvg, SVG_MAX_BYTES };
