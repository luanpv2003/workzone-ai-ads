// Workzone monogram (original file from the Workzone brand hub: public/brand/workzone-monogram.svg).
// Do not redraw it with text or CSS; the brand rules require the original artwork.
export function BrandMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static SVG, no optimisation needed
    <img src="/brand/workzone-monogram.svg" alt="" width={size} height={size} className={`shrink-0 rounded-lg ${className}`} />
  );
}
