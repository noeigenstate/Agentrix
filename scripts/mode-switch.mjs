// The terminal / reading switch is only in the title bar of the expanded project. A check about a small card seeds its mode through it: expand the project,
// press the switch, and come back to the overview (a project already expanded stays as it is). The mode belongs to the terminal and outlives the expansion.
const LABELS = { terminal: '切换到终端', reading: '阅读视图：按文档排版显示对话' };
const settled = (page, expanded) => page.waitForFunction(expanded => !!document.querySelector('.focus-mode') === expanded && !document.querySelector('[data-focus-motion]'), expanded);

// terminalId: the split the switch acts on, for a project with several terminals (the first one is in use until another is picked).
export async function setMode(page, projectName, mode, { terminalId } = {}) {
  const wasExpanded = await page.locator('.focus-mode').count() > 0;
  if (!wasExpanded) { await page.getByRole('button', { name: `进入 ${projectName}`, exact: true }).click(); await settled(page, true); }
  if (terminalId) await page.locator(`[data-terminal-id="${terminalId}"] .terminal-split-body`).click({ position: { x: 8, y: 8 } });
  await page.locator('.titlebar-tools').getByRole('button', { name: LABELS[mode], exact: true }).click();
  if (!wasExpanded) { await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(page, false); }
}
