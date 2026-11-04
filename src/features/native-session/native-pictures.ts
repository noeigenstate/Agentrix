// The pictures that go with a native session's next message, from a paste or a drop. The main process takes only PNG, JPEG and WebP as data URLs
// (electron/features/native-session/validate.cjs), so anything else is refused here, before it is attached, and the owner is told why. The picture is read whole
// (the model should see the picture itself, not the reading view's 640-pixel preview); the bar above the box and the message show it with the reading view's own chips.
import { t } from '../../shared/i18n';
import { dataUrl } from '../../shared/image-thumbnail';

export const MAX_PICTURES = 4;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;

// The message that carries only pictures: the runtime takes no message without words.
export const picturesOnly = () => t('请看附上的图片。');

// Reads the files that fit in `room` more pictures; the first thing wrong with any of them is the error, and the rest still attach.
export async function readPictures(files: readonly File[], room: number): Promise<{ pictures: string[]; error: string | null }> {
  const pictures: string[] = [];
  let error: string | null = files.length > room ? t('最多附加 4 张图片，请先移除一张。') : null;
  for (const file of files.slice(0, Math.max(room, 0))) {
    if (!TYPES.has(file.type)) { error ??= t('只能附加 PNG、JPEG 或 WebP 图片。'); continue; }
    if (file.size > MAX_BYTES) { error ??= t('图片太大（超过 5 MB），请压缩后再附加。'); continue; }
    try { pictures.push(await dataUrl(file)); } catch { error ??= t('无法读取这张图片。'); }
  }
  return { pictures, error };
}
