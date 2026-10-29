import { PencilSimple } from '@phosphor-icons/react';
import type { SkillDetail, SkillInfo, SkillOptions } from '../../shared/types';
import { t } from '../../shared/i18n';
import { Select } from '../../shared/Select';
import { diffLines } from './skill-diff';
import { changeSummary, dependency, latestTwo, type ScopeOption, skillSummary, skillTitle, usedText } from './skill-text';

// text: the SKILL.md; diff: the latest two versions; pending: the text now against the change an agent proposed.
export type SkillTab = 'text' | 'diff' | 'pending';
export type SkillActions = {
  onOptions: (options: SkillOptions) => void; onScope: (value: string) => void; onEdit: () => void; onRevert: (version: number) => void;
  onResolve: (accept: boolean) => void; onTab: (tab: SkillTab) => void;
};

const SIGNS = { ctx: ' ', add: '+', del: '−', gap: '⋯' };

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
}

// The change between two texts as + and − lines.
function Changes({ heading, before, after }: { heading: string; before: string; after: string }) {
  const lines = diffLines(before, after);
  return <>
    <p className="skills-diff-meta">{heading}</p>
    <pre className="skills-reading skills-diff">{lines.some(line => line.kind !== 'ctx')
      ? lines.map((line, index) => <span key={index} className={`ln ${line.kind}`} data-diff={line.kind}><i>{SIGNS[line.kind]}</i>{line.text}</span>) : t('没有变化')}</pre>
  </>;
}

// The right side: one skill's switches, trigger, scope, version history, proof of use, and below them its SKILL.md or a change.
export function SkillDetailPane({ skill, detail, scopes, tab, now, actions }: {
  skill: SkillInfo; detail: SkillDetail | null; scopes: ScopeOption[]; tab: SkillTab; now: number; actions: SkillActions;
}) {
  const mine = skill.source === 'user', title = skillTitle(skill), summary = skillSummary(skill), needs = dependency(skill), pair = detail && latestTwo(detail.versions), proposal = detail?.pending ?? null;
  const changeTab = pair ? 'diff' : 'pending', hasChanges = !!pair || proposal !== null;
  const body = tab === 'pending' && proposal !== null ? <Changes heading={t('当前 → Agent 的提议')} before={detail!.text} after={proposal} />
    : tab !== 'text' && pair ? <Changes heading={`v${pair[0].version} → v${pair[1].version} · ${changeSummary(skill, now)}`} before={pair[0].text} after={pair[1].text} />
    : <pre className="skills-reading">{detail?.text ?? ''}</pre>;
  return <div className="skills-detail" data-skill-detail={skill.id}>
    <div className="skills-title"><b>{title}<em>{mine ? `v${skill.version}` : `v${skill.version} · ${t('随应用更新')}`}</em></b>
      <span className="skills-title-tools">
        {mine && <button type="button" className="button" data-skill-edit onClick={actions.onEdit}><PencilSimple size={16} />{t('编辑')}</button>}
        <Switch label={t('启用 {name}', { name: title })} checked={skill.enabled} onChange={enabled => actions.onOptions({ enabled })} />
      </span></div>
    <p className="skills-desc skills-summary" title={summary}>{summary}</p>
    {skill.createdByAgent && <p className="skills-desc"><span className="skills-new-note">{t('新 · 由 Agent 创建，看一眼再决定留不留。')}</span>
      <button type="button" className="text-button" data-skill-keep onClick={() => actions.onResolve(true)}>{t('确认保留')}</button></p>}
    <dl className="skills-facts">
      {skill.pending && <div><dt>{t('Agent 提议了修改')}</dt><dd>
        <button type="button" className="text-button" data-skill-view onClick={() => actions.onTab('pending')}>{t('查看')}</button>
        <button type="button" className="text-button" data-skill-accept onClick={() => actions.onResolve(true)}>{t('采用')}</button>
        <button type="button" className="text-button" data-skill-discard onClick={() => actions.onResolve(false)}>{t('放弃')}</button></dd></div>}
      <div className={mine ? 'skills-facts-pair' : undefined}>
        <dt>{t('触发')}</dt><dd><Select label={t('触发')} className="skills-trigger" value={skill.trigger} onChange={value => actions.onOptions({ trigger: value as SkillInfo['trigger'] })}
          options={[{ value: 'always', label: t('始终 · 每个任务开始前') }, { value: 'auto', label: t('按需 · 描述匹配时') }]} /></dd>
        {mine && <><dt>{t('范围')}</dt><dd><Select label={t('范围')} className="skills-scope" value={skill.scope === 'project' && skill.projectId ? skill.projectId : 'global'} options={scopes} onChange={actions.onScope} /></dd></>}
      </div>
      {needs && <div><dt>{t('依赖')}</dt><dd className="skills-dependency"><i className={`skills-dot${needs.hollow ? ' is-hollow' : ''}`} aria-hidden="true" />{needs.text}</dd></div>}
      {mine && <>
        <div><dt><span>{t('允许 Agent 自动优化')}<small>{t('默认开启：Agent 发现更好的做法时更新这个技能')}</small></span></dt>
          <dd><Switch label={t('允许 Agent 自动优化')} checked={skill.autoOptimize} onChange={autoOptimize => actions.onOptions({ autoOptimize })} /></dd></div>
        <div><dt><span>{t('需要我确认后再生效')}<small>{t('开启后，Agent 的优化先放在一边，由你看过再采用')}</small></span></dt>
          <dd><Switch label={t('需要我确认后再生效')} checked={skill.confirmChanges} disabled={!skill.autoOptimize} onChange={confirmChanges => actions.onOptions({ confirmChanges })} /></dd></div>
        <div><dt>{t('版本')}</dt><dd><span className="skills-version">{`v${skill.version} · ${changeSummary(skill, now)}`}</span>
          {pair && <><button type="button" className="text-button" data-skill-changes onClick={() => actions.onTab('diff')}>{t('查看变更')}</button>
            <button type="button" className="text-button" data-skill-revert onClick={() => actions.onRevert(pair[0].version)}>{t('回退到 v{n}', { n: pair[0].version })}</button></>}</dd></div>
      </>}
      <div><dt>{t('生效证据')}</dt><dd className={skill.lastUsed ? undefined : 'is-quiet'} data-skill-used>{usedText(skill.lastUsed)}</dd></div>
    </dl>
    <div className="skills-tabs">
      <button type="button" aria-pressed={tab === 'text' || !hasChanges} onClick={() => actions.onTab('text')}>SKILL.md</button>
      {hasChanges && <button type="button" aria-pressed={tab !== 'text'} onClick={() => actions.onTab(changeTab)}>{t('变更')}</button>}
      {!mine && <span className="skills-tab-note">{t('系统自带 · 只读')}</span>}
    </div>
    {body}
  </div>;
}
