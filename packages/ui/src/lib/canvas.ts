export function canUseCanvas2d(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext?.("2d"));
  } catch {
    return false;
  }
}

export function buildSvgAreaPaths(
  coords: readonly { readonly x: number; readonly y: number }[],
  height: number,
): { readonly linePath: string; readonly areaPath: string } {
  const linePath = coords.map((pt, index) => `${index === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  const areaPath =
    first && last ? `${linePath} L${last.x.toFixed(1)},${height} L${first.x.toFixed(1)},${height} Z` : "";
  return { linePath, areaPath };
}
