/** 球状变差模型的普通 Kriging；保持原 PyKrige 默认分箱和 soft-L1 拟合。 */
import { boundedFit, solve } from './numeric.ts'
import { setImmediate as yieldTurn } from 'node:timers/promises'

export type Point = { x: number; y: number; value: number }
export type XY = [number, number]
export type Grid = { x: number[]; y: number[]; z: (number | null)[][] }
const spherical = (distance: number, p: number[]) => distance <= p[1] ? p[0] * (1.5 * distance / p[1] - 0.5 * (distance / p[1]) ** 3) + p[2] : p[0] + p[2]

export function inside(x: number, y: number, polygon: XY[]): boolean {
  let found = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) found = !found
  }
  return found
}
export function fitVariogram(points: Point[]): number[] {
  const distances: number[] = [], variances: number[] = []
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    distances.push(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y))
    variances.push(0.5 * (points[i].value - points[j].value) ** 2)
  }
  const min = Math.min(...distances), max = Math.max(...distances), width = (max - min) / 6
  const lags: number[] = [], semivariances: number[] = []
  for (let bin = 0; bin < 6; bin++) {
    const selected = distances.map((d, i) => ({ d, v: variances[i] })).filter(({ d }) => d >= min + bin * width && d < (bin === 5 ? max + 0.001 : min + (bin + 1) * width))
    if (selected.length) {
      lags.push(selected.reduce((sum, item) => sum + item.d, 0) / selected.length)
      semivariances.push(selected.reduce((sum, item) => sum + item.v, 0) / selected.length)
    }
  }
  const highest = Math.max(...semivariances), lowest = Math.min(...semivariances), range = Math.max(...lags)
  if (!Number.isFinite(range) || highest <= 0) throw new Error('变差模型缺少有效变化')
  return boundedFit(p => lags.map((lag, i) => spherical(lag, p) - semivariances[i]), [highest - lowest, range * 0.25, lowest], [10 * highest, range, highest])
}
export async function interpolate(points: Point[], boundary: XY[], signal: AbortSignal): Promise<Grid> {
  if (!points.length) throw new Error('静态插值数据为空')
  const xmin = Math.min(...boundary.map(p => p[0])), xmax = Math.max(...boundary.map(p => p[0]))
  const ymin = Math.min(...boundary.map(p => p[1])), ymax = Math.max(...boundary.map(p => p[1]))
  const x = Array.from({ length: 150 }, (_, i) => xmin + (xmax - xmin) * i / 149)
  const y = Array.from({ length: 150 }, (_, i) => ymin + (ymax - ymin) * i / 149)
  let inverse: number[][] | undefined, parameters: number[] = []
  try {
    parameters = fitVariogram(points)
    const n = points.length
    const matrix = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) =>
      i === n && j === n ? 0 : i === n || j === n ? 1 : i === j ? 0 : -spherical(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y), parameters)))
    const columns = matrix.map((_, i) => solve(matrix, matrix.map((_, j) => Number(i === j))))
    inverse = matrix.map((_, i) => columns.map(column => column[i]))
  } catch { /* 与原系统一致：拟合或求解失败使用反距离平方插值。 */ }
  const z: Grid['z'] = []
  for (const gy of y) {
    signal.throwIfAborted()
    z.push(x.map(gx => {
      if (!inside(gx, gy, boundary)) return null
      const distances = points.map(p => Math.hypot(p.x - gx, p.y - gy))
      if (inverse) {
        const rhs = [...distances.map(d => d <= 1e-10 ? 0 : -spherical(d, parameters)), 1]
        return points.reduce((sum, p, i) => sum + p.value * inverse![i].reduce((v, coefficient, j) => v + coefficient * rhs[j], 0), 0)
      }
      const weights = distances.map(d => 1 / Math.max(0.01, d) ** 2)
      return points.reduce((sum, p, i) => sum + weights[i] * p.value, 0) / weights.reduce((sum, v) => sum + v, 0)
    }))
    await yieldTurn()
  }
  return { x, y, z }
}
