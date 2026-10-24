import type { ReactNode } from 'react';
import './file-icons.css';

// Agentrix's own file-tree icons, drawn here as vectors on a 16-unit grid (no third-party artwork, no brand marks).
// A folder is a small filled folder in its own soft colour with one light mark, picked by its name; a file is a
// rounded page tile with a crisp mark, picked by its type. Colours are tokens in file-icons.css.
// Strokes are 1 unit on half-unit coordinates, so they stay on whole pixels.

type Tone = 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'purple' | 'indigo' | 'teal' | 'cyan' | 'grey' | 'slate' | 'dark' | 'page';

const Svg = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <svg className="file-icon fi" data-tone={tone} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">{children}</svg>
);

// Folder marks are drawn around (8, 9.5).
const Gear = () => (
  <>
    <circle cx="8" cy="9.5" r="1.5" />
    <path d="M8 6.5v1M8 11.5v1M5 9.5h1M10 9.5h1M5.9 7.4l.7.7M10.1 7.4l-.7.7M5.9 11.6l.7-.7M10.1 11.6l-.7-.7" />
  </>
);
const Branch = () => (
  <>
    <path d="M6.5 7.5v4M6.5 10.5c0-1.2.8-2 3-2" />
    <circle className="f" cx="6.5" cy="7.5" r="1" /><circle className="f" cx="6.5" cy="11.5" r="1" /><circle className="f" cx="9.5" cy="8.5" r="1" />
  </>
);
const marks: Record<string, ReactNode> = {
  code: <path d="M6.5 7.5 5 9.5l1.5 2M9.5 7.5l1.5 2-1.5 2M8.5 7l-1 5" />,
  flask: <path d="M7 6.5v2.5L5.5 12h5L9 9V6.5M6.5 6.5h3" />,
  page: <path d="M6 6.5h2.5L10 8v4.5H6zM7.5 10.5h1.5" />,
  terminal: <path d="M5.5 8l2 1.5-2 1.5M8.5 11.5h2.5" />,
  picture: (<><path className="f" d="M5.5 11.5l2-2.5 1.5 1.5 1-1 .5 2z" /><circle className="f" cx="9.5" cy="8.5" r=".9" /></>),
  star: <path className="f" d="M8 6.2l1 2.1 2.2.3-1.6 1.6.4 2.3L8 11.4l-2 1.1.4-2.3-1.6-1.6 2.2-.3z" />,
  atom: (<><ellipse cx="8" cy="9.5" rx="3.4" ry="1.3" transform="rotate(45 8 9.5)" /><ellipse cx="8" cy="9.5" rx="3.4" ry="1.3" transform="rotate(-45 8 9.5)" /><circle className="f" cx="8" cy="9.5" r=".9" /></>),
  plug: (<><path d="M7 6.5v2M9 6.5v2M8 11.5v1" /><path className="f" d="M6 8.5h4v1a2 2 0 0 1-4 0z" /></>),
  box: <path d="M8 6.5l2.5 1.5v3L8 12.5 5.5 11V8zM5.5 8 8 9.5 10.5 8M8 9.5v3" />,
  hex: (<><path d="M8 6.5l2.5 1.5v3L8 12.5 5.5 11V8z" /><circle className="f" cx="8" cy="9.5" r=".9" /></>),
  branch: <Branch />,
  gear: <Gear />,
  spark: <path d="M8 6.5v6M5 9.5h6M5.9 7.4l4.2 4.2M10.1 7.4l-4.2 4.2" />,
  list: <path className="sq" d="M5 7.5h1M7.5 7.5h3M5 9.5h1M7.5 9.5h3M5 11.5h1M7.5 11.5h3" />,
};

const folderToneMark: Record<string, [Tone, string]> = {
  src: ['blue', 'code'], source: ['blue', 'code'], lib: ['blue', 'code'],
  test: ['green', 'flask'], tests: ['green', 'flask'], __tests__: ['green', 'flask'], spec: ['green', 'flask'], e2e: ['green', 'flask'],
  docs: ['blue', 'page'], doc: ['blue', 'page'],
  scripts: ['teal', 'terminal'], script: ['teal', 'terminal'], bin: ['teal', 'terminal'],
  assets: ['yellow', 'picture'], images: ['yellow', 'picture'], img: ['yellow', 'picture'], public: ['yellow', 'picture'], static: ['yellow', 'picture'],
  skills: ['purple', 'star'],
  electron: ['cyan', 'atom'],
  integration: ['orange', 'plug'],
  dist: ['indigo', 'box'], build: ['indigo', 'box'], release: ['indigo', 'box'], out: ['indigo', 'box'], target: ['indigo', 'box'],
  node_modules: ['green', 'hex'],
  '.git': ['red', 'branch'],
  '.github': ['grey', 'gear'],
  '.claude': ['orange', 'spark'],
  '.test-output': ['grey', 'list'], coverage: ['grey', 'list'],
};

export function folderIcon(name: string, open = false) {
  const [tone, mark] = folderToneMark[name.toLowerCase()] || ['slate', ''];
  // Marks are drawn around (8, 9.5) and enlarged a fifth about it (a thinner stroke keeps the line at about 1 unit).
  const glyph = mark ? <g className="fi-m fi-fm" transform={`translate(8 ${open ? 10.5 : 9.5}) scale(1.2) translate(-8 -9.5)`}>{marks[mark]}</g> : null;
  return open ? (
    <Svg tone={tone}>
      <path className="fi-back" d="M2 2h3l2 2h6a1 1 0 0 1 1 1v8H1V3a1 1 0 0 1 1-1z" />
      <path className="fi-t" d="M4 6h11l-3 8H1z" />
      <path className="fi-hl" d="M4 6h11l-.35 1H3.65z" />
      {glyph}
    </Svg>
  ) : (
    <Svg tone={tone}>
      <path className="fi-t" d="M2 2h3l2 2h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path className="fi-hl" d="M2 5h12v1H2z" />
      {glyph}
    </Svg>
  );
}

// File marks (bold, 1.5 units) fill the tile's body below the folded corner, centred on (8, 10).
const TS = (
  <>
    <path d="M4 7h4M6 7v6" /><path d="M12.5 7h-3v3h3v3h-3" />
  </>
);
const JS = (
  <>
    <path d="M7 7v6H4.5v-2" /><path d="M12.5 7h-3v3h3v3h-3" />
  </>
);
const fileMarks: Record<string, ReactNode> = {
  ts: <g className="fi-m">{TS}</g>,
  tsx: <g className="fi-m">{TS}</g>,
  js: <g className="fi-m">{JS}</g>,
  jsx: <g className="fi-m">{JS}</g>,
  json: <g className="fi-m"><path d="M6.5 7h-.5Q5 7 5 8v1.5q0 .5-1 .5 1 0 1 .5V12q0 1 1 1h.5M9.5 7h.5q1 0 1 1v1.5q0 .5 1 .5-1 0-1 .5V12q0 1-1 1h-.5" /></g>,
  md: <g className="fi-m"><path d="M4 13V7l2 3 2-3v6M11 7v6M9.5 11.5 11 13l1.5-1.5" /></g>,
  html: <g className="fi-m"><path d="M6.5 7l-3 3 3 3M9.5 7l3 3-3 3" /></g>,
  css: <g className="fi-m"><path d="M7 6.5 6 13.5M10.5 6.5l-1 7M4.5 8.5h7.5M4 11.5h7.5" /></g>,
  py: <g className="fi-m"><path d="M4 13V7h2.5a1.75 1.75 0 0 1 0 3.5H4" /><path className="fi-m2" d="M9 7l1.75 2.75L12.5 7M10.75 9.75V13" /></g>,
  shell: <g className="fi-m"><path d="M4 7.5l3 2.5-3 2.5M8.5 13h4" /></g>,
  image: <g className="fi-m"><path className="f" d="M3.5 13.5l3.5-5 2.5 3 1.5-1.5 3 3.5z" /><circle className="f" cx="10.5" cy="8" r="1.4" /></g>,
  video: <g className="fi-m"><path className="f" d="M6 7l6 3-6 3z" /></g>,
  gear: <g className="fi-m"><circle cx="8" cy="10" r="1.75" /><path d="M8 6v1.2M8 12.8V14M4 10h1.2M10.8 10H12M5.2 7.2l.9.9M10.8 7.2l-.9.9M5.2 12.8l.9-.9M10.8 12.8l-.9-.9" /></g>,
  lock: <g className="fi-m"><path d="M6 9V8a2 2 0 0 1 4 0v1" /><path className="f" d="M4 9h8v5H4z" /></g>,
  lines: <g className="fi-m"><path className="sq" d="M4.5 8h7M4.5 10.5h7M4.5 13h4.5" /></g>,
  key: <g className="fi-m"><circle cx="6" cy="10" r="2" /><path d="M8 10h4.5M10.5 10v2M12.5 10v1.5" /></g>,
  code: <g className="fi-m"><path d="M6 7.5 3.5 10 6 12.5M10 7.5l2.5 2.5-2.5 2.5M8.5 6.5l-1 7" /></g>,
};


function tile(tone: Tone, kind?: string) {
  return (
    <Svg tone={tone}>
      <path className="fi-t" d="M3 1h7l4 4v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" />
      <path className="fi-hl" d="M10 1l4 4h-3a1 1 0 0 1-1-1z" />
      {kind ? fileMarks[kind] : null}
    </Svg>
  );
}

const gitDiamond = (
  <Svg tone="red">
    <path className="fi-t fi-edge" d="M8 2l6 6-6 6-6-6z" />
    <g className="fi-m fi-thin" transform="translate(1.5 -.5)"><Branch /></g>
  </Svg>
);

const byExtension: Record<string, [Tone, string]> = {
  ts: ['blue', 'ts'], mts: ['blue', 'ts'], cts: ['blue', 'ts'], tsx: ['cyan', 'tsx'],
  js: ['yellow', 'js'], cjs: ['yellow', 'js'], mjs: ['yellow', 'js'], jsx: ['yellow', 'jsx'],
  json: ['yellow', 'json'], jsonc: ['yellow', 'json'], json5: ['yellow', 'json'],
  md: ['blue', 'md'], mdx: ['blue', 'md'], markdown: ['blue', 'md'],
  html: ['orange', 'html'], htm: ['orange', 'html'],
  css: ['indigo', 'css'], scss: ['indigo', 'css'], sass: ['indigo', 'css'], less: ['indigo', 'css'],
  py: ['blue', 'py'], pyw: ['blue', 'py'],
  ps1: ['dark', 'shell'], psm1: ['dark', 'shell'], sh: ['dark', 'shell'], bash: ['dark', 'shell'], zsh: ['dark', 'shell'], bat: ['dark', 'shell'], cmd: ['dark', 'shell'],
  png: ['green', 'image'], apng: ['green', 'image'], jpg: ['green', 'image'], jpeg: ['green', 'image'], jpe: ['green', 'image'], jfif: ['green', 'image'], gif: ['green', 'image'],
  webp: ['green', 'image'], bmp: ['green', 'image'], avif: ['green', 'image'], svg: ['green', 'image'], ico: ['green', 'image'],
  mp4: ['purple', 'video'], m4v: ['purple', 'video'], webm: ['purple', 'video'], ogv: ['purple', 'video'], ogg: ['purple', 'video'], mov: ['purple', 'video'], mkv: ['purple', 'video'], avi: ['purple', 'video'],
  yml: ['grey', 'gear'], yaml: ['grey', 'gear'], toml: ['grey', 'gear'], ini: ['grey', 'gear'], conf: ['grey', 'gear'], cfg: ['grey', 'gear'], env: ['grey', 'gear'],
  lock: ['grey', 'lock'],
  txt: ['grey', 'lines'], log: ['grey', 'lines'],
  rs: ['slate', 'code'], go: ['slate', 'code'], java: ['slate', 'code'], c: ['slate', 'code'], h: ['slate', 'code'], cpp: ['slate', 'code'], cs: ['slate', 'code'],
  rb: ['slate', 'code'], php: ['slate', 'code'], kt: ['slate', 'code'], swift: ['slate', 'code'], vue: ['slate', 'code'], svelte: ['slate', 'code'],
};

export function fileIcon(name: string) {
  const lower = name.toLowerCase();
  if (/^\.git(ignore|attributes|modules|keep)$/.test(lower)) return gitDiamond;
  if (/^(license|licence|copying|notice)(\.[a-z]+)?$/.test(lower)) return tile('yellow', 'key');
  if (/(^|[-.])lock(\.\w+)?$/.test(lower)) return tile('grey', 'lock');
  const match = lower.includes('.') ? byExtension[lower.slice(lower.lastIndexOf('.') + 1)] : undefined;
  if (match) return tile(match[0], match[1]);
  if (/^\.env|config/.test(lower)) return tile('grey', 'gear');
  return tile('page');
}
