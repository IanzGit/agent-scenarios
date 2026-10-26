/** 使用真实模型适配器检查网关请求参数及正文分流，不调用外部模型。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'

test('模型网关实际发送关闭思考的模板参数，最终报告进入正文', { timeout: 15000 }, async () => {
  const requests: Record<string, unknown>[] = []
  const report = '# 矿井水文监测总体分析\n\n设备共120套，在线5套，离线115套。'
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const kwargs = body.chat_template_kwargs as Record<string, unknown> | undefined
    // 复现网关行为：缺少关闭参数时，回答全部进入 reasoning_content。
    const field = kwargs?.enable_thinking === false ? 'content' : 'reasoning_content'
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { choices: [{ index: 0, delta: { role: 'assistant', [field]: report }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const ctx = new Context()
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const env = {
      WATER_HAZARD_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      WATER_HAZARD_MODEL_ID: 'qwen35-122b-a10b',
    }
    const patch: { id: string; config: PiAi.Options }[] = parse(
      await readFile(new URL('../../config/openai-compatible.patch.yml', import.meta.url), 'utf8'),
      { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (expression: string) => new Function('process', `return (${expression})`)({ env }) }] },
    )
    const config = patch.find(row => row.id === 'llm-pi-ai')?.config
    assert.ok(config?.providers?.['mine-gateway'])
    // 本地测试使用固定请求头，不读取开发者的真实凭据。
    config.providers['mine-gateway'].apiKeyEnv = undefined
    config.providers['mine-gateway'].headers = { Authorization: 'Bearer fixture-key' }
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(PiAi, config)
    const assembled = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'mine-gateway', model: env.WATER_HAZARD_MODEL_ID,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '输出矿井水害报告' }] })],
    })) assembled.push(chunk)

    assert.deepEqual(assembled.finish, { kind: 'stop' })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, env.WATER_HAZARD_MODEL_ID)
    assert.equal(requests[0].max_completion_tokens ?? requests[0].max_tokens, 32768)
    assert.deepEqual(requests[0].chat_template_kwargs, { enable_thinking: false })
    assert.equal(requests[0].enable_thinking, undefined)
    assert.deepEqual(assembled.message({ provider: 'mine-gateway', model: env.WATER_HAZARD_MODEL_ID }).content, [{ type: 'text', text: report }])
  } finally {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
