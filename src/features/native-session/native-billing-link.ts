// The text button that opens the console's billing page, where the owner checks what was actually billed. It opens the one fixed address (native-words.ts
// BILLING_URL) the way every link is opened, through the project, and says why when that is refused. The reading view's limit notice and the activity pane's usage
// block both use this one button. It is a .ts file written with the JSX runtime's calls so the activity pane may import it by the same `native-*.ts` rule as the
// bridge and the words.
import { useState } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { t } from '../../shared/i18n';
import { openProjectLink } from './native-bridge.ts';
import { BILLING_URL } from './native-words';

export function BillingLink({ projectId }: { projectId: string }) {
  const [error, setError] = useState<string | null>(null);
  const open = () => { setError(null); void openProjectLink(projectId, BILLING_URL).then(result => { if (!result.ok) setError(result.error); }).catch((failure: unknown) => setError(String(failure))); };
  return jsxs(Fragment, { children: [
    jsx('button', { type: 'button', className: 'text-button api-billing', onClick: open, children: t('在控制台核对') }),
    error ? jsx('p', { className: 'activity-note', role: 'alert', children: error }) : null,
  ] });
}
