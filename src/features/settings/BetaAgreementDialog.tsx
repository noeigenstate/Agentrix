import { useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';
import { BETA_AGREEMENT_VERSION, betaAgreementClauses } from './beta-agreement';

// The modal the beta channel waits behind. The parent calls the switch from onAgree and closes this on success; a refusal comes back as `error` and the dialog stays.
export function BetaAgreementDialog({ busy, error, onAgree, onCancel }: { busy: boolean; error: string; onAgree: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="settings-dialog beta-agreement-dialog" ref={dialog} aria-labelledby="beta-agreement-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form className="dialog-content" onSubmit={event => { event.preventDefault(); if (checked && !busy) onAgree(); }}>
      <div className="dialog-heading"><h2 id="beta-agreement-title">{t('测试协议')}</h2></div>
      <p className="beta-agreement-version">{t('协议版本 {version}', { version: BETA_AGREEMENT_VERSION })}</p>
      <div className="beta-agreement-text" role="region" aria-label={t('测试协议')} tabIndex={0}>
        <ol>{betaAgreementClauses().map(clause => <li key={clause}>{clause}</li>)}</ol>
      </div>
      <label className="beta-agreement-check"><input type="checkbox" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} />{t('我已阅读并同意测试协议')}</label>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="beta-agreement-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>{t('取消')}</button>
        <button className="button primary" disabled={!checked || busy}>{t('同意并切换')}</button>
      </div>
    </form>
  </dialog>;
}
