// A running request may finish after its effect has been cleaned up.
export function startSyncSchedule(sync: () => Promise<void>, delay: () => number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await sync(); } finally { schedule(); }
    }, delay());
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
