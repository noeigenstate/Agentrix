import { CircleNotch } from '@phosphor-icons/react';
import type { ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { countBackground } from './subagent-splits.ts';
import './activity-pane.css';

// 「后台 N 个运行中」: background commands of the project that still run, shown where a reply that says it is complete could be taken for a finished project: the project header
// (which is also the small card's) and, as a count, the left bar's Agent tab. Nothing is placed inside the reading view.
export function BackgroundBadge({ terminals }: { terminals: readonly ProjectTerminal[] }) {
  const count = countBackground(terminals);
  if (count <= 0) return null;
  const full = t('{count} 个后台任务还在运行，回复写着完成不代表它们结束了。', { count });
  return <span className="activity-background-badge" title={full} aria-label={`${t('后台 {count} 个运行中', { count })}. ${full}`}><CircleNotch size={12} weight="bold" className="loading-spinner" aria-hidden="true" /><span className="activity-background-long" aria-hidden="true">{t('后台 {count} 个运行中', { count })}</span><span className="activity-background-short" aria-hidden="true">{t('后台 {count}', { count })}</span></span>;
}
