import { expect, test, type Page } from '@playwright/test';

// the demo is a train job (contract v1: preparing and training are separate jobs)
const TRAIN_STAGE_COUNT = 6;
// chips carry a visually hidden label, so their full text is e.g. "Stream:ended"
const streamEnded = (page: Page) => page.getByText(/^Stream:\s*ended$/);
const stages = (page: Page) => page.getByRole('list', { name: 'Pipeline stages' }).getByRole('listitem');

test('library → singer → training → live run reaches done (refresh mid-run keeps the timeline)', async ({ page }) => {
  // opens straight on the library: single-user app, no login
  await page.goto('/');
  // the library row, not the header's "now running" link to the same singer's job
  await page.getByRole('list', { name: 'Singers' }).getByRole('link', { name: /Arif Baloch/ }).click();
  await expect(page).toHaveURL(/\/singers\/[^/]+\/songs$/);

  await page.getByRole('link', { name: 'Training', exact: true }).click();
  await page.getByRole('link', { name: 'Open live run' }).first().click();

  await expect(page).toHaveURL(/\/jobs\/job-arif-run-3$/);
  await expect(page.getByRole('heading', { name: 'Arif Baloch · training run 3' })).toBeVisible();
  await expect(stages(page)).toHaveCount(TRAIN_STAGE_COUNT);

  // wait until a few stages are through, then refresh: the replay redraws the timeline
  await expect.poll(async () => page.locator('[data-status="done"]').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  const doneBefore = await page.locator('.sp-stage[data-status="done"]').count();
  await page.reload();
  await expect(stages(page)).toHaveCount(TRAIN_STAGE_COUNT);
  await expect.poll(async () => page.locator('.sp-stage[data-status="done"]').count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(doneBefore);

  // the run finishes: every stage done, stream ended, checkpoints listed
  await expect(streamEnded(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.sp-stage[data-status="done"]')).toHaveCount(TRAIN_STAGE_COUNT);
  await expect(page.getByText(/^Job status:\s*done$/)).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Job progress' })).toHaveAttribute('aria-valuenow', '100');
  const checkpoints = page.getByRole('region', { name: 'Checkpoints' });
  await expect(checkpoints.getByRole('listitem')).toHaveCount(8);
  await expect(checkpoints.getByText('recommended')).toBeVisible();
});

test('live run view in light and dark at 1440 and 390 px', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/jobs/job-arif-run-2');
      await expect(streamEnded(page)).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `test-results/live-run-${scheme}-${width}.png`, fullPage: true });
      // no horizontal page scroll at phone width
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  }
});

test('system screen stays within the page at 1440 and 390 px', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/system');
    await expect(page.getByRole('table', { name: 'Benchmark results' })).toBeVisible();
    await expect(page.getByText(/ffmpeg\.exe$/)).toBeVisible();
    await page.screenshot({ path: `test-results/system-${width}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // the VRAM meter header stays on one line
    const head = page.locator('.sys-meter-head').first();
    const box = await head.boundingBox();
    expect(box?.height ?? 99).toBeLessThan(30);
    // the GPU name sits at the top of its section, right under the heading
    const heading = await page.getByRole('heading', { name: 'GPU', level: 2 }).boundingBox();
    const name = await page.getByText('NVIDIA GeForce RTX 4050 Laptop GPU').boundingBox();
    expect((name?.y ?? 9999) - ((heading?.y ?? 0) + (heading?.height ?? 0))).toBeLessThan(60);
  }
});

test('analyse: upload a song → live stages → lyrics, style and timeline; a lyric line plays from its time', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Analyse' }).click();
  await expect(page).toHaveURL(/\/analyses$/);
  await page.getByRole('link', { name: 'New analysis' }).click();

  await page.getByLabel(/Choose the song/).setInputFiles({ name: 'Kech Makoran.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096) });
  await expect(page.getByText('✓ uploaded')).toBeVisible();
  await page.getByRole('button', { name: 'Balochi' }).click();
  await page.getByRole('button', { name: 'Analyse the song' }).click();

  // live: the analysis stages on the signal path, then the parts fill in as stages finish
  await expect(page).toHaveURL(/\/analyses\/ana-/);
  await expect(page.getByRole('heading', { name: 'Kech Makoran.mp3' })).toBeVisible();
  await expect(page.getByText('Balochi · rough draft (written with Urdu)')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Analysis stages' }).getByRole('listitem')).toHaveCount(4);
  const lines = page.getByRole('list', { name: 'Lyric lines' });
  await expect(lines).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Music style' }).getByText('A#')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Song sections, in order' }).getByRole('button')).toHaveCount(7, { timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Analysis stages' })).toHaveCount(0, { timeout: 30_000 });

  // a lyric line seeks the player and plays; the line is marked while it is sung
  const third = lines.getByRole('button').nth(2);
  await third.click();
  await expect(third).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.getByText(/^0:2\d \/ 3:1\d$/)).toBeVisible();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `test-results/analysis-${width}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
