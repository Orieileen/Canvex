import { useEffect, useMemo, useState, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { request } from '@/utils/request'
import { useTranslation } from 'react-i18next'

type CountRow = { id: string; date: string; count: number }

// chartConfig depends on i18n; build inside component

export default function PublishedChart() {
  const { t, i18n } = useTranslation('dashboard')
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d')
  const [rows, setRows] = useState<CountRow[]>([])
  const [loading, setLoading] = useState(false)

  const chartConfig = useMemo(() => ({
    count: { label: t('overview.published.title'), color: 'var(--primary)' },
  }) satisfies ChartConfig, [t])

  const formatDateLabel = useCallback((value: string) => {
    const d = new Date(value)
    // Use current UI language for formatting
    return d.toLocaleDateString(i18n.language || 'en-US', { month: 'short', day: 'numeric' })
  }, [i18n.language])

  useEffect(() => {
    const today = new Date()
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
    const start = new Date(today)
    start.setDate(start.getDate() - days + 1)
    const startStr = start.toISOString().slice(0, 10)
    const endStr = today.toISOString().slice(0, 10)
    setLoading(true)
    request
      .get(`/api/v1/analytics/published-counts/`, { params: { start_date: startStr, end_date: endStr } })
      .then((res) => setRows((res.data as CountRow[]) || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [range])

  const chartData = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of rows) map.set(r.date, r.count)
    const today = new Date()
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
    const start = new Date(today)
    start.setDate(start.getDate() - days + 1)
    const out: { date: string; count: number }[] = []
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10)
      out.push({ date: key, count: map.get(key) ?? 0 })
    }
    return out
  }, [rows, range])

  return (
    <Card className="@container/card">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>{t('publishedChart.title')}</CardTitle>
          <CardDescription>{t('publishedChart.desc')}</CardDescription>
        </div>
        <ToggleGroup type="single" value={range} onValueChange={(v) => v && setRange(v as any)} variant="outline">
          <ToggleGroupItem value="7d">{t('publishedChart.range.7d')}</ToggleGroupItem>
          <ToggleGroupItem value="30d">{t('publishedChart.range.30d')}</ToggleGroupItem>
          <ToggleGroupItem value="90d">{t('publishedChart.range.90d')}</ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {loading ? (
          <div className="h-[250px] flex items-center justify-center text-muted-foreground">{t('publishedChart.loading')}</div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="fillCount" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-count)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-count)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={formatDateLabel} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={formatDateLabel} indicator="dot" />} />
              <Area dataKey="count" type="natural" fill="url(#fillCount)" stroke="var(--color-count)" />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
