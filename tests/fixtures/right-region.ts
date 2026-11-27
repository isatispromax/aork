import { expect, type Locator, type Page } from '@playwright/test';

/** The right region opens on its start page: one capsule per installed panel type. This picks a
 * type from it, or does nothing when that type is already open. A collapsed region is opened
 * first, so callers need not know which state the region was left in. The start page is a
 * doorway — picking from it replaces it — so when no pane shows one, the add control opens it
 * before the pick. `region` names the element that holds the docking shell when a layout other
 * than the default provides for it. */
export async function openPanel(page: Page, title: string, region?: Locator): Promise<void> {
    // Docked, the region is a complementary landmark; as the compact drawer it is a modal dialog.
    const right = region ?? page.getByRole('complementary', { name: '右侧栏', exact: true }).or(page.getByRole('dialog', { name: '右侧栏', exact: true }));
    const toggle = page.getByRole('button', { name: '切换右侧栏', exact: true });
    // Whether the region is open can only be read once the layout has rendered: before that there
    // is no region to see, and a toggle pressed now would close the one about to open.
    await expect(toggle).toBeAttached();
    if (!await right.isVisible()) await toggle.click();
    const chip = right.getByRole('tablist').getByRole('tab', { name: new RegExp(title) });
    const entry = right.locator('[data-inspector-entry]').filter({ hasText: title });
    await expect(right.locator('[data-inspector-guide], [data-dock-pane]').first()).toBeVisible();
    if (await chip.count()) return;
    // A pane already holding a start page draws no add control, so that control is only looked
    // for when no capsule is on screen.
    if (!await entry.count()) await right.getByRole('button', { name: '新建标签页', exact: true }).first().click();
    await entry.first().click();
    await expect(chip).toBeVisible();
}
