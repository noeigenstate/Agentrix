import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowSquareOut, Copy, SignIn } from '@phosphor-icons/react';
import type { SignInScreen } from '../cli-screens/index.ts';
import { t } from '../../shared/i18n';
import type { AgentProvider } from '../../shared/agent-events';
import { adapterOf } from '../../../electron/features/cli-adapters/registry.mjs';
import './reading-cli.css';

// The CLI signing in, as a popup over the reading view: what it says, its sign-in page to open in the browser (a click
// of the reader's; the CLI could not open one itself), a one-time code to copy, a field for what the browser gave back,
// and the keys it waits for. It stays until the CLI moves on; nothing is answered for the reader.
export function ReadingSignIn({ agent, screen, terminalId, projectId, onError }: {
  agent: AgentProvider; screen: SignInScreen; terminalId: string; projectId: string; onError: (message: string) => void;
}) {
  const [value, setValue] = useState(''), [copied, setCopied] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { (field.current ?? card.current)?.focus({ preventScroll: true }); }, [screen.input]);
  // Answers to the CLI itself, never a prompt of the conversation (nothing is queued, the code is shown nowhere).
  const write = (keys: string) => window.agentrix.answerTerminal(terminalId, keys);
  const copy = (text: string, what: string) => void window.agentrix.copy(text).then(result => {
    if (!result.ok) { onError(result.error); return; }
    setCopied(what); setTimeout(() => setCopied(current => current === what ? null : current), 1600);
  });
  const open = (url: string) => void window.agentrix.openLink(projectId, url).then(result => { if (!result.ok) onError(result.error); });
  // What the browser gave back goes into the CLI's own field, then Enter; the field here is cleared for a retry.
  const submit = () => { const text = value.trim(); if (!text) return; write(text); setTimeout(() => write('\r'), 60); setValue(''); };
  const name = adapterOf(agent)!.manifest.label;
  return <div className="reading-cli-overlay reading-sign-in-overlay">
    <div ref={card} className="reading-cli-panel reading-sign-in" role="dialog" aria-modal="true" aria-label={t('登录 {name}', { name })} tabIndex={-1}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && screen.cancel) { event.preventDefault(); write('\x1b'); }
        // Enter on a focused button (Cancel) presses that button, not the CLI's Enter.
        else if (event.key === 'Enter' && !screen.input && screen.enter && !(event.target as HTMLElement | null)?.closest?.('button')) { event.preventDefault(); write('\r'); }
      }}>
      <div className="reading-cli-head"><strong><SignIn size={14} />{t('登录 {name}', { name })}</strong></div>
      <div className="reading-cli-body reading-sign-in-body">
        {screen.lines.map((line, index) => <p key={index}>{line}</p>)}
        {screen.url && <div className="reading-sign-in-link">
          <button type="button" className="button primary" onClick={() => open(screen.url!)}><ArrowSquareOut size={15} />{t('在浏览器中打开登录页面')}</button>
          <button type="button" className="button secondary" onClick={() => copy(screen.url!, 'url')}><Copy size={15} />{copied === 'url' ? t('已复制') : t('复制链接')}</button>
        </div>}
        {screen.code && <div className="reading-sign-in-code"><code>{screen.code}</code>
          <button type="button" className="button secondary small" onClick={() => copy(screen.code!, 'code')}><Copy size={13} />{copied === 'code' ? t('已复制') : t('复制验证码')}</button></div>}
        {screen.input && <form className="reading-sign-in-field" onSubmit={event => { event.preventDefault(); submit(); }}>
          <input ref={field} type={screen.input === 'key' ? 'password' : 'text'} value={value} onChange={event => setValue(event.target.value)} spellCheck={false} autoComplete="off"
            placeholder={screen.input === 'key' ? t('粘贴你的 OpenAI API Key') : t('在浏览器里登录后，把页面给出的授权码粘贴到这里')} aria-label={screen.input === 'key' ? t('API Key') : t('授权码')} />
          <button type="submit" className="button primary" disabled={!value.trim()}>{t('提交')}</button>
        </form>}
        {(screen.enter || screen.cancel) && <div className="reading-sign-in-actions">
          {screen.cancel && <button type="button" className="button secondary" onClick={() => write('\x1b')}>{t('取消')}</button>}
          {screen.enter && <button type="button" className="button primary" onClick={() => write('\r')}>{t('继续')}</button>}
        </div>}
      </div>
    </div>
  </div>;
}
