// A pasted picture as a JPEG at most 640 pixels wide, for an attachment bar and the message it goes with.
export const dataUrl = (file: Blob) => new Promise<string>((done, fail) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? done(reader.result) : fail(new Error('unreadable')); reader.onerror = () => fail(reader.error); reader.readAsDataURL(file); });
export async function thumbnail(file: Blob) {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width <= 640) return await dataUrl(file);
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = Math.max(1, Math.round(bitmap.height * 640 / bitmap.width));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .86);
  } finally { bitmap.close(); }
}
