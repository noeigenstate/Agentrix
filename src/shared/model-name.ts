import type { AgentProvider } from './agent-events';
import { adapterOfModel, adapters, canonicalModelId, localModel } from '../../electron/features/cli-adapters/registry.mjs';

// A model named the way its CLI prints it: claude-opus-5-5 → Opus 5.5, gpt-6.1-sol → GPT-6.1-Sol. A name Claude Code
// printed itself after /model ("Opus 5.5") and anything unknown stay as they are.
export function modelName(model: string) {
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[\w+\])?$/i.exec(model);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1).toLowerCase()} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  if (/^gpt-/i.test(model)) return model.split('-').map(part => /^gpt$/i.test(part) ? 'GPT' : /^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1)).join('-');
  return canonicalModelId(model);
}

type ListedModel = { model: string; label: string; family: AgentProvider; listed?: boolean };
const release = (model: string) => (model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '').match(/\d+/g) ?? []).map(Number);
const newer = (a: number[], b: number[]) => { for (let at = 0; at < Math.max(a.length, b.length); at++) if ((a[at] ?? 0) !== (b[at] ?? 0)) return (a[at] ?? 0) > (b[at] ?? 0); return false; };
// The model an alias runs today: the newest listed release of its line ("opus" is claude-opus-5-5). Null when none is listed.
export function aliasTarget(catalog: readonly ListedModel[], model: string): string | null {
  const alias = localModel(model);
  if (!/^[a-z]+$/.test(alias)) return null;
  const releases = adapters().flatMap(({ manifest: { id, models: { aliases, prefix } } }) => {
    if (!aliases.length || model !== prefix + alias) return [];
    const stem = `${prefix || id + '-'}${alias}-`;
    return catalog.filter(row => row.family === id && row.listed !== false && row.model.startsWith(stem) && release(row.model).length);
  });
  return releases.reduce<ListedModel | null>((best, row) => !best || newer(release(row.model), release(best.model)) ? row : best, null)?.model ?? null;
}
// What a person reads for a model: a Claude model by its release ("Opus 5.5"), an alias by the release it runs, Codex by its listed name.
export function modelLabel(catalog: readonly ListedModel[], model: string, providerGrouped = false): string {
  if (adapterOfModel(model).manifest.models.prefix) {
    return providerGrouped ? localModel(model) : canonicalModelId(model);
  }
  const id = aliasTarget(catalog, model) ?? model;
  // The 1M-context variant of a release is its own row.
  if (/^claude-/.test(id)) { const name = modelName(id); if (name !== id) return /\[1m\]$/i.test(id) ? `${name} (1M)` : name; }
  if (/^[a-z]+$/.test(id)) return id[0].toUpperCase() + id.slice(1);
  return catalog.find(row => row.model === id)?.label.replace(/\s*\(follows latest\)$/i, ' (latest)') ?? id;
}
