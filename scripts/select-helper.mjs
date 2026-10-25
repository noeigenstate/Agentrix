// The app's dropdowns are buttons with a pop-up listbox (src/shared/Select.tsx), not native <select>s.
export async function pick(page, trigger, value) {
  await trigger.click();
  await page.locator(`.select-menu [data-value="${value}"]`).click();
}
export const picked = trigger => trigger.getAttribute('data-value');
