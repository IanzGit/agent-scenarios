import test from 'node:test'
import assert from 'node:assert/strict'
import { WaterHazardAPI } from '../src/infrastructure/api.ts'
import { resolveSettings } from '../src/config.ts'
import { mockBusiness } from '../../../tests/fixtures/water-hazard.ts'

test('仅网络和 HTTP 5xx 重试，业务错误、4xx 及非 JSON 立即失败', async () => {
  let attempts = 0
  const retrying = mockBusiness(() => ++attempts < 3 ? new Response('busy', { status: 503 }) : [])
  assert.deepEqual(await retrying.api.realtime(new AbortController().signal), [])
  assert.equal(attempts, 3)
  for (const response of [new Response('forbidden', { status: 403 }), Response.json({ code: 500, msg: '业务失败' }), new Response('<html>登录页</html>')]) {
    const fixture = mockBusiness(() => response)
    await assert.rejects(fixture.api.realtime(new AbortController().signal))
    assert.equal(fixture.requests.length, 1)
  }
  let calls = 0
  const network = mockBusiness(() => { if (calls++ === 0) throw new TypeError('network'); return [] })
  await network.api.realtime(new AbortController().signal)
  assert.equal(calls, 2)
})

test('预取消不发请求，在途取消传递到 fetch 且不触发重试', async () => {
  const controller = new AbortController()
  controller.abort()
  const fixture = mockBusiness(() => [])
  await assert.rejects(fixture.api.realtime(controller.signal))
  assert.equal(fixture.requests.length, 0)
  let calls = 0
  const active = new AbortController()
  const fetcher: typeof fetch = async (_url, init) => {
    calls++
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      active.abort(new Error('用户取消'))
    })
  }
  await assert.rejects(new WaterHazardAPI(resolveSettings({}, {}), fetcher).realtime(active.signal), /用户取消/)
  assert.equal(calls, 1)
})

test('读取响应体发生网络中断时按网络错误重试', async () => {
  let attempts = 0
  const fixture = mockBusiness(() => ++attempts === 1 ? new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('响应体连接中断')) },
  })) : [])
  assert.deepEqual(await fixture.api.realtime(new AbortController().signal), [])
  assert.equal(attempts, 2)
})

test('鉴权仅在 HTTP 头发送，不作为表单参数', async () => {
  const fixture = mockBusiness(() => [])
  fixture.api.settings.apiToken = 'fixture-token'
  await fixture.api.realtime(new AbortController().signal)
  assert.equal(new Headers(fixture.requests[0].init?.headers).get('Authorization'), 'Bearer fixture-token')
  assert.equal(String(fixture.requests[0].form).includes('fixture-token'), false)
})
