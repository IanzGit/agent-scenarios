import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startFixtureServer } from './fixture-server.ts'
import { root, launchWeb, launchBrowser } from './web-harness.ts'

test('实际 Harness Web 展示两个场景、图表交互及刷新回放', { timeout: 120000 }, async () => {
  const fixture = await startFixtureServer()
  const web = await launchWeb(fixture.url)
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(web.url)
    const notice = page.getByRole('button', { name: /^(Continue|继续)$/ })
    await notice.waitFor({ state: 'visible', timeout: 15000 })
    await notice.click()
    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    await editor.waitFor({ state: 'visible', timeout: 20000 })
    await editor.click()
    await page.keyboard.type('当前矿井总体水害监测预警情况汇总分析')
    await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
    await page.locator('[data-report-title="预警报警统计"]').waitFor({ state: 'visible', timeout: 30000 })
    assert.equal(await page.locator('.water-hazard-report').count(), 4)
    assert.equal(await page.locator('.water-hazard-canvas svg').count(), 4)
    assert.equal(await page.locator('[data-report-title="单因素超限报警"] tbody tr').count(), 1)
    await page.screenshot({ path: resolve(root, 'test-results/overview.png'), fullPage: true })
    const acquired = fixture.requests.length
    await page.reload()
    await page.locator('[data-report-title="预警报警统计"]').waitFor({ state: 'visible', timeout: 20000 })
    assert.equal(fixture.requests.length, acquired, '历史回放不重新请求业务数据')
    await Promise.all([
      page.waitForResponse('**/api/session/create'),
      page.getByRole('button', { name: /new session|新会话/i }).first().click(),
    ])
    await page.locator('.water-hazard-results').waitFor({ state: 'hidden' })
    await editor.click()
    await page.keyboard.type('近30天关键水文指标的变化趋势')
    await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
    await page.locator('[data-report-title="近30天水文监测指标趋势分析"]').waitFor({ state: 'visible', timeout: 30000 })
    assert.equal(await page.locator('.water-hazard-canvas svg').count(), 4)
    const chart = page.locator('[data-chart-key="inflow"] .water-hazard-canvas')
    const width = await chart.evaluate(element => element.clientWidth)
    await chart.hover({ position: { x: 120, y: 130 } })
    await page.mouse.wheel(0, -100)
    await page.setViewportSize({ width: 850, height: 1000 })
    await page.waitForFunction(previous => document.querySelector('[data-chart-key="inflow"] .water-hazard-canvas')?.clientWidth !== previous, width)
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-chart-key="inflow"] .water-hazard-canvas')
      return element && Number(element.querySelector('svg')?.getAttribute('width')) === element.clientWidth
    })
    await page.screenshot({ path: resolve(root, 'test-results/trend.png'), fullPage: true })
    await page.reload()
    await page.locator('[data-report-title="近30天水文监测指标趋势分析"]').waitFor({ state: 'visible', timeout: 20000 })
    assert.equal(await page.locator('.water-hazard-canvas svg').count(), 4)
    assert.deepEqual(errors, [])
  } catch (error) {
    await writeFile(resolve(root, 'test-results/browser-error.txt'), `${await page.locator('body').innerText()}\n${errors.join('\n')}`)
    await page.screenshot({ path: resolve(root, 'test-results/browser-error.png'), fullPage: true })
    throw error
  } finally {
    await browser.close()
    web.child.kill('SIGTERM')
    await fixture.close()
  }
})
