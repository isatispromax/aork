import { expect, type Locator, type Page } from '@playwright/test';

/** The default settings layer, opened when it is closed and showing `section`: the name its
 * navigation lists — 外观, or a section's own label such as 插件 or Agent 配置. Opening lands on
 * 外观, so a caller wanting another section always names it. A layer left open is reused rather
 * than opened again: it covers the button that opened it. Returns the layer. */
export async function openSettings(page: Page, section?: string): Promise<Locator> {
    const layer = page.getByRole('dialog', { name: '设置', exact: true });
    if (!await layer.isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(layer).toBeVisible();
    if (section) {
        await layer.getByRole('complementary', { name: '设置导航' }).getByRole('button', { name: section, exact: true }).click();
        // The panel's breadcrumb names the section on show.
        await expect(layer.getByRole('region', { name: '设置内容' }).locator('header strong').first()).toHaveText(section);
    }
    return layer;
}
