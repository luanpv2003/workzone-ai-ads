"use client";

import { useT } from "@/i18n/client";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function DailyChart({ data, resultLabel, currency }: { data: { date: string; spend: number; results: number; cpr: number | null }[]; resultLabel: string; currency: string }) {
  const t = useT();
  const fmt = (v: number) => new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 }).format(v);
  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11, fill: "var(--mut)" }} tickLine={false} axisLine={false} />
          <YAxis yAxisId="l" tickFormatter={fmt} tick={{ fontSize: 11, fill: "var(--mut)" }} tickLine={false} axisLine={false} width={48} />
          <YAxis yAxisId="r" orientation="right" tickFormatter={fmt} tick={{ fontSize: 11, fill: "var(--mut)" }} tickLine={false} axisLine={false} width={48} />
          <Tooltip
            formatter={(v, name) => [typeof v === "number" ? new Intl.NumberFormat("vi-VN").format(Math.round(v)) + (name === resultLabel ? "" : ` ${currency}`) : v, name]}
            contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 8 }}
            labelStyle={{ color: "var(--ink)" }}
            itemStyle={{ color: "var(--ink2)" }}
            cursor={{ fill: "var(--hover)" }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span style={{ color: "var(--ink2)" }}>{v}</span>} />
          <Bar yAxisId="l" dataKey="spend" name={t("core.dailyChart.spend")} fill="var(--p300)" radius={[3, 3, 0, 0]} />
          <Line yAxisId="r" dataKey="cpr" name={t("core.dailyChart.cpr")} stroke="var(--b500)" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
