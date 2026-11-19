import { BookOpen, CaretDown, Clock, LockSimple, MagnifyingGlass, Robot, ShieldCheck } from '@phosphor-icons/react';
import type { OperationAgentState, OperationId, OperationMap, OperationRow, OperationValue, SeatModel, SeatsInfo } from '../../shared/types';
import { currentLanguage, t } from '../../shared/i18n';
import { familyOf, operationUsesEffort, rowFor, sameOperation } from './skill-seats';

const ICONS = { lookup: MagnifyingGlass, background: Clock, subagent: Robot, memory: BookOpen, review: ShieldCheck };
const AGENTS = { claude: 'Claude', codex: 'Codex' } as const;
const STATES = { applies: '有效', 'not-applicable': '不适用', 'not-effective': '未生效' };
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
  'This setting applies when Codex memories are enabled.': '开启 Codex 记忆功能时生效。',
  'Built into Claude Code and Codex.': '由 Claude Code 和 Codex 内置决定。',
  'Built in. Claude titles move with the background helpers.': '由程序内置决定。Claude 标题随后台小任务一起变化。',
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
export function operationWords(text: string) {
  if (currentLanguage() === 'en') return t(text);
  return Object.hasOwn(OPERATION_WORDS, text) ? OPERATION_WORDS[text] : text;
}

export function operationLabel(row: OperationRow, value: OperationValue | undefined, label: (model: string) => string) {
  if (value === 'follow') return row.id === 'memory' ? t('Codex 默认') : operationWords(row.follow ?? 'follows the conversation');
  return value ? label(value.model) : t('未设置');
}

function Status({ family, value, expanded, onOpen }: {
  family: keyof typeof AGENTS; value: OperationAgentState; expanded?: boolean; onOpen?: (button: HTMLButtonElement) => void;
}) {
  const title = [AGENTS[family], t(STATES[value.state])].join(' · ');
  const dot = <i className="seats-mk" data-family={family} aria-hidden="true" />;
  return value.state === 'not-effective' && onOpen
    ? <button type="button" className="seats-op-chip" data-op-state={value.state} data-agent={family} aria-expanded={expanded}
      title={value.reason && operationWords(value.reason)} onClick={event => onOpen(event.currentTarget)}>{dot}{title} <b aria-hidden="true">!</b></button>
    : <span className="seats-op-chip" data-op-state={value.state} data-agent={family} title={value.reason && operationWords(value.reason)}>{dot}{title}</span>;
}

function previewState(row: Editable, family: keyof typeof AGENTS, selected: keyof typeof AGENTS | undefined): OperationAgentState {
  if (!row.families.includes(family) || selected && selected !== family) return { state: 'not-applicable' };
  return { state: 'applies', reason: t('保存后检查是否生效') };
}

type OperationRowsProps = {
  info: NonNullable<SeatsInfo['operations']>;
  values: OperationMap;
  baseline: OperationMap;
  catalog: SeatModel[];
  label: (model: string) => string;
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

function OperationCard({ row, info, values, baseline, catalog, label, over, control, open, select }: OperationRowsProps & { row: Editable }) {
  const { id } = row, value = values[id];
  const model = value === 'follow' ? undefined : value?.model;
  const family = model ? rowFor(catalog, model)?.family ?? familyOf(model) : undefined;
  const name = operationName(row), changed = !sameOperation(value, baseline[id]);
  const expanded = (kind: Control) => control?.id === id && control.kind === kind;
  const reported = sameOperation(value, info.effective[id]);
  const suggestion = value === 'follow' && row.suggestion && catalog.some(item => item.model === row.suggestion && item.available) ? row.suggestion : null;
  return <article className={`seats-op-card${over === id ? ' is-over' : ''}`} data-operation={id} data-op-slot={id} aria-label={name}>
    <OperationTitle row={row} changed={changed} />
    <div className="seats-op-info">
      <p className="seats-op-covers">{operationWords(row.covers)}</p>
      {value === 'follow' && reported && id === 'review' && <p className="seats-op-note">{row.effective ? label(row.effective.model) : t('Codex 默认')}</p>}
      <div className="seats-op-status">
        {(Object.keys(AGENTS) as (keyof typeof AGENTS)[]).map(agent =>
          <Status key={agent} family={agent} value={reported ? row.agents[agent] : previewState(row, agent, family)}
            expanded={expanded(agent)} onOpen={button => open(id, button, agent)} />)}
        {!reported && <span className="seats-op-note">{t('保存后检查是否生效')}</span>}
      </div>
      {row.note && <p className="seats-op-note">{operationWords(row.note)}</p>}
    </div>
    <div className="seats-op-settings">
      <button type="button" className="seats-gem" data-op-model={id} aria-haspopup="menu" aria-expanded={expanded('model')}
        title={model} aria-label={t('{seat}：选择模型', { seat: name })} onClick={event => open(id, event.currentTarget, 'model')}>
        {family && <i className="seats-mk" data-family={family} aria-hidden="true" />}
        <span className="seats-gem-name">{operationLabel(row, value, label)}</span><CaretDown size={14} aria-hidden="true" />
      </button>
      {value && value !== 'follow' && family && operationUsesEffort(row, family) && <button type="button" className="seats-effort"
        data-op-effort={id} aria-haspopup="menu" aria-expanded={expanded('effort')} aria-label={t('{seat}：选择强度', { seat: name })}
        onClick={event => open(id, event.currentTarget, 'effort')}>{value.effort ?? '—'}<CaretDown size={12} aria-hidden="true" /></button>}
      {suggestion && <button type="button" className="seats-btn is-small" data-op-suggestion={suggestion}
        onClick={() => select(id, suggestion)}>{t('使用建议模型 {model}', { model: label(suggestion) })}</button>}
    </div>
  </article>;
}

export function OperationRows(props: OperationRowsProps) {
  return <div className="seats-operations" id="seats-operations-panel" role="tabpanel" aria-labelledby="seats-operations-tab">
    {props.info.rows.map(row => editableOperation(row) ? <OperationCard key={row.id} row={row} {...props} /> :
      <article key={row.id} className="seats-op-card is-readonly" data-operation={row.id}>
        <OperationTitle row={row} />
        <div className="seats-op-info"><p>{t('不可控，由 Claude Code / Codex 内置决定')}</p>
          {row.id === 'titles' && row.note && <p className="seats-op-note">{operationWords(row.note)}</p>}
        </div>
      </article>)}
  </div>;
}

export function CurrentOperations({ info, label }: { info: SeatsInfo['operations']; label: OperationRowsProps['label'] }) {
  const current = info?.current;
  if (!current) return null;
  return <div className="seats-now-operations">
    <b>{t('操作模型')}</b>
    <div className="seats-nows">{info.rows.filter(editableOperation).map(row => {
      const value = current.values[row.id], agents = current.agents[row.id];
      return <div key={row.id} className="seats-now-op" data-now-operation={row.id}>
        <span className="seats-now"><b>{operationName(row)}</b>
          {operationLabel(row, value, label)}{value && value !== 'follow' && value.effort && ` · ${value.effort}`}</span>
        {agents && <><Status family="claude" value={agents.claude} /><Status family="codex" value={agents.codex} /></>}
      </div>;
    })}</div>
  </div>;
}
