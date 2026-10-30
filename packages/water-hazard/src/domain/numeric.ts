/** 原模型使用的舍入、线性方程和三参数有界稳健拟合。
 * TRF/soft-L1 adapted from SciPy; BSD-3-Clause, see ../../licenses/scipy.txt.
 */
export const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0)
export const norm = (a: number[]) => Math.sqrt(dot(a, a))
export const add = (a: number[], b: number[], scale = 1) => a.map((value, i) => value + b[i] * scale)
export const mul = (a: number[], b: number[]) => a.map((value, i) => value * b[i])

/** 对 IEEE754 实际值执行 Python round 的 ties-to-even，避免预警临界值改变。 */
export function round(value: number, digits = 0): number {
  if (!Number.isFinite(value) || value === 0) return value
  const bits = new DataView(new ArrayBuffer(8))
  bits.setFloat64(0, Math.abs(value))
  const raw = bits.getBigUint64(0), exponent = Number((raw >> 52n) & 2047n)
  let numerator = (raw & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n)
  const power = (exponent || 1) - 1023 - 52
  numerator *= 10n ** BigInt(digits)
  const denominator = power < 0 ? 1n << BigInt(-power) : 1n
  if (power > 0) numerator <<= BigInt(power)
  let integer = numerator / denominator
  const remainder = numerator % denominator
  if (2n * remainder > denominator || (2n * remainder === denominator && integer % 2n)) integer++
  return Math.sign(value) * Number(integer) / 10 ** digits
}

export function solve(matrix: number[][], target: number[]): number[] {
  const a = matrix.map((row, i) => [...row, target[i]])
  const n = a.length
  for (let i = 0; i < n; i++) {
    let pivot = i
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j
    if (Math.abs(a[pivot][i]) < 1e-20) throw new Error('插值矩阵奇异')
    ;[a[i], a[pivot]] = [a[pivot], a[i]]
    const divisor = a[i][i]
    for (let j = i; j <= n; j++) a[i][j] /= divisor
    for (let k = 0; k < n; k++) if (k !== i) {
      const factor = a[k][i]
      for (let j = i; j <= n; j++) a[k][j] -= factor * a[i][j]
    }
  }
  return a.map(row => row[n])
}

/** 单侧 Jacobi SVD，避免 JᵀJ 在近奇异拟合中丢失精度。 */
function svd(matrix: number[][]) {
  const n = matrix[0].length, a = matrix.map(row => [...row])
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Number(i === j)))
  for (let sweep = 0; sweep < 60; sweep++) {
    let changed = false
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const x = a.map(row => row[p]), y = a.map(row => row[q])
      const aa = dot(x, x), bb = dot(y, y), ab = dot(x, y)
      if (Math.abs(ab) <= Number.EPSILON * Math.sqrt(aa * bb)) continue
      changed = true
      const tau = (bb - aa) / (2 * ab), t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau))
      const c = 1 / Math.sqrt(1 + t * t), s = c * t
      for (const row of [...a, ...v]) { const left = row[p]; row[p] = c * left - s * row[q]; row[q] = s * left + c * row[q] }
    }
    if (!changed) break
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => norm(a.map(row => row[j])) - norm(a.map(row => row[i])))
  return { s: order.map(i => norm(a.map(row => row[i]))), v: order.map(i => v.map(row => row[i])), columns: order.map(i => a.map(row => row[i])) }
}

/** Trust-region reflective + soft-L1；范围、差分和终止条件与原模型相同。 */
export function boundedFit(fun: (x: number[]) => number[], initial: number[], upper: number[]): number[] {
  const n = initial.length, eps = Number.EPSILON
  let x = initial.map((value, i) => Math.min(upper[i] - 1e-10 * Math.max(1, upper[i]), Math.max(1e-10, value)))
  let raw = fun(x), alpha = 0, evaluations = 1
  const costOf = (f: number[]) => f.reduce((sum, value) => sum + Math.sqrt(1 + value * value) - 1, 0)
  let cost = costOf(raw), delta = 0
  for (let iteration = 0; evaluations < 300; iteration++) {
    const jac = raw.map(() => Array<number>(n).fill(0))
    for (let i = 0; i < n; i++) {
      let h = Math.sqrt(eps) * Math.max(1, Math.abs(x[i]))
      if (x[i] + h > upper[i]) h = x[i] - h >= 0 ? -h : (upper[i] - x[i] >= x[i] ? upper[i] - x[i] : -x[i])
      const point = [...x]; point[i] += h; h = point[i] - x[i]
      const f = fun(point)
      raw.forEach((value, row) => { jac[row][i] = (f[row] - value) / h })
    }
    const f = raw.map((value, i) => {
      const scale = Math.sqrt(Math.max(eps, (1 + value * value) ** -1.5))
      jac[i] = jac[i].map(item => item * scale)
      return value * (1 + value * value) ** -0.5 / scale
    })
    const g = x.map((_, i) => dot(jac.map(row => row[i]), f))
    const v = x.map((value, i) => g[i] < 0 ? upper[i] - value : g[i] > 0 ? value : 1)
    const dv = g.map(value => value < 0 ? -1 : value > 0 ? 1 : 0)
    const gnorm = Math.max(...g.map((value, i) => Math.abs(value * v[i])))
    if (gnorm < 1e-8) break
    if (!iteration) delta = norm(x.map((value, i) => value / Math.sqrt(v[i]))) || 1
    const d = v.map(Math.sqrt), gh = mul(g, d), diag = mul(g, dv)
    const jh = jac.map(row => mul(row, d))
    const augmented = [...jh, ...diag.map((value, i) => x.map((_, j) => i === j ? Math.sqrt(value) : 0))]
    const decomposition = svd(augmented)
    const s = decomposition.s, vectors = decomposition.v
    const uf = decomposition.columns.map((column, i) => dot(column, [...f, ...x.map(() => 0)]) / s[i])
    const suf = mul(s, uf)
    const transform = (values: number[]) => x.map((_, j) => values.reduce((sum, value, i) => sum + value * vectors[i][j], 0))
    const quadratic = (p: number[]) => 0.5 * (dot(jh.map(row => dot(row, p)), jh.map(row => dot(row, p))) + dot(diag, mul(p, p))) + dot(gh, p)
    const bound = (point: number[], step: number[]) => Math.min(...step.map((value, i) => value ? Math.max(-point[i] / value, (upper[i] - point[i]) / value) : Infinity))
    const minimize = (origin: number[], direction: number[], lo: number, hi: number) => {
      const projected = jh.map(row => dot(row, direction))
      const a = 0.5 * (dot(projected, projected) + dot(diag, mul(direction, direction)))
      const b = dot(gh, direction) + dot(jh.map(row => dot(row, origin)), projected) + dot(diag, mul(origin, direction))
      const stride = a > 0 ? Math.max(lo, Math.min(hi, -b / (2 * a))) : b < 0 ? hi : lo
      return add(origin, direction, stride)
    }
    let accepted = false
    while (evaluations < 300) {
      const fullRank = s[n - 1] > eps * raw.length * s[0]
      let ph = transform(uf.map((value, i) => -value / s[i]))
      if (!fullRank || norm(ph) > delta) {
        const phi = (a: number) => {
          const denominators = s.map(value => value * value + a)
          const length = norm(suf.map((value, i) => value / denominators[i]))
          return [length - delta, -suf.reduce((sum, value, i) => sum + value * value / denominators[i] ** 3, 0) / length]
        }
        let high = norm(suf) / delta, low = 0
        if (fullRank) { const [f0, derivative] = phi(0); low = -f0 / derivative }
        if (!fullRank && !alpha) alpha = Math.max(0.001 * high, Math.sqrt(low * high))
        for (let i = 0; i < 10; i++) {
          if (alpha < low || alpha > high) alpha = Math.max(0.001 * high, Math.sqrt(low * high))
          const [value, derivative] = phi(alpha)
          if (value < 0) high = alpha
          const ratio = value / derivative
          low = Math.max(low, alpha - ratio)
          alpha -= (value + delta) * ratio / delta
          if (Math.abs(value) < 0.01 * delta) break
        }
        ph = transform(suf.map((value, i) => -value / (s[i] * s[i] + alpha)))
        ph = ph.map(value => value * delta / norm(ph))
      } else alpha = 0
      let step = mul(d, ph)
      if (x.some((value, i) => value + step[i] < 0 || value + step[i] > upper[i])) {
        const stride = bound(x, step), theta = Math.max(0.995, 1 - gnorm)
        const reflected = ph.map((value, i) => Math.abs((step[i] > 0 ? upper[i] - x[i] : -x[i]) / step[i] - stride) < 1e-12 ? -value : value)
        const original = ph.map(value => value * stride)
        const atBound = add(x, mul(d, original))
        const a = dot(reflected, reflected), b = dot(original, reflected), c = dot(original, original) - delta * delta
        const toTrust = (-b + Math.sqrt(Math.max(0, b * b - a * c))) / a
        const toBound = bound(atBound, mul(d, reflected)), maxStride = Math.min(toTrust, toBound)
        const lo = maxStride > 0 ? (1 - theta) * stride / maxStride : 0
        const hi = maxStride === toBound ? theta * toBound : toTrust
        const candidates = [original.map(value => value * theta)]
        if (lo <= hi && maxStride > 0) candidates.push(minimize(original, reflected, lo, hi))
        const ag = gh.map(value => -value), agLimit = Math.min(delta / norm(ag), theta * bound(x, mul(d, ag)))
        candidates.push(minimize(x.map(() => 0), ag, 0, agLimit))
        ph = candidates.sort((a, b) => quadratic(a) - quadratic(b))[0]
        step = mul(d, ph)
      }
      const next = add(x, step).map((value, i) => Math.max(Number.MIN_VALUE, Math.min(upper[i] - eps * Math.max(upper[i], Number.MIN_VALUE), value)))
      const nextRaw = fun(next), nextCost = costOf(nextRaw)
      evaluations++
      const reduction = cost - nextCost, predicted = -quadratic(ph)
      const ratio = predicted > 0 ? reduction / predicted : predicted === reduction && reduction === 0 ? 1 : 0
      const stepLength = norm(ph), nextDelta = ratio < 0.25 ? 0.25 * stepLength : ratio > 0.75 && stepLength > 0.95 * delta ? 2 * delta : delta
      const stop = reduction < 1e-8 * cost && ratio > 0.25 || norm(step) < 1e-8 * (1e-8 + norm(x))
      if (reduction > 0) { x = next; raw = nextRaw; cost = nextCost; accepted = true }
      if (stop) return x
      alpha *= delta / nextDelta; delta = nextDelta
      if (accepted) break
    }
  }
  return x
}
