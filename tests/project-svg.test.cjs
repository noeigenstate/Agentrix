const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeProjectSvg, SVG_MAX_BYTES } = require('../electron/project-svg.cjs');

const svg = text => Buffer.from(text);
const content = url => Buffer.from(url.split(',')[1], 'base64').toString('utf8');

test('rayrea app.svg stays SVG with the card primary ink and canonical storage validation', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/project-images/rayrea-app.svg'));
  const result = sanitizeProjectSvg(bytes);
  assert.match(result, /^data:image\/svg\+xml;base64,/);
  assert.equal(content(result), bytes.toString('utf8').replace(/currentColor/g, '#f2f2f2'));
  assert.equal(sanitizeProjectSvg(result), result);
  assert.equal(content(sanitizeProjectSvg(svg('<svg viewBox="0 0 48 24"><path fill="CuRrEnTcOlOr" d="M0 0h48v24z"/></svg>'))),
    '<svg viewBox="0 0 48 24"><path fill="#f2f2f2" d="M0 0h48v24z"/></svg>');
});

test('static gradients, same-document references, XML declaration, comments and UTF-8 text are accepted', () => {
  for (const text of [
    '<?xml version="1.0" encoding="UTF-8"?>\n<!-- app icon --><svg xmlns="http://www.w3.org/2000/svg"><title>图标 &amp; Logo</title></svg>\n<!-- end -->',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="part" d="M0 0"/></defs><use href="#part"/><use xlink:href="&#35;part"/></svg>',
    '<svg><defs><linearGradient id="ink"><stop stop-color="#fff"/></linearGradient></defs><path fill="url(#ink)" style="stroke: url(\'#ink\')"/></svg>',
    '<svg><style>.ink { fill: currentColor; }</style><g class="ink"/></svg>',
  ]) assert.equal(content(sanitizeProjectSvg(svg(text))), text.replace(/currentColor/g, '#f2f2f2'));
});

const rejected = {
  script: '<svg><script>alert(1)</script></svg>',
  onload: '<svg onload="alert(1)"></svg>',
  event: '<svg><g oNcLiCk="alert(1)"/></svg>',
  foreignObject: '<svg><foreignObject><div>HTML</div></foreignObject></svg>',
  iframe: '<svg><iframe/></svg>', embed: '<svg><embed/></svg>', object: '<svg><object/></svg>',
  animation: '<svg><animate attributeName="fill"/></svg>',
  cssAnimation: '<svg><style>@keyframes spin { to { opacity: 0; } } .icon { animation: spin 1s infinite; }</style></svg>',
  cssTransition: '<svg><g style="transition: opacity 1s"/></svg>',
  externalHref: '<svg><use href="https://example.com/logo.svg#part"/></svg>',
  fileHref: '<svg><image href="local.png"/></svg>',
  dataHref: '<svg><image href="data:image/png;base64,YWJj"/></svg>',
  xlink: '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="//example.com/a"/></svg>',
  javascript: '<svg><title>javascript:alert(1)</title></svg>',
  encodedJavascript: '<svg><use href="java&#x73;cript:alert(1)"/></svg>',
  externalUrl: '<svg><path fill="url(https://example.com/ink)"/></svg>',
  dataUrl: '<svg><path style="fill:url(data:image/svg+xml;base64,YWJj)"/></svg>',
  escapedCss: '<svg><path style="fill:u\\72l(https://example.com/ink)"/></svg>',
  import: '<svg><style>@import "https://example.com/ink.css";</style></svg>',
  styleUrl: '<svg><style>.ink { fill:url(#part); }</style></svg>',
  splitImport: '<svg><style>@im<!-- hidden -->port "https://example.com/style.css";</style></svg>',
  commentedImport: '<svg><style>@im/**/port "https://example.com/style.css";</style></svg>',
  doctype: '<!DOCTYPE svg [<!ENTITY a "123"><!ENTITY b "&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;">]><svg>&c;</svg>',
  entity: '<svg><!ENTITY a "value"></svg>',
  html: '<html><svg/></html>',
  extraRoot: '<svg/><svg/>',
  mismatched: '<svg><g></svg>',
  missingRoot: '<path d="M0 0"/>',
  trailingText: '<svg/>junk',
  malformedAttribute: '<svg viewBox=0/>',
  namespace: '<svg xmlns="http://www.w3.org/1999/xhtml"/>',
  processingInstruction: '<?xml-stylesheet href="https://example.com/style"?><svg/>',
  invalidEntity: '<svg><title>&custom;</title></svg>',
  unterminatedUrl: '<svg fill="url(' + ' '.repeat(20_000) + '"/>',
};
for (const [name, text] of Object.entries(rejected)) test('SVG rejects ' + name, () => {
  assert.equal(sanitizeProjectSvg(svg(text)), null);
  assert.equal(sanitizeProjectSvg(`data:image/svg+xml;base64,${svg(text).toString('base64')}`), null);
});

test('invalid UTF-8, noncanonical base64 and oversize SVGs are rejected without truncation', () => {
  assert.equal(sanitizeProjectSvg(Buffer.concat([svg('<svg>'), Buffer.from([0xc3, 0x28]), svg('</svg>')])), null);
  assert.equal(sanitizeProjectSvg(svg('<?xml version="1.0" encoding="ISO-8859-1"?><svg/>')), null);
  assert.equal(sanitizeProjectSvg('data:image/svg+xml;base64,PHN2Zy8+\n'), null);
  assert.equal(sanitizeProjectSvg('data:image/svg+xml;base64,PHN2Zy8+==='), null);
  const exact = svg('<svg>' + ' '.repeat(SVG_MAX_BYTES - 11) + '</svg>');
  assert.equal(exact.length, SVG_MAX_BYTES); assert.ok(sanitizeProjectSvg(exact));
  assert.equal(sanitizeProjectSvg(Buffer.concat([exact, svg(' ')])), null);
  assert.equal(sanitizeProjectSvg(null), null);
});
