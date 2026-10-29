// A model named the way its CLI prints it: claude-opus-5-5 → Opus 5.5, gpt-6.1-sol → GPT-6.1-Sol. A name Claude Code
// printed itself after /model ("Opus 5.5") and anything unknown stay as they are.
export function modelName(model: string) {
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[\w+\])?$/i.exec(model);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1).toLowerCase()} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  if (/^gpt-/i.test(model)) return model.split('-').map(part => /^gpt$/i.test(part) ? 'GPT' : /^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1)).join('-');
  return model;
}
