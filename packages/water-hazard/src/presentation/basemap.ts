/** DXF JSON 图元转 SVG，坐标与原页面保持一致。 */
import { object, rows, numeric, text, type ApiRow } from '../infrastructure/api.ts'
import { escape } from './html.ts'
const number = (value: unknown) => Number(numeric(value, '底图数值').toPrecision(9))
export function basemapSvg(basemap: ApiRow): string {
  const elements = (items: ApiRow[]): string => items.map(item => {
    const stroke = 'vector-effect="non-scaling-stroke"'
    const point = (value: unknown) => object(value, '底图坐标')
    if (item.type === 'path') {
      const box = point(item.box), fill = item.isFill ? item.fillImgCode ? 'url(#basemap-hatch)' : '#d1d5db' : 'none'
      return `<path d="${escape(item.drawPath)}" transform="translate(${number(box.x)} ${number(box.y)})" fill="${fill}" ${stroke} />`
    }
    if (item.type === 'line') return `<polyline points="${rows(item.points, '底图折线').map(p => `${number(p.x)},${number(p.y)}`).join(' ')}" fill="none" ${stroke} />`
    if (item.type === 'circle' || item.type === 'point') return `<circle cx="${number(item.x)}" cy="${number(item.y)}" r="${number(item.radius ?? 1)}" fill="none" ${stroke} />`
    if (item.type === 'text' || item.type === 'textBox') {
      const p = point(item.point), size = numeric(item.fontSize, 'fontSize'), lines = text(item.text, '').split(/\r?\n/)
      const anchor: Record<string, string> = { left: 'start', center: 'middle', right: 'end' }
      const baseline: Record<string, string> = { top: 'text-before-edge', center: 'central', bottom: 'text-after-edge' }
      const y = String(item.originY ?? 'top'), offset = y === 'center' ? -(lines.length - 1) / 2 : y === 'bottom' ? 1 - lines.length : 0
      return `<text transform="translate(${number(p.x)} ${number(p.y)}) rotate(${-number(item.rotation ?? 0)}) scale(${number(item.scaleX ?? 1)} ${-number(item.scaleY ?? 1)})" style="font-size:${size}px" font-family="SimSun,serif" fill="#666" stroke="none" text-anchor="${anchor[String(item.originX ?? 'left')] ?? 'start'}" dominant-baseline="${baseline[y] ?? 'text-before-edge'}">${lines.map((line, i) => `<tspan x="0" y="${(offset + i) * size * 1.2}">${escape(line)}</tspan>`).join('')}</text>`
    }
    if (item.type === 'group') {
      const children = rows(item.item, '底图组合'), points = children.flatMap(child => rows(child.points, '组合折线')), p = point(item.point)
      if (!points.length) throw new Error('底图组合图元为空')
      const sx = number(item.scaleX ?? 1), sy = number(item.scaleY ?? 1)
      const x = number(p.x) - Math.min(...points.map(p => number(p.x))) * sx, y = number(p.y) - Math.max(...points.map(p => number(p.y))) * sy
      return `<g transform="translate(${x} ${y}) rotate(${-number(item.rotation ?? 0)}) scale(${sx} ${sy})">${elements(children)}</g>`
    }
    throw new Error(`底图包含不支持的图元类型：${String(item.type)}`)
  }).join('')
  return '<defs><pattern id="basemap-hatch" patternUnits="userSpaceOnUse" width="40" height="40" patternTransform="rotate(45)"><path d="M0 0 L0 40" stroke="#a0a7ae" stroke-width="6" /></pattern></defs>'
    + (basemap.layersData as unknown[]).map(layer => elements(rows(layer, '底图图层'))).join('')
}
