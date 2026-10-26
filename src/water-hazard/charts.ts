/** 在业务层确定性生成 ECharts 配置，浏览器只负责渲染。 */
import type { Chart, Json } from '../shared.ts'

export function countChart(key: string, title: string, kind: 'pie' | 'bar', data: { name: string; value: number }[]): Chart {
  const option: Record<string, Json> = {
    title: { text: title, left: 'center', textStyle: { fontSize: 15 } },
    tooltip: { trigger: kind === 'pie' ? 'item' : 'axis' },
    series: [{ name: '数量', type: kind, ...(kind === 'pie' ? { radius: ['25%', '60%'], center: ['50%', '45%'] } : {}), data: kind === 'pie' ? data : data.map(item => item.value) }],
  }
  if (kind === 'pie') option.legend = { type: 'scroll', bottom: 5 }
  else {
    option.grid = { left: 55, right: 20, bottom: 75, top: 50 }
    option.xAxis = { type: 'category', data: data.map(item => item.name), axisLabel: { rotate: 35 } }
    option.yAxis = { type: 'value', name: '事件数（条）', minInterval: 1 }
  }
  return { key, title, hasData: data.some(item => item.value > 0), option }
}

export function trendChart(key: string, title: string, metric: string, unit: string, dates: string[], values: (number | null)[]): Chart {
  const name = unit ? `${metric}(${unit})` : `${metric}（单位未提供）`
  return {
    key, title, hasData: values.some(value => value !== null),
    option: {
      title: { text: title, textStyle: { fontSize: 15 } }, tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', top: 30, data: [name] },
      grid: { top: 85, left: 80, right: 30, bottom: 80 },
      xAxis: { type: 'category', name: '日期', data: dates }, yAxis: { type: 'value', name, scale: true },
      dataZoom: [{ type: 'inside' }, { type: 'slider' }],
      series: [{ name, type: 'line', data: values, connectNulls: false, showSymbol: false,
        lineStyle: { color: '#1f77b4', type: 'solid' }, itemStyle: { color: '#1f77b4' } }],
    },
  }
}
