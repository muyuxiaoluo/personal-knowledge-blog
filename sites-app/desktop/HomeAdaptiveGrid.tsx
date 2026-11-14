import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Keep differently sized home cards in the same grid without stretching their content. */
export function HomeAdaptiveGrid({ children }: { children: ReactNode }) {
  const gridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let frame = 0;
    const observed = new Set<HTMLElement>();
    const resize = new ResizeObserver(schedule);
    function layout() {
      if (!grid) return;
      const styles = getComputedStyle(grid);
      const gap = Number.parseFloat(styles.rowGap);
      const unit = Number.parseFloat(styles.gridAutoRows);
      for (const tile of grid.querySelectorAll<HTMLElement>("[data-home-tile]")) {
        if (!observed.has(tile)) { observed.add(tile); resize.observe(tile); }
        const span = Math.ceil((tile.getBoundingClientRect().height + gap) / (unit + gap));
        const value = `span ${Math.max(1, span)}`;
        if (tile.style.gridRowEnd !== value) tile.style.gridRowEnd = value;
      }
      for (const tile of observed) {
        if (!grid.contains(tile)) { resize.unobserve(tile); observed.delete(tile); }
      }
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); }
    const changes = new MutationObserver(schedule);
    changes.observe(grid, { childList: true, subtree: true });
    resize.observe(grid);
    layout();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect(); };
  }, []);
  return <div className="home-adaptive-grid" ref={gridRef}>{children}</div>;
}
