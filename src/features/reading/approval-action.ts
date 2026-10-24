import type { ScreenAgent, ScreenChoice } from '../agents/agent-screen-types';
import type { ApprovalResult } from '../../shared/types';

// Observation epochs and screen instances cannot target a native TUI request at key consumption.
// Retained callbacks fail closed without invoking either terminal IPC route, even with a fabricated identity.
export async function writeApprovalAction(_terminalId: string, _agent: ScreenAgent, _choice: ScreenChoice, _target: number | 'cancel', _active: () => boolean): Promise<ApprovalResult> {
  return { mode: 'terminal-only', reason: 'native-request-identity-unavailable' };
}

export function terminalApprovalCopy(language: 'zh' | 'en') {
  return language === 'zh' ? {
    message: '请在源终端中确认或拒绝此请求。权限卡片无法安全地发送审批按键。',
    open: '去终端处理',
  } : {
    message: 'Confirm or reject this request in the source terminal. Permission cards cannot safely send approval keys.',
    open: 'Open terminal',
  };
}
