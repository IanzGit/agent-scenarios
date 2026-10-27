/** Harness 的报告末尾图表扩展；独立 bundle 随插件加载和卸载。 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { init, use, type EChartsCoreOption } from 'echarts/core'
import { LineChart, BarChart, PieChart, ScatterChart } from 'echarts/charts'
import { TitleComponent, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent, AriaComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { ChartCard } from './conversation.ts'

use([LineChart, BarChart, PieChart, ScatterChart, TitleComponent, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent, AriaComponent, SVGRenderer])

/** 一张图的实例、尺寸监听和主题监听均归组件生命周期所有。 */
export function InteractiveChart({ chart }: { chart: ChartCard }) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const instance = init(element, undefined, { renderer: 'svg' })
    const paint = () => {
      try {
        const color = getComputedStyle(element).color
        instance.setOption({ ...chart.option,
          darkMode: document.body.hasAttribute('data-ds-dark-theme'),
          textStyle: { color }, title: { ...(chart.option.title as object), textStyle: { color, fontSize: 15 } },
          legend: { ...(chart.option.legend as object), textStyle: { color } },
          ...chart.option.xAxis ? { xAxis: { ...(chart.option.xAxis as object), axisLabel: { color }, nameTextStyle: { color } } } : {},
          ...chart.option.yAxis ? { yAxis: { ...(chart.option.yAxis as object), axisLabel: { color }, nameTextStyle: { color } } } : {},
        } as EChartsCoreOption, { notMerge: true })
        setFailed(false)
      } catch { setFailed(true) }
    }
    paint()
    const resize = new ResizeObserver(() => { instance.resize() })
    resize.observe(element)
    const theme = new MutationObserver(paint)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    theme.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })
    return () => { theme.disconnect(); resize.disconnect(); instance.dispose() }
  }, [chart])
  return <figure className="agent-scenarios-chart" data-chart-id={chart.chart_id} data-chart-type={chart.chart_type}>
    <div ref={ref} className="agent-scenarios-chart-canvas" role="img" aria-label={chart.title} />
    <figcaption>{failed ? `图表显示失败：${chart.title}。` : chart.summary}</figcaption>
  </figure>
}

/** 读取当前轮独立的图表数据，不依赖会话仍在运行或来源缓存仍存在。 */
export function ReportCharts({ turn }: PropsRuntime<'conversation.chat.turnTail'>) {
  const source = turn.data.source('agent-scenarios-charts')
  const charts = useSyncExternalStore(source.subscribe, source.getSnapshot)
  if (!charts?.length) return null
  return <section className="agent-scenarios-charts" aria-label="分析图表">
    <h3>分析图表</h3>
    {charts.map(chart => <InteractiveChart key={chart.chart_id} chart={chart} />)}
  </section>
}

