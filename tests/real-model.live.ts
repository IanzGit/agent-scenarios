/** 可选的真实模型与真实业务接口验收，不在默认无密钥测试中运行。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { resolve } from 'node:path'
import { resolveSettings } from '../src/water-hazard/config.ts'
import { root, launchBrowser, launchWeb } from './web-harness.ts'

const configured = Boolean(process.env.DEEPSEEK_API_KEY || (process.env.WATER_HAZARD_MODEL_API_KEY && process.env.WATER_HAZARD_MODEL_BASE_URL && process.env.WATER_HAZARD_MODEL_ID))
test('真实模型在 Harness Web 加载技能、调用真实业务并展示两类报告', { timeout: 240000, skip: configured ? false : '需配置 DeepSeek 或 OpenAI-compatible 模型凭据' }, async () => {
  const web = await launchWeb(resolveSettings().apiBaseUrl, true)
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  try {
    await page.goto(web.url)
    const notice = page.getByRole('button', { name: /^(Continue|继续)$/ })
    await notice.waitFor({ timeout: 15000 })
    await notice.click()
    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    await editor.click()
    await page.keyboard.type('当前矿井总体水害监测预警情况汇总分析')
    await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
    await page.locator('[data-report-title="预警报警统计"]').waitFor({ state: 'visible', timeout: 100000 })
    assert.equal(await page.locator('.water-hazard-report').count(), 4)
    await page.screenshot({ path: resolve(root, 'test-results/live-overview.png'), fullPage: true })
    await Promise.all([
      page.waitForResponse('**/api/session/create'),
      page.getByRole('button', { name: /new session|新会话/i }).first().click(),
    ])
    await page.locator('.water-hazard-results').waitFor({ state: 'hidden' })
    await editor.click()
    await page.keyboard.type('近30天关键水文指标的变化趋势')
    await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
    await page.locator('[data-report-title="近30天水文监测指标趋势分析"]').waitFor({ state: 'visible', timeout: 100000 })
    assert.equal(await page.locator('.water-hazard-canvas svg').count(), 4)
    await page.screenshot({ path: resolve(root, 'test-results/live-trend.png'), fullPage: true })
    const trace = z.array(z.object({ tool: z.string(), skill: z.string().optional(), isError: z.boolean() })).parse((await readFile(web.tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
    assert.ok(trace.every(item => !item.isError))
    assert.ok(trace.some(item => item.skill === 'water-hazard-overview'))
    assert.ok(trace.some(item => item.skill === 'water-hazard-trend'))
    assert.ok(trace.some(item => item.tool === 'get_hydrological_trend'))
  } catch (error) {
    await writeFile(resolve(root, 'test-results/live-error.txt'), await page.locator('body').innerText())
    throw error
  } finally { await browser.close(); web.child.kill('SIGTERM') }
})
