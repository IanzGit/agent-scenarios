/** Host 与 Client 共用的图表协议，不依赖任何业务场景。 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type ChartRow = Record<string, string | number | null>
export type ChartType = 'line' | 'bar' | 'pie' | 'stacked_bar' | 'scatter'
export type ChartColumn = { name: string; title?: string; type: 'category' | 'time' | 'number'; unit?: string }
export type ChartDataset = { id: string; title: string; columns: ChartColumn[]; rows: ChartRow[] }
export type ChartSource = { source_id: string; datasets: (Omit<ChartDataset, 'rows'> & { row_count: number })[] }
export type ChartSelection = {
  source_id: string
  dataset_id: string
  title: string
  x_field: string
  value_field: string
  series_field?: string
}
export type ChartOption = { [key: string]: Json }
export type ChartResult = {
  chart_id: string
  chart_type: ChartType
  title: string
  source_id: string
  dataset_id: string
  status: 'rendered' | 'no_data'
  summary: string
  option?: ChartOption
}
