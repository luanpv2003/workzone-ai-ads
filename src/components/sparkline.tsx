/** Small trend line (static SVG) for client cards. */
export function Sparkline({ data, width = 96, height = 28, className = "text-indigo-500" }: { data: number[]; width?: number; height?: number; className?: string }) {
  if (data.length < 2 || !data.some((v) => v > 0)) return <span className="text-xs text-mut2">—</span>;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - 2 - ((v - min) / (max - min || 1)) * (height - 4)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
