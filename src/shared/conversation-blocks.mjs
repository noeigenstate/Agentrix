// Page and render by the same units: adjacent tool calls form one block.
export function conversationBlocks(entries) {
  const blocks = [];
  for (const entry of entries) {
    const last = blocks.at(-1);
    if (entry.role === 'tool' && last?.[0].role === 'tool') last.push(entry);
    else blocks.push([entry]);
  }
  return blocks;
}
