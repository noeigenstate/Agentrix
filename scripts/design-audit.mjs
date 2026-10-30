import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { THRESHOLDS, measureDesign, compareTokens } from './design-audit-measure.mjs';

const usage = 'node scripts/design-audit.mjs <page.html|url> [more pages...] [--root <selector>] [--view <name>=<url-query>] [--width 1280 --height 800] [--out <dir>]';

function options(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    root: { type: 'string', default: 'body' }, view: { type: 'string', multiple: true },
    width: { type: 'string', default: '1280' }, height: { type: 'string', default: '800' },
    out: { type: 'string', default: '.test-output/design-audit' }, help: { type: 'boolean' },
  } });
  if (values.help) return null;
  if (!positionals.length) throw new Error(`A page is required.\n${usage}`);
  const width = Number(values.width), height = Number(values.height);
  if (![width, height].every(value => Number.isInteger(value) && value > 0)) throw new Error('Width and height must be positive integers.');
  const views = (values.view || ['default=']).map(value => {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error('--view requires name=url-query (for example appearance=section=appearance).');
    return { name: value.slice(0, separator), query: value.slice(separator + 1).replace(/^\?/, '') };
  });
  const pages = positionals.flatMap(input => {
    let url;
    if (/^(https?|file):/i.test(input)) url = new URL(input);
    else {
      if (/^[a-z][\w+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) throw new Error(`Unsupported page URL: ${input}`);
      const separator = input.search(/[?#]/);
      const filename = separator < 0 ? input : input.slice(0, separator), suffix = separator < 0 ? '' : input.slice(separator);
      url = new URL(pathToFileURL(path.resolve(filename)).href + suffix);
    }
    return views.map(view => {
      const target = new URL(url);
      for (const [key, value] of new URLSearchParams(view.query)) target.searchParams.set(key, value);
      return { name: `${input} [${view.name}]`, input, view: view.name, url: target.href };
    });
  });
  return { root: values.root, width, height, out: path.resolve(values.out), pages };
}

async function collectPage(rootSelector) {
  await document.fonts.ready;
  await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const root = document.querySelector(rootSelector);
  if (!root) throw new Error(`Root not found: ${rootSelector}`);
  const box = rect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)), height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)) });
  const rootBox = intersect(box(root.getBoundingClientRect()), { left: 0, top: 0, width: innerWidth, height: innerHeight });
  if (!rootBox.width || !rootBox.height) throw new Error(`Root has no visible area: ${rootSelector}`);
  const selectors = new Map();
  function selector(el) {
    if (selectors.has(el)) return selectors.get(el);
    let value;
    if (el.id) value = `#${CSS.escape(el.id)}`;
    else {
      const name = el.localName;
      const siblings = el.parentElement ? [...el.parentElement.children].filter(child => child.localName === name) : [el];
      const classes = [...el.classList].map(cls => `.${CSS.escape(cls)}`).join('');
      value = `${el.parentElement && el !== root ? `${selector(el.parentElement)} > ` : ''}${name}${classes}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(el) + 1})` : ''}`;
    }
    selectors.set(el, value);
    return value;
  }
  const styles = new Map(), visibility = new Map();
  const styleOf = el => {
    if (!styles.has(el)) styles.set(el, getComputedStyle(el));
    return styles.get(el);
  };
  function visibilityOf(el) {
    if (visibility.has(el)) return visibility.get(el);
    const css = styleOf(el);
    const ancestor = el.parentElement ? visibilityOf(el.parentElement) : { rendered: true, opacity: 1 };
    const opacity = ancestor.opacity * Number(css.opacity);
    const rendered = ancestor.rendered && css.display !== 'none' && opacity > 0;
    const result = { rendered, visible: rendered && css.visibility !== 'hidden' && css.visibility !== 'collapse', opacity };
    visibility.set(el, result);
    return result;
  }
  const paneSelector = '[data-audit-pane], [role="tabpanel"], aside, main, .pane';
  const controlSelector = 'button, select, input, textarea, [role="button"], [role="combobox"], [role="switch"], [role="checkbox"], [role="radio"]';
  const interactiveSelector = `${controlSelector}, a[href], summary, label[for], [tabindex]:not([tabindex="-1"])`;
  const ignoredSelector = '[data-audit-ignore], img, picture, video, canvas';
  const rowSelector = '[data-audit-row], [role="row"], li, tr, .row, .list-row';
  const isRowLayout = css => ['flex', 'inline-flex'].includes(css.display) ? !css.flexDirection.startsWith('column') : ['grid', 'inline-grid'].includes(css.display);
  const properties = ['display', 'position', 'flexDirection', 'flexWrap', 'visibility', 'opacity', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'backgroundImage', 'backdropFilter', 'boxShadow', 'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'gap', 'rowGap', 'columnGap'];
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) properties.push(`padding${side}`, `margin${side}`, `border${side}Width`, `border${side}Style`, `border${side}Color`);
  for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) properties.push(`border${corner}Radius`);
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const context = colorCanvas.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  function normalizeColor(value) {
    if (/^(rgba?\(|#)/.test(value) || value === 'transparent') return value;
    if (colorCache.has(value)) return colorCache.get(value);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    // Canvas normalizes modern CSS colour spaces to sRGB as well.
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    const serialized = context.fillStyle;
    const alpha = /(?:[,/]\s*([\d.]+)(%)?\s*)\)$/.exec(serialized);
    const a = /^(rgba|hsla)\(/.test(serialized) || serialized.includes('/') ? Number(alpha?.[1] ?? 1) / (alpha?.[2] ? 100 : 1) : 1;
    const result = [r, g, b, a];
    colorCache.set(value, result);
    return result;
  }
  const elements = [], panes = new Map([[selector(root), { id: selector(root), rect: rootBox }]]);
  const paneRoots = new Set([root, ...[...root.querySelectorAll('*')].filter(el => el.matches(paneSelector) || !['', 'none'].includes(styleOf(el).backdropFilter))]);
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (el.closest(ignoredSelector) || el.ownerSVGElement) continue;
    const state = visibilityOf(el), css = styleOf(el), bounds = box(el.getBoundingClientRect());
    if (!state.visible || !bounds.width || !bounds.height) continue;
    let clip = intersect(bounds, rootBox);
    for (let parent = el.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
      const parentStyle = styleOf(parent), parentBox = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(parentStyle.overflowX)) clip = intersect(clip, { left: parentBox.left, top: clip.top, width: parentBox.width, height: clip.height });
      if (/(hidden|clip|auto|scroll)/.test(parentStyle.overflowY)) clip = intersect(clip, { left: clip.left, top: parentBox.top, width: clip.width, height: parentBox.height });
    }
    if (!clip.width || !clip.height) continue;
    const ownText = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const textBoxes = ownText.map(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return box(range.getBoundingClientRect());
    }).filter(bounds => {
      const visible = intersect(bounds, clip);
      return visible.width > 0 && visible.height > 0;
    });
    let textRect;
    if (textBoxes.length) {
      const left = Math.min(...textBoxes.map(bounds => bounds.left)), top = Math.min(...textBoxes.map(bounds => bounds.top));
      textRect = { left, top, width: Math.max(...textBoxes.map(bounds => bounds.left + bounds.width)) - left, height: Math.max(...textBoxes.map(bounds => bounds.top + bounds.height)) - top };
    }
    let pane = el;
    while (!paneRoots.has(pane)) pane = pane.parentElement;
    const paneId = selector(pane);
    if (!panes.has(paneId)) panes.set(paneId, { id: paneId, rect: intersect(box(pane.getBoundingClientRect()), rootBox) });
    const parent = el.parentElement, parentStyle = parent ? styleOf(parent) : null;
    const rowItem = el.matches(`${controlSelector}, svg`) || el.textContent.trim() || el.querySelector(`${controlSelector}, svg`);
    const rowParent = parent && root.contains(parent) && isRowLayout(parentStyle) && !['absolute', 'fixed'].includes(css.position) && rowItem ? selector(parent) : null;
    const computed = Object.fromEntries(properties.map(property => [property, css[property]]));
    for (const property of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']) computed[property] = normalizeColor(css[property]);
    const backgroundColors = (css.backgroundImage.match(/(?:rgba?|hsla?|color|oklch|oklab|lab|lch)\([^()]*\)|#[\da-f]{3,8}\b/gi) || []).map(normalizeColor);
    const wallpaper = el === document.body || el === document.documentElement || el.matches('[data-audit-wallpaper], .wallpaper, #wallpaper, .app-wallpaper, .wallpaper-layer') || css.backgroundImage.includes('url(') && ['fixed', 'absolute'].includes(css.position) && bounds.width >= innerWidth && bounds.height >= innerHeight;
    const valueText = ['input', 'textarea', 'select'].includes(el.localName) && !['checkbox', 'radio', 'range', 'color'].includes(el.type) && Boolean(el.value || el.placeholder);
    elements.push({ selector: selector(el), tag: el.localName, role: el.getAttribute('role'), className: el.getAttribute('class') || '', parent: parent ? selector(parent) : null, previousSibling: el.previousElementSibling ? selector(el.previousElementSibling) : null, pane: paneId, rect: bounds, clip, opacity: state.opacity, style: computed, text: Boolean(textRect || valueText), textRect, textRow: Boolean(textRect && isRowLayout(css)), textNoWrap: css.display.includes('flex') && css.flexWrap === 'nowrap', control: el.matches(controlSelector), interactive: el.matches(interactiveSelector) || css.cursor === 'pointer' && parentStyle?.cursor !== 'pointer', button: el.matches('button, [role="button"], select, [role="combobox"], [aria-haspopup="listbox"]'), row: el.matches(rowSelector), inRow: Boolean(parent?.closest(rowSelector)), rowParent, rowNoWrap: Boolean(parentStyle?.display.includes('flex') && parentStyle.flexWrap === 'nowrap'), backgroundColors, wallpaper });
  }
  if (!elements.some(el => el.text || el.control)) throw new Error('No visible HTML text or controls in scope; screenshots are not an auditable baseline.');
  return { elements, panes: [...panes.values()] };
}

function markdown(report) {
  const cell = value => (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const lines = ['# Design audit', '', `Viewport: ${report.viewport.width} x ${report.viewport.height}; root: \`${report.root}\`; scale: 1; prefers-reduced-motion: no-preference.`, '',
    'Visible text uses its own text nodes (no ancestor text duplication). Panes are the root, `[data-audit-pane]`, `[role=tabpanel]`, `aside`, `main`, `.pane`, and backdrop-filter surfaces; elements belong to their nearest pane. A1/A2 count row starts and column text blocks, coalescing inline row contents. S3 compares adjacent same-class sibling runs; separators start new runs. F2 counts solid filled buttons, including select triggers. Media and `[data-audit-ignore]` subtrees and page/wallpaper surfaces are excluded. P1 excludes zero and groups radii at least half the element height as pill. C1/C2 exclude pane/material surfaces and colours below 12% or above 92% HSL lightness. C2 uses clipped descendant background rectangle unions, including gradients, rather than pixel masks or occlusion. Compact button heights are allowed only inside rows. Zero-duration defaults do not declare a transition.', '',
    'Every offending selector and its measured value appears in JSON and the tables. Each metric includes a how-to-fix hint. F3 requires human review and does not affect the automated exit code.', ''];
  for (const page of report.pages) {
    lines.push(`## ${cell(page.name)}`, '', `URL: \`${page.url}\``, '');
    if (page.screenshot) lines.push(`[Screenshot](${page.screenshot}) · [12px blurred grayscale](${page.blurredScreenshot})`, '');
    lines.push('| Metric | Measured | Threshold | Result | Offending selectors and values | How to fix |', '| --- | --- | --- | --- | --- | --- |');
    for (const metric of page.metrics) {
      const offenders = (metric.offenders || []).map(entry => `${cell(entry.selector)}: ${cell(entry.value)}`).join('<br>');
      lines.push(`| ${metric.id} | ${cell(metric.value)} | ${cell(metric.threshold)} | ${metric.manual ? 'REVIEW' : metric.pass ? 'PASS' : 'FAIL'} | ${offenders} | ${cell(metric.hint)} |`);
    }
    lines.push('');
  }
  const p6 = report.comparison;
  lines.push('## P6 — token consistency across pages/views', '', '| Metric / token | Page | Measured / differences | Threshold | Result |', '| --- | --- | --- | --- | --- |',
    `| P6 | ${p6.compared} successful page(s) | ${p6.value} differing token sets${p6.compared < 2 ? '; needs at least two pages/views for comparison' : ''} | ${p6.threshold} | ${p6.compared < 2 ? 'N/A' : p6.pass ? 'PASS' : 'FAIL'} |`);
  for (const difference of p6.differences) lines.push(`| ${difference.token} | ${cell(difference.page)} vs ${cell(difference.baseline)} | missing ${cell(difference.missing)}; added ${cell(difference.added)} | identical sets | FAIL |`);
  lines.push('', `How to fix P6: ${p6.hint}`, '');
  if (p6.offenders.length) {
    lines.push('| Offending selector | Measured token difference |', '| --- | --- |');
    for (const entry of p6.offenders) lines.push(`| ${cell(entry.selector)} | ${cell(entry.value)} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function runElectron(config) {
  const { app, BrowserWindow } = createRequire(import.meta.url)('electron');
  app.setName('Agentrix Design Audit');
  app.setPath('userData', process.env.AGENTRIX_DATA_DIR);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  // Keep the process alive between isolated windows and while writing reports.
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const report = { root: config.root, viewport: { width: config.width, height: config.height }, reducedMotion: 'no-preference', thresholds: THRESHOLDS, pages: [] };
  for (const [index, page] of config.pages.entries()) {
    const window = new BrowserWindow({ show: false, width: config.width, height: config.height, useContentSize: true, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true, partition: `design-audit-${index}` } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    let timeout;
    try {
      const result = await Promise.race([
        (async () => {
          await window.loadURL(page.url);
          window.webContents.debugger.attach('1.3');
          await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
          const measured = await window.webContents.executeJavaScript(`(async () => { const THRESHOLDS = ${JSON.stringify(THRESHOLDS)}; const measureDesign = ${measureDesign.toString()}; return measureDesign(await (${collectPage.toString()})(${JSON.stringify(config.root)})); })()`);
          const name = `${String(index + 1).padStart(2, '0')}-${path.basename(new URL(page.url).pathname, '.html').replace(/[^\w-]/g, '-').slice(0, 60) || 'page'}-${page.view.replace(/[^\w-]/g, '-').slice(0, 40)}`;
          const screenshot = `${name}.png`, blurredScreenshot = `${name}-blurred-grayscale.png`;
          // Wait for the offscreen compositor to paint the measured state.
          await new Promise(resolve => {
            window.webContents.once('paint', resolve);
            window.webContents.invalidate();
          });
          const image = await window.webContents.capturePage();
          if (image.isEmpty()) throw new Error('Screenshot is empty.');
          await fs.writeFile(path.join(config.out, screenshot), image.toPNG());
          const grayscale = await window.webContents.executeJavaScript(`(async () => {
            const image = new Image(); image.src = ${JSON.stringify(image.toDataURL())}; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d'); context.filter = 'grayscale(1) blur(${THRESHOLDS.F3.blur}px)'; context.drawImage(image, 0, 0);
            return canvas.toDataURL('image/png').split(',')[1];
          })()`);
          await fs.writeFile(path.join(config.out, blurredScreenshot), Buffer.from(grayscale, 'base64'));
          measured.metrics.splice(2, 0, { id: 'F3', value: blurredScreenshot, threshold: `${THRESHOLDS.F3.blur}px blurred grayscale screenshot for human focus review`, manual: true, pass: null, offenders: [], hint: 'Check that the intended focus stands out in the blurred grayscale screenshot.' });
          return { ...measured, screenshot, blurredScreenshot };
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Page load/measurement/capture timed out after 30 seconds.')), 30000); }),
      ]);
      report.pages.push({ ...page, ...result });
      console.log(`${page.name}: ${result.metrics.filter(metric => metric.pass === false).length} automated failure(s)`);
    } catch (error) {
      report.pages.push({ ...page, metrics: [{ id: 'LOAD', value: error.message, threshold: 'visible HTML UI loaded and measured', pass: false, offenders: [{ selector: config.root, value: error.message }], hint: 'Load visible HTML UI at the requested URL and root selector.' }] });
      console.error(`${page.name}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
      window.destroy();
    }
  }
  report.comparison = compareTokens(report.pages.filter(page => page.tokens));
  report.pass = report.pages.every(page => page.metrics.every(metric => metric.pass !== false)) && report.comparison.pass;
  await fs.writeFile(path.join(config.out, 'audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(config.out, 'audit.md'), markdown(report));
  console.log(`Reports: ${path.join(config.out, 'audit.json')} and ${path.join(config.out, 'audit.md')}`);
  app.exit(report.pass ? 0 : 1);
}

try {
  const args = process.argv.slice(2);
  const config = options(args);
  if (!config) console.log(usage);
  // Electron waits for ESM evaluation before ready; awaiting it here deadlocks startup.
  else if (process.versions.electron) runElectron(config).catch(error => {
    console.error(error.message);
    createRequire(import.meta.url)('electron').app.exit(1);
  });
  else {
    await fs.mkdir(config.out, { recursive: true });
    const profile = await fs.mkdtemp(path.join(config.out, 'profile-'));
    const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: await fs.mkdtemp(path.join(path.dirname(profile), 'codex-home-')) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), ...args], { env, stdio: 'inherit', windowsHide: true });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
} catch (error) {
  console.error(error.message);
  if (process.versions.electron) createRequire(import.meta.url)('electron').app.exit(1);
  else process.exitCode = 1;
}
