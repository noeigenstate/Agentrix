const blocked = new Set(['commit', 'push', 'restore', 'clean', 'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'update-ref', 'tag', 'switch', 'checkout']);
const gitOptionsWithValue = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);
const shellCommandOption = {
  cmd: /^\/[ck]$/i, powershell: /^-(?:c|command)$/i, pwsh: /^-(?:c|command)$/i,
  bash: /^-[il]*c$/, sh: /^-[il]*c$/, dash: /^-[il]*c$/, zsh: /^-[il]*c$/, ksh: /^-[il]*c$/,
};
const commandName = value => value?.split(/[\\/]/).at(-1).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
const continuedLine = /(?:\\|`|\^)\r?\n/g;

// Keep quoted words together and retain the original argument text for shell wrappers.
// This recognizes explicit invocations without interpreting variables, aliases or scripts.
const quote = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(?:`|\^)(.)|\\([ \t'"\\;&|()])/g;
const token = /(?<word>(?:'[^']*'|"(?:[^"\\]|\\.)*"|(?:`|\^)[^\r\n]|\\[ \t'"\\;&|()]|[^\s;&|()'"])+)|(?<separator>[\r\n;&|()])/g;
const unquote = raw => raw.replace(quote, (_match, single, double, escaped, backslash) => single
  ?? double?.replace(/\\(["\\])|`([^\r\n])/g, (_escape, slashChar, tickChar) => slashChar ?? tickChar) ?? escaped ?? backslash);

function gitMutation(args) {
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const option = args[index++].toLowerCase();
    if (gitOptionsWithValue.has(option)) index++;
  }
  const subcommand = args[index++]?.toLowerCase();
  if (blocked.has(subcommand)) return true;
  if (subcommand !== 'reset' && subcommand !== 'branch') return false;
  const pathspec = args.indexOf('--', index);
  const options = args.slice(index, pathspec === -1 ? undefined : pathspec);
  if (subcommand === 'reset') return options.some(arg => /^--hard$/i.test(arg));
  return options.some(arg =>
    /^--(?:force|delete|move|copy)(?:=|$)|^-[a-z]*[fdmc]/i.test(arg));
}

function commandMutation(command, words, depth) {
  let index = 0;
  while (/^[\w]+=.*/.test(words[index]?.value) || ['command', 'exec'].includes(words[index]?.value)) index++;
  const program = commandName(words[index]?.value);
  const args = words.slice(index + 1);
  if (program === 'git') return gitMutation(args.map(word => word.value));
  const shellOption = Object.hasOwn(shellCommandOption, program) && shellCommandOption[program];
  if (!shellOption || depth >= 8) return false;
  const scriptIndex = args.findIndex(word => shellOption.test(word.value)) + 1;
  if (!scriptIndex || !args[scriptIndex]) return false;
  const script = args[scriptIndex];
  const quoted = script.raw.startsWith('"') || script.raw.startsWith("'");
  if (quoted && program !== 'cmd') return gitMutationInCommand(script.value, depth + 1);
  const raw = command.slice(script.index, args.at(-1).index + args.at(-1).raw.length);
  if (program === 'cmd' && raw.startsWith('""') && raw.endsWith('"')) return gitMutationInCommand(raw.slice(1, -1), depth + 1);
  if (!['cmd', 'powershell', 'pwsh'].includes(program)) return gitMutationInCommand(script.value, depth + 1);
  return gitMutationInCommand(quoted && args.length === scriptIndex + 1 ? script.value : raw, depth + 1);
}

function gitMutationInCommand(input, depth = 0) {
  const command = input.replace(continuedLine, '');
  let words = [];
  for (const { 0: raw, index, groups } of command.matchAll(token)) {
    if (groups.word) {
      words.push({ value: unquote(raw), raw, index });
    } else if (groups.separator === '&' && !words.length) {
      continue; // PowerShell's call operator.
    } else {
      if (words.length && commandMutation(command, words, depth)) return true;
      words = [];
    }
  }
  return words.length > 0 && commandMutation(command, words, depth);
}

module.exports = { gitMutationInCommand };
