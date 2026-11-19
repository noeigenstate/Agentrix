import type { RoutingAction, RoutingFlag, RoutingSource } from '../../shared/types';
import { t } from '../../shared/i18n';

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
  'reviewer-required': '至少保留一个审查角色。',
  'lead-locked': '总指挥必须保留。',
  'reviewer-same-model': '审查角色与写作角色使用了相同的模型。',
  'review-same-model': '审查操作与写作角色使用了相同的模型。',
  'file-changed': '文件已在磁盘上更改，请重新查看。',
  'file-unwritable': '无法写入路由文件。',
  'action-unavailable': '此操作已不可用。',
};
const fields: Record<string, string> = {
  enabled: '启用', name: '名称', model: '模型', effort: '强度', fast: '快速', fresh: '新实例',
  duty: '职责', outputs: '产出', from: '基于',
};
const flagLabels: Record<RoutingFlag['code'], string> = {
  'expensive-model': '较高成本的模型',
  'fast-on': '开启快速模式',
  'high-effort': '高强度设置',
  'unlisted-model': '模型未列出',
  'verification-weakened': '验证减弱',
  'custom-text': '自定义角色文字',
  'operation-cost': '操作模型成本',
};
const valueText = (value: unknown) =>
  value == null ? '—' : typeof value === 'string' ? value : typeof value === 'boolean' ? t(value ? '是' : '否') : JSON.stringify(value);
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

export function RoutingReview({ source, busy, refreshed, act, close, rawOpen, toggleRaw }: {
  source: RoutingSource; busy: boolean; refreshed?: boolean; act: (action: RoutingAction) => void;
  close?: () => void; rawOpen: boolean; toggleRaw: () => void;
}) {
  const review = source.review;
  const reason = source.error ? routingError(source.error) : t(review?.reason === 'new-on-machine' ?
    '首次在此电脑打开' : '文件在 Agentrix 之外被修改（git、编辑器或代理）');
  const custom = Object.entries(review?.config.roles ?? {}).filter(([, role]) => role.from);
  return <section className="seats-routing-review" aria-labelledby="routing-review-heading" data-routing-review={source.state}>
    <div className="seats-review-main">
      <h3 id="routing-review-heading">{reason}</h3>
      {review && <>
        <table><caption>{t('与当前配置的差异')}</caption>
          <thead><tr><th>{t('角色或操作')}</th><th>{t('字段')}</th><th>{t('当前')}</th><th>{t('文件')}</th></tr></thead>
          <tbody>{review.changes.map(({ role, operation, field, from, to }, index) => <tr key={index}>
            <th scope="row"><span>{role ?? operation}</span></th>
            <td><span>{Object.hasOwn(fields, field) ? t(fields[field]) : field}</span></td>
            <td><span>{valueText(from)}</span></td><td><span>{valueText(to)}</span></td>
          </tr>)}</tbody>
        </table>
        {custom.map(([id, role]) => <article className="seats-review-text" key={id} data-routing-custom={id}>
          <h4>{role.name ?? id}</h4><dl><dt>{t('职责')}</dt><dd>{role.duty}</dd><dt>{t('产出')}</dt><dd>{role.outputs}</dd></dl>
        </article>)}
        {review.ignored.length > 0 && <div><h4>{t('忽略的条目')}</h4><ul>{review.ignored.map(entry => <li key={entry}>{entry}</li>)}</ul></div>}
      </>}
      {rawOpen && source.raw !== undefined && <pre id="routing-raw" tabIndex={0}>{escapeRoutingText(source.raw)}</pre>}
    </div>
    <aside className="seats-review-control">
      <h4>{t('配置来源')}</h4><code>{source.path}</code>
      <p>{t('当前使用：{layer}', { layer: routingLayer(source) })}</p>
      {!!review?.flags.length && <ul>{review.flags.map((flag, index) =>
        <li key={index} data-routing-flag={flag.code}><b>{t(flagLabels[flag.code])}</b> {flag.role ?? flag.operation} {flag.text}</li>)}</ul>}
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
