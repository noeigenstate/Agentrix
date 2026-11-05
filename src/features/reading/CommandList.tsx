import { t } from '../../shared/i18n';
import type { useCommandPalette } from './useCommandPalette';
import type { useMentions } from './useMentions';

type Palette = ReturnType<typeof useCommandPalette>;

// The command list is part of the page, above the message box, not a popup over the conversation. A plain function, so the list's own markup is
// what a parent renders.
export function commandList(palette: Palette) {
  if (!palette.open) return null;
  return <div className="reading-commands is-inline" id={palette.listId} role="listbox" aria-label={t('命令')}>{palette.matches.map((command, index) => <div key={command.name} id={palette.optionId(index)} role="option" aria-selected={palette.selection === index} className="reading-command" onMouseDown={event => event.preventDefault()} onClick={() => palette.complete(command)}>
    <code>{command.name}</code><span>{command.source === 'builtin' ? t(command.description) : command.description}</span>{command.source !== 'builtin' && <small>{command.source === 'project' ? t('项目') : command.source === 'user' ? t('用户') : t('技能')}</small>}
  </div>)}</div>;
}

// What the message box says about the list or the file list that is open over it, for assistive technology.
export function composerAria(palette: Palette, mentions: ReturnType<typeof useMentions>) {
  const file = mentions.open ? mentions.files[mentions.selection] : undefined;
  return {
    'aria-expanded': palette.open || mentions.open,
    'aria-controls': palette.open ? palette.listId : mentions.open ? mentions.listId : undefined,
    'aria-activedescendant': palette.open && palette.selected ? palette.optionId(palette.selection) : file ? mentions.optionId(mentions.selection) : undefined,
  };
}
