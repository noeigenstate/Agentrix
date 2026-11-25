// The picture a paste carries when it carries no text (a copied screenshot or image file), else null: pasting words stays the text box's own.
export function pastedPicture(data: DataTransfer): DataTransferItem | null {
  if (data.getData('text/plain')) return null;
  return [...data.items].find(item => item.kind === 'file' && item.type.startsWith('image/')) ?? null;
}
