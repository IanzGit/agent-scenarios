/** 原本地突水算法：50米分段、顺低高程填充、时刻淹没状态与 A* 避灾。 */
import { setImmediate as yieldTurn } from 'node:timers/promises'

export type Node = { id: number; x: number; y: number; z: number; name: string; exit: boolean }
export type Roadway = { id: number; start: number; end: number; name: string; width: number; height: number; closed: number }
export type Person = { id: number; name: string; x: number; y: number; z: number }
export type Segment = { id: number; original: number; start: number; end: number; length: number; width: number; height: number; closed: number }
export type Mesh = { nodes: Node[]; segments: Segment[] }
export type FloodEntry = { original: number; segment: number; start: number; end: number; time: number; accumulated: number; status: number; height: number }
export type FloodState = { status: '正常' | '半淹' | '全淹'; type: number; fraction: number }
export type Route = { person: Person; status: '可撤离' | '被困'; route: number[]; points: [number, number][]; exit: string; distance: number; estimated: number }
const distance = (a: Node | Person, b: Node | Person) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export async function generateMesh(nodes: Node[], roadways: Roadway[], signal: AbortSignal): Promise<Mesh> {
  const lookup = new Map(nodes.map(node => [node.id, node])), meshNodes = nodes.map(node => ({ ...node })), segments: Segment[] = []
  let nextNode = Math.max(...nodes.map(node => node.id)) + 1, nextSegment = nextNode - 1 + 100000
  for (const [index, roadway] of roadways.entries()) {
    if (index % 100 === 0) { await yieldTurn(); signal.throwIfAborted() }
    const start = lookup.get(roadway.start), end = lookup.get(roadway.end)
    if (!start || !end) continue
    const length = distance(start, end)
    if (length <= 0) continue
    const count = Math.max(1, Math.ceil(length / 50)), points = [start]
    for (let i = 1; i < count; i++) {
      const node = { id: nextNode++, x: start.x + (end.x - start.x) * i / count, y: start.y + (end.y - start.y) * i / count, z: start.z + (end.z - start.z) * i / count, name: '', exit: false }
      meshNodes.push(node); points.push(node)
    }
    points.push(end)
    for (let i = 0; i < count; i++) {
      const segment = { id: nextSegment++, original: roadway.id, start: points[i].id, end: points[i + 1].id, length: distance(points[i], points[i + 1]), width: roadway.width, height: roadway.height, closed: roadway.closed }
      segments.push(segment, { ...segment, id: nextSegment++, start: segment.end, end: segment.start })
    }
  }
  return { nodes: meshNodes, segments }
}
export async function flooding(mesh: Mesh, source: number, flow: number, signal: AbortSignal): Promise<FloodEntry[]> {
  if (flow <= 0) return []
  const lookup = new Map(mesh.nodes.map(node => [node.id, node]))
  const adjacent = new Map<number, number[]>()
  mesh.segments.forEach((segment, i) => { const edges = adjacent.get(segment.start) ?? []; edges.push(i); adjacent.set(segment.start, edges) })
  const visited = new Set<number>(), entries: FloodEntry[] = [], stack = [{ id: source, time: 0 }]
  let iterations = 0
  while (stack.length) {
    if (iterations++ % 100 === 0) { await yieldTurn(); signal.throwIfAborted() }
    const current = stack.at(-1)!
    const candidates = (adjacent.get(current.id) ?? []).filter(index => !visited.has(index) && mesh.segments[index].closed === 0)
      .sort((a, b) => lookup.get(mesh.segments[a].end)!.z - lookup.get(mesh.segments[b].end)!.z)
    if (!candidates.length) { stack.pop(); continue }
    const index = candidates[0], edge = mesh.segments[index]
    visited.add(index); visited.add(index % 2 === 0 ? index + 1 : index - 1)
    const width = edge.width > 0 ? edge.width : 3, height = edge.height > 0 ? edge.height : 2
    const wave = edge.length, arrival = current.time + wave, fill = width * height * edge.length / flow, finished = arrival + fill
    const base = { original: edge.original, segment: edge.id, start: edge.start, end: edge.end }
    if (arrival <= 720 * 3600) entries.push({ ...base, time: wave, accumulated: arrival, status: 0, height: Math.min(flow * wave / (width * edge.length), height) })
    if (finished <= 720 * 3600) entries.push({ ...base, time: fill, accumulated: finished, status: 1, height: 0 })
    stack.push({ id: edge.end, time: finished })
  }
  return entries
}
export function submerge(mesh: Mesh, entries: FloodEntry[], time: number): Map<number, FloodState> {
  const states = new Map<number, FloodState>()
  for (const entry of entries) if (entry.accumulated <= time) {
    // 原算法的波到达为 type=0，填充完成为 type=1；保持既有状态语义。
    const type = entry.status === 0 ? 0 : 1
    if (!states.has(entry.original) || type > states.get(entry.original)!.type) states.set(entry.original, { type, fraction: type ? 1 : Math.min(entry.height / 2, 1), status: type === 1 ? '半淹' : '正常' })
  }
  for (const edge of mesh.segments) if (!states.has(edge.original)) states.set(edge.original, { status: '正常', type: 0, fraction: 0 })
  return states
}

/** A* 队列按预估总代价、已行代价、节点ID排序，与原 heapq 的并列顺序一致。 */
class Queue {
  values: [number, number, number][] = []
  less(a: number[], b: number[]): boolean { return a[0] < b[0] || a[0] === b[0] && (a[1] < b[1] || a[1] === b[1] && a[2] < b[2]) }
  push(entry: [number, number, number]) {
    const values = this.values; values.push(entry)
    for (let i = values.length - 1; i > 0;) {
      const parent = (i - 1) >> 1
      if (!this.less(values[i], values[parent])) break
      ;[values[i], values[parent]] = [values[parent], values[i]]; i = parent
    }
  }
  pop(): [number, number, number] {
    const values = this.values, first = values[0], last = values.pop()!
    if (values.length) {
      values[0] = last
      for (let i = 0; ;) {
        let child = i * 2 + 1
        if (child >= values.length) break
        if (child + 1 < values.length && this.less(values[child + 1], values[child])) child++
        if (!this.less(values[child], values[i])) break
        ;[values[i], values[child]] = [values[child], values[i]]; i = child
      }
    }
    return first
  }
}
export async function escapeRoutes(mesh: Mesh, states: Map<number, FloodState>, personnel: Person[], nodes: Node[], signal: AbortSignal): Promise<Route[]> {
  const adjacent = new Map<number, { id: number; length: number }[]>()
  for (const edge of mesh.segments) if ((states.get(edge.original)?.type ?? 0) < 2) {
    for (const [start, end] of [[edge.start, edge.end], [edge.end, edge.start]]) {
      const edges = adjacent.get(start) ?? []; edges.push({ id: end, length: edge.length }); adjacent.set(start, edges)
    }
  }
  const lookup = new Map(mesh.nodes.map(node => [node.id, node])), originals = new Map(nodes.map(node => [node.id, node]))
  const exits = nodes.filter(node => node.exit), goals = new Map(exits.map(node => [node.id, node.name]))
  const heuristic = (id: number) => Math.min(...exits.map(exit => Math.hypot(lookup.get(id)!.x - exit.x, lookup.get(id)!.y - exit.y)))
  const routes: Route[] = []
  for (const person of personnel) {
    await yieldTurn(); signal.throwIfAborted()
    const start = mesh.nodes.reduce((best, node) => !best || Math.hypot(node.x - person.x, node.y - person.y) < Math.hypot(best.x - person.x, best.y - person.y) ? node : best, undefined as Node | undefined)
    let found: number | undefined
    const queue = new Queue(), costs = new Map<number, number>(), parents = new Map<number, number>()
    if (start) { queue.push([heuristic(start.id), 0, start.id]); costs.set(start.id, 0) }
    let iterations = 0
    while (queue.values.length) {
      if (iterations++ % 100 === 0) { await yieldTurn(); signal.throwIfAborted() }
      const [, cost, id] = queue.pop()
      if (cost > (costs.get(id) ?? Infinity)) continue
      if (goals.has(id)) { found = id; break }
      for (const neighbor of adjacent.get(id) ?? []) {
        const next = cost + neighbor.length
        if (next < (costs.get(neighbor.id) ?? Infinity)) { costs.set(neighbor.id, next); parents.set(neighbor.id, id); queue.push([next + heuristic(neighbor.id), next, neighbor.id]) }
      }
    }
    const route: number[] = []
    if (found !== undefined) {
      let id = found; route.push(id)
      while (parents.has(id)) { id = parents.get(id)!; route.push(id) }
      route.reverse()
    }
    const length = found === undefined ? 0 : costs.get(found)!
    routes.push({ person, route, points: route.flatMap(id => originals.has(id) ? [[originals.get(id)!.x, originals.get(id)!.y] as [number, number]] : []),
      status: found === undefined ? '被困' : '可撤离', exit: found === undefined ? '被困' : goals.get(found)!, distance: length, estimated: length > 0 ? length / 1000 / 5 * 60 : 0 })
  }
  return routes
}
