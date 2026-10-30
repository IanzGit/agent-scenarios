/** 保留原三图、图例和钻孔布局，使用运行期网格生成 SVG 等值面。 */
import { contours } from 'd3-contour'
import { asset } from '../infrastructure/assets.ts'
import { WATER_LEVELS } from '../domain/constants.ts'
import type { StaticAnalysis, StaticMap } from '../domain/roof-static.ts'
import type { XY } from '../domain/kriging.ts'
import { documentHtml, escape } from './html.ts'

const colors = ['#139B48', '#58BA48', '#FFFF00', '#F26722', '#ED1F24']
function svgMap(workface: string, analysis: StaticAnalysis, map: StaticMap): string {
  const { grid } = map, xmin = grid.x[0], xmax = grid.x.at(-1)!, ymin = grid.y[0], ymax = grid.y.at(-1)!
  const scale = Math.min(576 / (xmax - xmin || 1), 456 / (ymax - ymin || 1))
  const ox = (600 - (xmax - xmin) * scale) / 2, oy = (480 - (ymax - ymin) * scale) / 2
  const coordinates = ([x, y]: number[]) => [ox + (x - xmin) * scale, oy + (ymax - y) * scale]
  const polygon = (points: XY[]) => points.map(point => coordinates(point).map(v => v.toFixed(3)).join(',')).join(' ')
  const zones = WATER_LEVELS[map.kind].map(([lo, hi, label], level) => ({ lo, hi, label, level })).sort((a, b) => a.lo - b.lo)
  const clip = `clip-${map.kind}`
  const parts = [`<svg class="map" viewBox="0 0 600 480" role="img" aria-label="${escape(workface + '工作面' + map.metric + '分区图')}"><defs><clipPath id="${clip}"><polygon points="${polygon(analysis.boundary)}" /></clipPath></defs><g clip-path="url(#${clip})">`,
    `<polygon points="${polygon(analysis.boundary)}" fill="${colors[zones[0].level]}" />`]
  const generator = contours().size([grid.x.length, grid.y.length])
  const values = grid.z.flat().map(value => value ?? NaN)
  const path = (ring: number[][]) => ring.map((p, i) => {
    const [x, y] = coordinates([xmin + (p[0] - 0.5) * (xmax - xmin) / 149, ymin + (p[1] - 0.5) * (ymax - ymin) / 149])
    return `${i ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`
  }).join(' ') + ' Z'
  const lines: { ring: number[][]; value: number }[] = []
  for (const zone of zones.slice(1)) {
    const geometry = generator.contour(values, zone.lo)
    parts.push(`<path class="zone" data-level="${zone.level}" fill="${colors[zone.level]}" fill-rule="evenodd" d="${geometry.coordinates.flatMap(polygon => polygon.map(path)).join(' ')}"><title>${escape(zone.label)}</title></path>`)
    for (const polygon of geometry.coordinates) for (const ring of polygon) lines.push({ ring, value: zone.lo })
  }
  for (const { ring } of lines) parts.push(`<path class="contours" d="${path(ring)}" />`)
  parts.push('</g>')
  const occupied: number[][] = [[10, 4, 56, 100], [432, 300, 596, 476]]
  const pointPositions = map.points.map(point => coordinates([point.x, point.y]))
  occupied.push(...pointPositions.map(([x, y]) => [x - 6, y - 6, x + 6, y + 6]))
  const [fx, fy] = coordinates(analysis.face.at(-1)!), fw = workface.length * 8 + 43
  const fl = Math.max(4, Math.min(596 - fw, fx + 8)), ft = Math.max(4, Math.min(458, fy - 26))
  occupied.push([fl, ft, fl + fw, ft + 18])
  const overlap = (box: number[]) => occupied.reduce((area, other) => area + Math.max(0, Math.min(box[2], other[2]) - Math.max(box[0], other[0])) * Math.max(0, Math.min(box[3], other[3]) - Math.max(box[1], other[1])), 0)
  for (const { ring, value } of lines) if (ring.length > 50) {
    const index = Math.floor(ring.length / 3), p = ring[index], next = ring[Math.min(index + 2, ring.length - 1)]
    const [x, y] = coordinates([xmin + (p[0] - 0.5) * (xmax - xmin) / 149, ymin + (p[1] - 0.5) * (ymax - ymin) / 149])
    const box = [x - 18, y - 7, x + 18, y + 7]
    if (!overlap(box)) {
      const angle = -Math.atan2(next[1] - p[1], next[0] - p[0]) * 180 / Math.PI
      parts.push(`<text class="contour-label" x="${x}" y="${y}" transform="rotate(${angle} ${x} ${y})">${value.toFixed(2)}</text>`); occupied.push(box)
    }
  }
  parts.push(`<polygon class="mine-boundary" points="${polygon(analysis.boundary)}" /><polygon class="workface-boundary" points="${polygon(analysis.face)}" /><text class="workface-label" x="${fl + 2}" y="${ft + 13}">${escape(workface)}工作面</text>`)
  map.points.forEach((point, i) => {
    const [x, y] = pointPositions[i], width = [...point.id].reduce((sum, char) => sum + (char.charCodeAt(0) < 128 ? 8 : 13), 4)
    const candidates = [8, 20, 32].flatMap(gap => [[x + gap, y - 18], [x + gap, y + 4], [x - width - gap, y - 18], [x - width - gap, y + 4], [x - width / 2, y - gap - 16], [x - width / 2, y + gap]])
      .map(([left, top]) => { left = Math.max(4, Math.min(596 - width, left)); top = Math.max(4, Math.min(460, top)); return [left, top, left + width, top + 16] })
    const box = candidates.sort((a, b) => overlap(a) - overlap(b))[0]; occupied.push(box)
    const ex = Math.min(box[2], Math.max(box[0], x)), ey = Math.min(box[3], Math.max(box[1], y))
    if (Math.hypot(ex - x, ey - y) > 12) parts.push(`<path class="borehole-leader" d="M${x},${y} L${ex},${ey}" />`)
    parts.push(`<circle class="borehole" cx="${x}" cy="${y}" r="4"><title>${escape(`钻孔 ${point.id}\n${map.metric}：${point.value}${map.unit}\n测点分级：${WATER_LEVELS[map.kind][point.level][2]}\nX：${point.x}\nY：${point.y}`)}</title></circle><text class="borehole-label" x="${box[0] + 2}" y="${box[1] + 8}">${escape(point.id)}</text>`)
  })
  parts.push('<g class="north" transform="translate(18 32) scale(2)"><text x="8" y="0" text-anchor="middle">N</text><path d="M8,9 L1,32 L8,26 L15,32 Z" /></g></svg>')
  return parts.join('')
}
export function roofMaps(workface: string, analysis: StaticAnalysis): string {
  const cards = analysis.maps.map(map => {
    const legend = WATER_LEVELS[map.kind].map(([, , label], i) => `<li><i style="background:${colors[i]}"></i><span>${escape(label)}</span></li>`).reverse().join('')
    return `<figure class="map-card"><div class="map-design"><div class="map-frame">${svgMap(workface, analysis, map)}<ul class="legend" aria-label="${map.title}图例">${legend}</ul></div><figcaption>${map.title}</figcaption></div></figure>`
  }).join('')
  return documentHtml(asset('roof_water_report.html').replaceAll('{{WORKFACE}}', escape(workface)).replace('{{MAP_CARDS}}', cards))
}
