import { t } from '../../shared/i18n';

export function composerHints({ locked, preview, live, hasChoice, shownBlocked, result, cliActive, agent }: {
  locked?: boolean; preview: boolean; live: boolean; hasChoice: boolean;
  shownBlocked: boolean; result: boolean; cliActive?: boolean; agent: string;
}) {
  return locked ? [t('正在切换运行方式，稍后继续'), t('正在切换运行方式'), t('切换中')]
    : preview ? [t('历史预览，等待会话输入就绪'), t('历史预览'), t('预览')]
    : !live ? [t('会话未启动或已退出'), t('会话未运行'), t('未运行')]
    : hasChoice ? [t('等终端处理完后发送'), t('等终端处理完'), t('等终端')]
    : shownBlocked ? [t('等待终端输入就绪后发送'), t('等输入就绪后发送'), t('等输入就绪')]
    : result ? [t('继续修改，或描述下一步…'), t('继续修改…')]
    : cliActive ? [
      t('给 {agent} 发消息，/ 查看命令，@ 提及文件，Enter 发送，Shift+Enter 换行', { agent }),
      t('给 {agent} 发消息，/ 查看命令，@ 提及文件', { agent }), t('给 {agent} 发消息', { agent }), t('输入消息…'),
    ] : [t('输入命令，Enter 发送'), t('输入命令')];
}
