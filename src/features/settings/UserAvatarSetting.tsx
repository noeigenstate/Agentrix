import { useRef, useState } from 'react';
import { UserCircle } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { AVATAR_MAX_BYTES, AVATAR_TYPES, avatarFromFile } from './avatar-image';

// The picture shown wherever the user speaks: the reading view's timeline, queued messages. It is stored in settings,
// so every place changes the moment it is picked.
export function UserAvatarSetting({ avatar, update }: { avatar: string; update: (avatar: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type) || file.size > AVATAR_MAX_BYTES) { setError(t('请选择 10 MB 以内的 PNG、JPG、WebP 或 GIF 图片')); return; }
    try { update(await avatarFromFile(file)); setError(''); } catch { setError(t('这张图片无法读取')); }
  };
  return <div className="setting-row user-avatar-row">
    <span>
      {avatar ? <img className="user-avatar user-avatar-preview" src={avatar} alt="" /> : <UserCircle size={19} />}
      <span><b>{t('用户头像')}</b><small>{error || t('显示在阅读版面等所有出现你的地方；图片只在本机处理')}</small></span>
    </span>
    <span className="user-avatar-actions">
      <input ref={input} type="file" accept={AVATAR_TYPES.join(',')} hidden aria-label={t('上传图片')} onChange={event => { void pick(event.target.files?.[0]); event.target.value = ''; }} />
      <button type="button" className="button secondary" onClick={() => input.current?.click()}>{t('上传图片')}</button>
      {avatar && <button type="button" className="button secondary" onClick={() => { update(''); setError(''); }}>{t('恢复默认')}</button>}
    </span>
  </div>;
}
