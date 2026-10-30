/** 工具调用卡片复用的交互图表，独立管理 ECharts 实例。 */
import { useEffect, useRef, useState } from 'react'
import { init, use, type EChartsCoreOption } from 'echarts/core'
import { LineChart, BarChart, PieChart, ScatterChart } from 'echarts/charts'
import { TitleComponent, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent, AriaComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { ChartCard, NumericChartCard } from './chart-meta.ts'

use([LineChart, BarChart, PieChart, ScatterChart, TitleComponent, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent, AriaComponent, SVGRenderer])

/** 一张图的实例、尺寸监听和主题监听均归组件生命周期所有。 */
export function InteractiveChart({ chart }: { chart: ChartCard }) {
  return chart.chart_type === 'html' ? <HtmlChart chart={chart} /> : <NumericChart chart={chart} />
}

function HtmlChart({ chart }: { chart: Extract<ChartCard, { chart_type: 'html' }> }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(400)
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow || event.data?.type !== 'chart-document:height') return
      if (typeof event.data.height === 'number' && Number.isFinite(event.data.height)) setHeight(Math.max(80, Math.min(10000, event.data.height)))
    }
    window.addEventListener('message', receive)
    return () => { window.removeEventListener('message', receive) }
  }, [chart])
  return <figure className="agent-scenarios-chart" data-chart-id={chart.chart_id} data-chart-type="html">
    <iframe ref={ref} title={chart.title} sandbox="allow-scripts" srcDoc={chart.html}
      style={{ width: '100%', height, border: 0 }} />
    <figcaption>{chart.summary}</figcaption>
  </figure>
}

function NumericChart({ chart }: { chart: NumericChartCard }) {
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
