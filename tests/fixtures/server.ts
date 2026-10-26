/** 将固定业务响应暴露为只读 POST 接口，供 Harness 集成测试。 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { scenarioFixture } from './water-hazard.ts'

export async function startFixtureServer() {
  const fixture = scenarioFixture()
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const payload = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))
      const data = await fixture.api.post(request.url ?? '', payload, new AbortController().signal)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ code: 200, data }))
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ code: 500, msg: error instanceof Error ? error.message : String(error) }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server 未监听 TCP')
  return { url: `http://127.0.0.1:${address.port}`, requests: fixture.requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
