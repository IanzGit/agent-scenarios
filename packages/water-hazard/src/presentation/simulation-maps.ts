/** 原 SVG HTML 水淹动画与避灾路线图。 */
import type { HtmlDocument } from 'dsh-agent-charts'
import { asset } from '../infrastructure/assets.ts'
import { object, numeric, type ApiRow } from '../infrastructure/api.ts'
import { FLOODING_COLORS } from '../domain/constants.ts'
import type { Node, Roadway, Person, Route, FloodState } from '../domain/simulation.ts'
import { documentHtml, escape } from './html.ts'
import { basemapSvg } from './basemap.ts'

export type SimulationDrawing = {
  nodes: Node[]; roadways: Roadway[]; personnel: Person[]; routes: Route[]; source: Node; time: number; basemap: ApiRow
  states: Map<number, FloodState>; frames: { time: number; roadway_final_status: Record<string, { status: string }> }[]
}
const routeColors = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#999999', '#008b8b', '#5555aa']
function svgMap(data: SimulationDrawing, routes: boolean): string {
  const lookup = new Map(data.nodes.map(node => [node.id, node])), box = object(data.basemap.contentBox, '底图范围')
  const [xmin, ymin, width, height] = ['x', 'y', 'w', 'h'].map(key => numeric(box[key], key))
  const scale = Math.min(1060 / width, 530 / height), canvasWidth = Math.max(width * scale, 724) + 32, canvasHeight = height * scale + 168
  const ox = (canvasWidth - width * scale) / 2, oy = 104
  const xy = (x: number, y: number) => [ox + (x - xmin) * scale, oy + (ymin + height - y) * scale]
  const parts = [`<svg viewBox="0 0 ${canvasWidth} ${canvasHeight}" role="img" aria-labelledby="map-title"><title id="map-title">${routes ? '避灾路线图' : '井巷水淹仿真图'}</title><text id="simulation-time" x="${canvasWidth / 2}" y="28" text-anchor="middle">T+${data.time / 3600}h</text>`,
    `<g id="map-content"><defs><clipPath id="map-clip"><rect x="${ox}" y="${oy}" width="${width * scale}" height="${height * scale}" /></clipPath></defs><g clip-path="url(#map-clip)"><g class="basemap" transform="translate(${ox} ${oy + height * scale}) scale(${scale} ${-scale})" fill="none" stroke="#9ca3af" stroke-width="0.6">${basemapSvg(data.basemap)}</g></g><g class="roadways">`]
  for (const roadway of data.roadways) {
    const start = lookup.get(roadway.start), end = lookup.get(roadway.end)
    if (!start || !end) throw new Error(`巷道 ${roadway.id} 的端点坐标缺失`)
    const [x1, y1] = xy(start.x, start.y), [x2, y2] = xy(end.x, end.y), status = data.states.get(roadway.id)?.status ?? '正常'
    parts.push(`<line data-roadway-id="${roadway.id}" data-name="${escape(roadway.name)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${FLOODING_COLORS[status]}" stroke-width="${roadway.start === data.source.id || roadway.end === data.source.id ? 5 : 3}"><title>${escape(roadway.name)}：${status}</title></line>`)
  }
  parts.push('</g>')
  if (routes) data.routes.forEach((route, i) => {
    if (route.status !== '可撤离' || route.points.length < 2) return
    const color = routeColors[i % routeColors.length]
    parts.push(`<defs><marker id="arrow-${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${color}" /></marker></defs><polyline class="escape-route" points="${route.points.map(([x, y]) => xy(x, y).join(',')).join(' ')}" stroke="${color}" marker-end="url(#arrow-${i})"><title>${escape(`${route.person.name} → ${route.exit}；距离 ${route.distance.toFixed(1)}m；预计 ${route.estimated.toFixed(1)}min`)}</title></polyline>`)
  })
  const marker = (node: Node, kind: 'source' | 'exit', label: string) => {
    const [x, y] = xy(node.x, node.y), right = x > canvasWidth - 160
    parts.push(`<g class="${kind}" transform="translate(${x} ${y})"><path d="${kind === 'source' ? 'M0,-14 L4,-4 L15,-4 L6,3 L9,14 L0,7 L-9,14 L-6,3 L-15,-4 L-4,-4 Z' : 'M0,-12 L-11,9 L11,9 Z'}" /><title>${escape(label)}</title><text x="${right ? -16 : 16}" y="-12" text-anchor="${right ? 'end' : 'start'}">${escape(label)}</text></g>`)
  }
  marker(data.source, 'source', '突水点')
  data.nodes.filter(node => node.exit).forEach(node => marker(node, 'exit', node.name))
  data.personnel.forEach((person, i) => {
    const [x, y] = xy(person.x, person.y), right = x > canvasWidth - 160
    parts.push(`<g class="person" transform="translate(${x} ${y})"><circle r="7" /><title>${escape(person.name)}</title><text x="${right ? -12 : 12}" y="${20 + i % 3 * 18}" text-anchor="${right ? 'end' : 'start'}">${escape(person.name)}</text></g>`)
  })
  parts.push(`</g><g class="legend" transform="translate(${canvasWidth / 2 - 350} 54)"><rect x="-12" y="-22" width="724" height="38" rx="4" />`)
  Object.entries(FLOODING_COLORS).forEach(([status, color], i) => parts.push(`<line x1="${i * 120}" y1="0" x2="${i * 120 + 24}" y2="0" stroke="${color}" /><text x="${i * 120 + 36}" y="6">${status}</text>`))
  ;[['source', '★', '突水点'], ['exit', '▲', '逃生出口'], ['person', '●', '人员位置']].forEach(([kind, symbol, label], i) => parts.push(`<text class="${kind}" x="${(i + 3) * 120 + 4}" y="6">${symbol}</text><text x="${(i + 3) * 120 + 36}" y="6">${label}</text>`))
  parts.push('</g></svg>')
  return parts.join('')
}
export function simulationMaps(workface: string, data: SimulationDrawing): HtmlDocument[] {
  return ([['flooding', '井巷水淹仿真图', false], ['escape_routes', '避灾路线图', true]] as const).map(([id, title, routes]) => {
    const animation = JSON.stringify({ frames: routes ? [] : data.frames, colors: FLOODING_COLORS }).replaceAll('<', '\\u003c')
    const html = asset('inrush_simulation_report.html').replaceAll('{{TITLE}}', escape(`${workface}工作面 · ${title}`)).replaceAll('{{MAP_TITLE}}', title).replace('{{SVG}}', svgMap(data, routes)).replace('{{ANIMATION}}', animation)
    return { id, title: `${workface}工作面${title}`, html: documentHtml(html) }
  })
}
