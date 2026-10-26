/** 与模型回答分开展示完整业务表格和交互图表。 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { init, use } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Chart, Report } from '../shared.ts'

use([BarChart, LineChart, PieChart, DataZoomComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer])
type Copy = { empty: string; chartFailure: string }

export function InteractiveChart({ chart, copy }: { chart: Chart; copy: Copy }) {
  const container = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!container.current || !chart.hasData) return
    const instance = init(container.current, undefined, { renderer: 'svg' })
    try { instance.setOption(chart.option) } catch {
      setFailed(true)
      instance.dispose()
      return
    }
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(container.current)
    return () => { observer.disconnect(); instance.dispose() }
  }, [chart])
  return <figure className="water-hazard-chart" data-chart-key={chart.key}>
    <figcaption>{chart.title}</figcaption>
    {!chart.hasData ? <p>{copy.empty}</p> : failed ? <p role="alert">{copy.chartFailure}</p> : <div ref={container} className="water-hazard-canvas" role="img" aria-label={chart.title} />}
  </figure>
}

export function ReportView({ report, copy }: { report: Report; copy: Copy }) {
  return <section className="water-hazard-report" data-report-title={report.title}>
    <h4>{report.title}</h4>
    {report.period && <p className="water-hazard-period">{report.period.start} — {report.period.end}</p>}
    {report.tables.map(table => <section key={table.key} className="water-hazard-table-section">
      <h5>{table.title}</h5>
      {table.rows.length === 0 ? <p>{copy.empty}</p> : <div className="water-hazard-table-scroll" tabIndex={0} role="region" aria-label={table.title}>
        <table><thead><tr>{table.columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>{table.columns.map(column => {
            const value = row[column]
            return <td key={column}>{value === null || value === undefined ? '—' : typeof value === 'number' ? String(Number(value.toFixed(2))) : value}</td>
          })}</tr>)}</tbody>
        </table>
      </div>}
    </section>)}
    <div className="water-hazard-charts">{report.charts.map(chart => <InteractiveChart key={chart.key} chart={chart} copy={copy} />)}</div>
  </section>
}

type ReportTailProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'coalMine'>

export function ReportTail({ turn, seq, t }: ReportTailProps) {
  const source = turn.data.source('water-hazard')
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const entries = snapshot?.entries.filter(entry => entry.seq <= (turn.end?.seq ?? seq)) ?? []
  if (!entries.length) return null
  const copy = { empty: t('empty'), chartFailure: t('chartFailure') }
  return <section className="water-hazard-results" aria-label={t('results')}>
    <h3>{t('results')}</h3>
    {entries.map(entry => entry.report ? <ReportView key={entry.callId} report={entry.report} copy={copy} /> : <p role="alert" key={entry.callId}>{t('failed')} ({entry.tool})：{entry.error}</p>)}
  </section>
}
