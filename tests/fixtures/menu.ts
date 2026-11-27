import { expect, type Locator, type Page } from '@playwright/test';

/** The header's "···" menu, opened when it is closed. It is a native disclosure that stays open
 * after most of its actions are chosen, so pressing its trigger again to "open" it would close
 * it instead: whether it is open is read from the disclosure itself, never inferred from whether
 * one action happens to be showing at that instant. Returns the menu's list of items. */
export async function openMenu(page: Page): Promise<Locator> {
    const disclosure = page.locator('details[class*="workbench_menu"]');
    if (!await disclosure.evaluate(node => (node as HTMLDetailsElement).open)) await page.getByLabel('更多菜单', { exact: true }).click();
    await expect(disclosure).toHaveJSProperty('open', true);
    return disclosure.getByRole('menu');
}
