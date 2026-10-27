import en from '../../electron/locales/en.json';
import type { Settings } from './types';

// Interface text is written in Chinese in the source; English mode looks each phrase up in the
// dictionary shared with the main process (electron/locales/en.json). A missing entry stays Chinese.
// Entries may hold {name} placeholders, filled after the lookup. A finished message built elsewhere
// (an error, progress or status text from the main process) is also matched against those templates.
const dictionary: Record<string, string> = en;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
const patterns = Object.keys(dictionary).filter(key => /\{\w+\}/.test(key)).map(key => {
  const names: string[] = [];
  const source = key.split(/(\{\w+\})/).map(part => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(name); return '([\\s\\S]*?)';
  }).join('');
  return { regex: new RegExp(`^${source}$`), names, template: dictionary[key] };
});

// The loading screen renders before settings arrive; index.html also starts with lang="en".
let language: Settings['language'] = 'en';

// Called while App renders, before its children, so the whole tree renders in one language.
export function applyLanguage(preference?: Settings['language']) {
  const next = preference === 'zh' ? 'zh' : 'en';
  if (next === language) return;
  language = next;
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
}

export function currentLanguage() { return language; }

export function t(text: string, values?: Record<string, string | number>): string {
  if (language !== 'en') return values ? fill(text, values) : text;
  if (Object.prototype.hasOwnProperty.call(dictionary, text)) text = dictionary[text];
  else if (!values) {
    for (const { regex, names, template } of patterns) {
      const match = regex.exec(text);
      if (match) return fill(template, Object.fromEntries(names.map((name, index) => [name, t(match[index + 1])])));
    }
  }
  return values ? fill(text, values) : text;
}

