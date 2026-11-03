import { t } from '../../shared/i18n';

// The agreement the owner accepts before the beta channel. Main holds the same version (electron/features/updates) and a test keeps the two equal:
// change both, and the clauses, together; a new version asks every user to agree again. Keep this on one line, the test reads it.
export const BETA_AGREEMENT_VERSION = '2026-11-03';

// Read when the dialog opens, so the clauses follow the language chosen in settings.
export const betaAgreementClauses = () => [
  t('测试版可能不稳定，也可能丢失未保存的工作；使用前请备份重要的项目和数据。'),
  t('测试版的更新比正式版更频繁。'),
  t('遇到问题，请在「关于 Agentrix」页的「GitHub 项目」链接打开的项目页面，通过 Issues 反馈。'),
  t('测试版不会增加遥测。'),
  t('你可以随时切回稳定版，但不会被自动降级；已安装的测试版会保留，直到有更新的正式版。'),
  t('同意只适用于本协议的当前版本；协议更新后，需要重新同意才会继续接收测试版更新。'),
];
