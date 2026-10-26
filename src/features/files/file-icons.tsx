import {
  BracketsCurly, File as FilePlain, FileCode, FileCss, FileHtml, FileImage, FileJs, FileJsx, FilePy, FileText, FileTs, FileTsx, FileVideo,
  Folder, FolderOpen, GitBranch, Key, Terminal, type Icon,
} from '@phosphor-icons/react';
import './file-icons.css';

// The file-tree icons are Phosphor outlines, the weight of the app's own icons. Every folder is one slate outline (open
// when expanded); a file is a neutral outline, tinted only for the few types that carry meaning. Tones are tokens in
// file-icons.css; an icon without a tone takes the explorer's secondary grey.

type Tone = 'slate' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'purple';
type Glyph = [Icon, Tone?];

const draw = ([Shape, tone]: Glyph) => <Shape className="file-icon" size={16} aria-hidden="true" style={tone && { color: `var(--fi-${tone})` }} />;

export const folderIcon = (open: boolean) => draw([open ? FolderOpen : Folder, 'slate']);

// Generated or vendored folders are dimmed by the explorer row (icon and name).
export const isGeneratedFolder = (name: string) => /^(node_modules|dist|build|out|release|coverage|\.test-output)$/i.test(name);

const config: Glyph = [BracketsCurly, 'yellow'];
const code: Glyph = [FileCode];

const kinds: [string, Glyph][] = [
  ['ts mts cts', [FileTs, 'blue']], ['tsx', [FileTsx, 'blue']],
  ['js cjs mjs', [FileJs, 'yellow']], ['jsx', [FileJsx, 'yellow']],
  ['json jsonc json5 yml yaml toml ini conf cfg env', config],
  ['md mdx markdown', [FileText, 'blue']],
  ['html htm', [FileHtml, 'orange']],
  ['css scss sass less', [FileCss, 'purple']],
  ['py pyw', [FilePy, 'blue']],
  ['ps1 psm1 sh bash zsh bat cmd', [Terminal, 'green']],
  ['png apng jpg jpeg jpe jfif gif webp bmp avif svg ico', [FileImage, 'green']],
  ['mp4 m4v webm ogv ogg mov mkv avi', [FileVideo, 'purple']],
  ['txt log', [FileText]],
  ['rs go java c h cpp cs rb php kt swift vue svelte', code],
];
const byExtension = new Map(kinds.flatMap(([extensions, glyph]) => extensions.split(' ').map(extension => [extension, glyph] as const)));

export function fileIcon(name: string) {
  const lower = name.toLowerCase();
  if (/^\.git(ignore|attributes|modules|keep)$/.test(lower)) return draw([GitBranch, 'red']);
  if (/^(license|licence|copying|notice)(\.[a-z]+)?$/.test(lower)) return draw([Key]);
  if (/(^|[-.])lock(\.\w+)?$/.test(lower)) return draw(code);
  const glyph = lower.includes('.') ? byExtension.get(lower.slice(lower.lastIndexOf('.') + 1)) : undefined;
  if (glyph) return draw(glyph);
  return draw(/^\.env|config/.test(lower) ? config : [FilePlain]);
}
