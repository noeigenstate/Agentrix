// The title bar has no settings button: Settings and the other app actions are in the menu on the logo and title (src/features/titlebar/AppMenu.tsx).
export async function chooseFromAppMenu(page, name) {
  await page.locator('.titlebar').getByRole('button', { name: 'Agentrix', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
export const openSettings = (page, name = '设置') => chooseFromAppMenu(page, name);
