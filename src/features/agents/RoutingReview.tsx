import type {
  RoutingAction, RoutingFlag, RoutingReview as Review, RoutingRoleChange, RoutingRoleState, RoutingSource, SeatRole,
} from '../../shared/types';
import { t } from '../../shared/i18n';
import { routingRoleName } from '../../shared/routing-command.ts';

const actions = { apply: '应用', keep: '保留当前', overwrite: '用当前设置覆盖文件' } as const;
const layers = { file: '本项目路由文件', accepted: '上次接受的配置', local: '本机项目设置', template: '我的默认模板' } as const;
const errors: Record<string, string> = {
  'too-large': '路由文件超过 32 KiB。',
  'too-deep': '路由文件嵌套过深。',
  'bad-utf8': '路由文件必须使用 UTF-8。',
  'bad-json': '路由文件的 JSON 无效。',
  'unknown-key': '路由文件包含未知字段。',
  'newer-version': '需要更新的 Agentrix 版本。',
  link: '路由路径是链接。',
  'not-file': '路由路径不是普通文件。',
  'bad-format': '路由文件格式无效。',
  'invalid-role': '角色 ID 或来源无效。',
  'role-text': '角色文字无效，或已启用角色的名称重复。',
  'role-limit': '超过角色数量上限。',
  'lead-locked': '总指挥必须保留。',
  'file-changed': '文件已在磁盘上更改，请重新查看。',
  'file-unwritable': '无法写入路由文件。',
  'action-unavailable': '此操作已不可用。',
};
const flagLabels: Record<RoutingFlag['code'], string> = {
  'expensive-model': '较高成本的模型',
  'fast-on': '开启快速模式',
  'high-effort': '高强度设置',
  'unlisted-model': '模型未列出',
  'custom-text': '自定义角色文字',
};
function valueText(value: string | boolean | undefined) {
  if (value === undefined) return '—';
  return typeof value === 'boolean' ? t(value ? '是' : '否') : value;
}
export const routingLayer = (source: RoutingSource) => t(layers[source.layer]);
export const routingError = (error: { code: string; message?: string }) => t(Object.hasOwn(errors, error.code) ? errors[error.code] : error.message ?? error.code);

export function escapeRoutingText(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, char => {
    const hex = char.codePointAt(0)!.toString(16);
    return hex.length > 4 ? '\\u{' + hex + '}' : '\\u' + hex.padStart(4, '0');
  });
}

export function resolveRouting(api: Pick<Window['agentrix'], 'resolveSkillRouting'>, projectId: string, source: RoutingSource, action: RoutingAction) {
  if (!source.digest || !source.actions.includes(action)) return;
  return api.resolveSkillRouting(projectId, action, source.digest);
}

const groups = { added: '新增角色', removed: '移除或停用的角色', changed: '修改的角色' } as const;

const roleFields = { model: '模型', effort: '强度', fast: '快速', fresh: '新实例', enabled: '启用', from: '基于' } as const;

function RoleSettingsDiff({ before, after }: Pick<RoutingRoleChange, 'before' | 'after'>) {
  return <div className="seats-review-settings">
    {(Object.keys(roleFields) as (keyof typeof roleFields)[]).filter(field => before?.[field] !== after?.[field]).map(field =>
      <span key={field}>{t(roleFields[field])} <span>{valueText(before?.[field])}</span> → <span>{valueText(after?.[field])}</span></span>)}
  </div>;
}

function roleTitle(change: RoutingRoleChange, roles: readonly SeatRole[]) {
  if (change.source === 'custom') return (change.after ?? change.before)?.custom?.name ?? change.role;
  return routingRoleName(roles.find(role => role.id === change.role)?.name ?? change.role, t);
}

function RiskPills({ flags }: { flags: RoutingFlag[] }) {
  return <div className="seats-review-pills">{flags.map(({ code, text }, index) =>
    <span key={index} className="seats-risk-pill" data-routing-flag={code} title={text}>{t(flagLabels[code])}</span>)}</div>;
}

function RiskSummary({ flags }: { flags: RoutingFlag[] }) {
  const counts = new Map<RoutingFlag['code'], number>();
  for (const { code } of flags) counts.set(code, (counts.get(code) ?? 0) + 1);
  return <div className="seats-review-pills" aria-label={t('风险摘要')}>
    {[...counts].map(([code, count]) => <span key={code} className="seats-risk-pill" data-routing-risk-count={code}>
      {t('{label} × {count}', { label: t(flagLabels[code]), count })}
    </span>)}
  </div>;
}

function CustomSnapshot({ state, heading }: { state: RoutingRoleState | null; heading?: string }) {
  if (!state?.custom) return null;
  const { name, duty, outputs } = state.custom;
  return <div className="seats-review-text">
    {heading && <b>{heading}</b>}
    <dl><dt>{t('名称')}</dt><dd>{name}</dd><dt>{t('职责')}</dt><dd>{duty}</dd><dt>{t('产出')}</dt><dd>{outputs || '—'}</dd></dl>
  </div>;
}

function ReviewRoleRow({ change, roles, flags }: { change: RoutingRoleChange; roles: readonly SeatRole[]; flags: RoutingFlag[] }) {
  const { before, after, role, source } = change;
  const compareCustom = before?.custom && after?.custom && JSON.stringify(before.custom) !== JSON.stringify(after.custom);
  return <tr data-review-role={role} data-risk={flags.length > 0 || undefined}>
    <th scope="row"><span>{roleTitle(change, roles)}</span><span className="seats-review-id">{role}</span></th>
    <td><RoleSettingsDiff before={before} after={after} />
      {source === 'custom' && (compareCustom ? <>
        <CustomSnapshot state={before} heading={t('当前')} /><CustomSnapshot state={after} heading={t('应用后')} />
      </> : <CustomSnapshot state={after ?? before} />)}
    </td>
    <td>{flags.length > 0 && <RiskPills flags={flags} />}</td>
  </tr>;
}

function ReviewTable({ review, roles }: { review: Review; roles: readonly SeatRole[] }) {
  return <table aria-label={t('与当前配置的差异')}>
    <colgroup><col className="seats-review-role-col" /><col /><col className="seats-review-risk-col" /></colgroup>
    <thead><tr><th scope="col">{t('角色')}</th><th scope="col">{t('变化')}</th><th scope="col">{t('风险')}</th></tr></thead>
    {(Object.keys(groups) as (keyof typeof groups)[]).map(group => {
      const changes = review.roleChanges.filter(change => change.status === group);
      return changes.length ? <tbody key={group} data-review-group={group}>
        <tr className="seats-review-group"><th colSpan={3} scope="rowgroup">{t(groups[group])}</th></tr>
        {changes.map(change => <ReviewRoleRow key={change.role} change={change} roles={roles} flags={review.flags.filter(flag => flag.role === change.role)} />)}
      </tbody> : null;
    })}
  </table>;
}

function OtherRisks({ review, roles }: { review: Review; roles: readonly SeatRole[] }) {
  const flags = review.flags.filter(flag => flag.role && !review.roleChanges.some(change => change.role === flag.role));
  if (!flags.length) return null;
  return <ul className="seats-review-other-risks" aria-label={t('风险')}>
    {flags.map((flag, index) => {
      const role = roles.find(item => item.id === flag.role);
      const label = role ? routingRoleName(role.name, t) : flag.role;
      return <li key={index}><span>{label}</span><RiskPills flags={[flag]} /></li>;
    })}
  </ul>;
}

export function RoutingReview({ source, roles = [], busy, refreshed, act, close, rawOpen, toggleRaw }: {
  source: RoutingSource; busy: boolean; refreshed?: boolean; act: (action: RoutingAction) => void;
  close?: () => void; rawOpen: boolean; toggleRaw: () => void;
  roles?: readonly SeatRole[];
}) {
  const review = source.review;
  const reason = t(review?.reason === 'new-on-machine' ? '首次在此电脑打开' : '文件在 Agentrix 之外被修改（git、编辑器或代理）');
  return <section className="seats-routing-review" aria-labelledby="routing-review-heading" data-routing-review={source.state}>
    <div className="seats-review-main">
      <h3 id="routing-review-heading">{source.error ? t('这个文件没有被应用') : reason}</h3>
      {source.error && <p>{routingError(source.error)}</p>}
      {!!review?.flags.length && <RiskSummary flags={review.flags} />}
      <div className="seats-review-scroll" role="region" aria-label={t('与当前配置的差异')} tabIndex={0}>
        {review && <ReviewTable review={review} roles={roles} />}
        {review && <OtherRisks review={review} roles={roles} />}
        {!!review?.ignored.length && <div className="seats-review-ignored"><h4>{t('忽略的条目')}</h4>
          <ul>{review.ignored.map(entry => <li key={entry}>{entry}</li>)}</ul>
        </div>}
        {rawOpen && source.raw !== undefined && <pre id="routing-raw" tabIndex={0}>{escapeRoutingText(source.raw)}</pre>}
      </div>
    </div>
    <aside className="seats-review-control">
      <h3>{t('配置来源')}</h3><code>{source.path}</code>
      <p>{t('当前使用：{layer}', { layer: routingLayer(source) })}</p>
      {refreshed && <p role="status" data-review-refreshed>{t('文件已更改，已刷新')}</p>}
      {source.actions.map(action => <button type="button" data-routing-action={action} key={action}
        className={action === 'apply' ? 'seats-btn is-primary' : 'seats-btn'} disabled={busy || refreshed || !source.digest}
        onClick={() => act(action)}>{t(actions[action])}</button>)}
      {source.raw !== undefined && <button type="button" className="seats-btn" aria-expanded={rawOpen} aria-controls="routing-raw"
        onClick={toggleRaw}>{t('查看原文')}</button>}
      {close && <button type="button" className="seats-btn" disabled={busy} onClick={close}>{t('返回')}</button>}
    </aside>
  </section>;
}
