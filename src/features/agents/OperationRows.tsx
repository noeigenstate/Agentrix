import { BookOpen, CaretDown, Clock, LockSimple, MagnifyingGlass, Prohibit, Robot, ShieldCheck } from '@phosphor-icons/react';
import type { OperationAgentState, OperationId, OperationMap, OperationRow, OperationValue, SeatModel, SeatsInfo } from '../../shared/types';
import { currentLanguage, t } from '../../shared/i18n';
import { familyOf, isAvailable, operationUsesEffort, rowFor, sameOperation } from './skill-seats';

const ICONS = { lookup: MagnifyingGlass, background: Clock, subagent: Robot, memory: BookOpen, review: ShieldCheck };
const AGENTS = { claude: 'Claude', codex: 'Codex' } as const;
const STATES = { applies: '有效', default: '默认', 'not-applicable': '不适用', 'not-effective': '未生效' };
type OperationStatus = { state: OperationAgentState['state'] | 'default'; reason?: string };
type Editable = OperationRow & { id: OperationId };
type Control = 'model' | 'effort' | keyof typeof AGENTS;

export const editableOperation = (row: OperationRow): row is Editable => row.editable && row.id !== 'compaction' && row.id !== 'titles';
export const operationName = (row: OperationRow) => currentLanguage() === 'en' ? row.nameEn : row.name;

const OPERATION_WORDS: Record<string, string> = {
  'Searching, listing and reading files, log excerpts': '检索、列出和读取文件、摘录日志',
  "Claude Code's light background calls, including titles and web-page summaries": 'Claude Code 的轻量后台调用，包括标题和网页摘要',
  'Sub-agents started without an explicit model': '启动时没有明确指定模型的子代理',
  'Extracting and consolidating memories': '提取和整理记忆',
  "Codex's built-in review (/review, review/start)": 'Codex 内置审查（/review、review/start）',
  'follows the conversation': '跟随对话',
  'Reviewer seat': '跟随审查席位',
  'Claude Code is not installed.': '未安装 Claude Code。',
  'Codex is not installed.': '未安装 Codex。',
  'No concrete Haiku version is listed.': '模型列表没有具体的 Haiku 版本。',
  'No concrete sonnet version is listed.': '模型列表没有具体的 Sonnet 版本。',
  'No concrete opus version is listed.': '模型列表没有具体的 Opus 版本。',
  'Unknown operation.': '未知操作。',
  'This operation requires a model.': '此操作需要指定模型。',
  'This operation requires a Claude model.': '此操作只能用 Claude 模型',
  'This operation requires a Codex model.': '此操作只能用 Codex 模型',
  'Expected a valid model id of at most 160 characters and an optional effort.': '请输入不超过 160 个字符的有效模型名，可选填强度。',
  'Choose a reviewer different from developer when another available model is at least as strong.': '有不弱于开发模型的可用模型时，请为审查选择不同的模型。',
};
const OPERATION_NOTES: Record<string, string> = {
  'explore-follows-background': 'Claude Code 内置的 Explore 代理也使用此设置。',
  'codex-memories-enabled': '开启 Codex 记忆功能时生效。',
  'built-in-compaction': '不可控，由 Claude Code / Codex 内置决定',
  'titles-follow-background': 'Claude 标题随后台小任务一起变化。',
};

function operationNote(id: string | undefined) {
  return id && Object.hasOwn(OPERATION_NOTES, id) ? t(OPERATION_NOTES[id]) : null;
}

export function operationWords(text: string) {
  if (currentLanguage() === 'en') return t(text);
  return Object.hasOwn(OPERATION_WORDS, text) ? OPERATION_WORDS[text] : text;
}

export function operationLabel(row: OperationRow, value: OperationValue | undefined, label: (model: string) => string) {
  if (value === 'follow') return row.id === 'memory' ? t('Codex 默认') : operationWords(row.follow ?? 'follows the conversation');
  return value ? label(value.model) : t('未设置');
}

function Status({ family, value, expanded, onOpen }: {
  family: keyof typeof AGENTS; value: OperationStatus; expanded?: boolean; onOpen?: (button: HTMLButtonElement) => void;
}) {
  const title = [AGENTS[family], t(STATES[value.state])].join(' · ');
  const dot = <i className="seats-mk" data-family={family} aria-hidden="true" />;
  return value.state === 'not-effective' && onOpen
    ? <button type="button" className="seats-op-chip" data-op-state={value.state} data-agent={family} aria-expanded={expanded}
      title={value.reason && operationWords(value.reason)} onClick={event => onOpen(event.currentTarget)}>{dot}{title} <b aria-hidden="true">!</b></button>
    : <span className="seats-op-chip" data-op-state={value.state} data-agent={family} title={value.reason && operationWords(value.reason)}>{dot}{title}</span>;
}

function previewState(row: Editable, family: keyof typeof AGENTS, selected: keyof typeof AGENTS | undefined): OperationStatus {
  if (!row.families.includes(family) || selected && selected !== family) return { state: 'not-applicable' };
  if (!selected) return { state: 'default' };
  return { state: 'applies', reason: t('保存后检查是否生效') };
}

type OperationRowsProps = {
  info: NonNullable<SeatsInfo['operations']>;
  values: OperationMap;
  baseline: OperationMap;
  catalog: SeatModel[];
  label: (model: string) => string;
  reviewerModel?: string;
  reviewBlocked: boolean;
  over?: OperationId;
  control?: { id: OperationId; kind: Control };
  open: (id: OperationId, button: HTMLElement, kind: Control) => void;
  select: (id: OperationId, model: string) => void;
};

function OperationTitle({ row, changed }: { row: OperationRow; changed?: boolean }) {
  const Icon = editableOperation(row) ? ICONS[row.id] : LockSimple;
  return <div className="seats-op-name">
    <span className="seats-role-icon"><Icon size={18} aria-hidden="true" /></span>
    <div><h3>{operationName(row)}</h3>{currentLanguage() === 'zh' && <span lang="en">{row.nameEn}</span>}</div>
    {changed && <span className="seats-chg">{t('已改')}</span>}
  </div>;
}

function OperationCard(props: OperationRowsProps & { row: Editable }) {
  const { row, info, values, baseline, catalog, label, reviewerModel, reviewBlocked, over, control, open, select } = props;
  const { id } = row, value = values[id];
  const followReviewer = id === 'review' && value === 'follow';
  const model = value === 'follow' ? followReviewer && reviewerModel && familyOf(reviewerModel) === 'codex' ? reviewerModel : undefined : value?.model;
  const family = model ? rowFor(catalog, model)?.family ?? familyOf(model) : undefined;
  const name = operationName(row), changed = !sameOperation(value, baseline[id]);
  const expanded = (kind: Control) => control?.id === id && control.kind === kind;
  const reported = sameOperation(value, info.effective[id]) && (!followReviewer || model === row.effective?.model);
  const suggestion = id === 'memory' && row.suggestion !== model && row.suggestion && isAvailable(catalog, row.suggestion) ? row.suggestion : null;
  const blocked = id === 'review' && reviewBlocked, note = operationNote(row.note);
  const nextLaunch = info.pending.includes(id);
  return <article className={`seats-op-card${over === id ? ' is-over' : ''}${blocked ? ' is-blocked' : ''}`} data-operation={id} data-op-slot={id} aria-label={name}>
    <OperationTitle row={row} changed={changed} />
    <div className="seats-op-info">
      <p className="seats-op-covers">{operationWords(row.covers)}</p>
      {followReviewer && <p className="seats-op-note">{model ? label(model) : t('Codex 默认')}</p>}
      <div className="seats-op-status">
        {blocked ? <span className="seats-state is-bad" data-op-blocked><Prohibit size={14} aria-hidden="true" />{t('已阻止 · 同模型')}</span>
          : (Object.keys(AGENTS) as (keyof typeof AGENTS)[]).map(agent =>
          <Status key={agent} family={agent} value={reported ? row.agents[agent] : previewState(row, agent, family)}
            expanded={expanded(agent)} onOpen={button => open(id, button, agent)} />)}
        {!blocked && !reported && <span className="seats-op-note">{t('保存后检查是否生效')}</span>}
      </div>
      {note && <p className="seats-op-note">{note}</p>}
      {nextLaunch && <p className="seats-op-note">{t('下次启动生效')}</p>}
    </div>
    <div className="seats-op-settings">
      <button type="button" className="seats-gem" data-op-model={id} aria-haspopup="menu" aria-expanded={expanded('model')}
        title={model} aria-label={t('{seat}：选择模型', { seat: name })} onClick={event => open(id, event.currentTarget, 'model')}>
        <i className="seats-mk" data-family={family ?? 'none'} aria-hidden="true" />
        <span className="seats-gem-name">{operationLabel(row, value, label)}</span><CaretDown size={14} aria-hidden="true" />
      </button>
      {value && value !== 'follow' && family && operationUsesEffort(row, family) && <button type="button" className="seats-btn seats-effort"
        data-op-effort={id} aria-haspopup="menu" aria-expanded={expanded('effort')} aria-label={t('{seat}：选择强度', { seat: name })}
        onClick={event => open(id, event.currentTarget, 'effort')}>{value.effort ?? '—'}<CaretDown size={12} aria-hidden="true" /></button>}
      {suggestion && <button type="button" className="seats-btn is-small" data-op-suggestion={suggestion}
        onClick={() => select(id, suggestion)}>{t('使用建议模型 {model}', { model: label(suggestion) })}</button>}
    </div>
  </article>;
}

export function OperationRows(props: OperationRowsProps) {
  return <div className="seats-operations" id="seats-operations-panel" role="tabpanel" aria-labelledby="seats-operations-tab">
    {props.info.rows.map(row => {
      if (editableOperation(row)) return <OperationCard key={row.id} row={row} {...props} />;
      const note = operationNote(row.note);
      return <article key={row.id} className="seats-op-card is-readonly" data-operation={row.id}>
        <OperationTitle row={row} />
        <div className="seats-op-info">
          <p>{row.id === 'compaction' && note ? note : t('不可控，由 Claude Code / Codex 内置决定')}</p>
          {row.id === 'titles' && note && <p className="seats-op-note">{note}</p>}
        </div>
      </article>;
    })}
  </div>;
}

export function CurrentOperations({ info, label }: { info: SeatsInfo['operations']; label: OperationRowsProps['label'] }) {
  const current = info?.current;
  if (!current) return null;
  return <div className="seats-now-operations">
    <b>{t('操作模型')}</b>
    <div className="seats-nows">{info.rows.filter(editableOperation).map(row => {
      const value = current.values[row.id], agents = current.agents[row.id], saved = info.effective[row.id];
      const setting = (choice: OperationValue | undefined) =>
        [operationLabel(row, choice, label), choice !== 'follow' && choice?.effort].filter(Boolean).join(' · ');
      return <div key={row.id} className="seats-now-op" data-now-operation={row.id}>
        <span className="seats-now"><b>{operationName(row)}</b>{setting(value)}</span>
        {agents && <><Status family="claude" value={agents.claude} /><Status family="codex" value={agents.codex} /></>}
        {info.pending.includes(row.id) &&
          <span className="seats-now-restart">{t('下次启动生效：{settings}', { settings: setting(saved) })}</span>}
      </div>;
    })}</div>
  </div>;
}
