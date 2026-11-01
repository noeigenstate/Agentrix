// Kept in the reading module so composer recovery and transcript receipts use distinct advice.
export function pictureInputCopy(language: 'zh' | 'en') {
  return language === 'zh' ? {
    unaccepted: '图片未发送。请在输入框中移除后重新粘贴。',
    failed: '图片未能附加，已从输入框移除。请等终端准备好后重新粘贴。',
    removed: '已从输入框移除，请检查终端中是否还留有图片。',
    pending: '请先发送或移除输入框中的图片，再发送这条消息。',
    receipt: '图片是否送达尚未确认。请先在终端中检查对话，再决定是否重新发送。',
  } : {
    unaccepted: 'The picture was not sent. Remove it here and paste again.',
    failed: 'The picture could not be attached and was removed. Paste it again when the terminal is ready.',
    removed: 'Removed from the message box. Check the terminal for a remaining picture.',
    pending: 'Send or remove the picture in the message box before sending this message.',
    receipt: 'Image delivery is unconfirmed. Check the conversation in the terminal before sending it again.',
  };
}
