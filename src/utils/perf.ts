interface PerfMetrics {
  httpTimings: Map<string, number[]>;
  queryCounts: Map<string, number>;
  reloadCounts: Map<string, number>;
  heartbeatCount: number;
  concurrentLoads: Map<string, number>;
}

const metrics: PerfMetrics = {
  httpTimings: new Map(),
  queryCounts: new Map(),
  reloadCounts: new Map(),
  heartbeatCount: 0,
  concurrentLoads: new Map(),
};

function getTimings(key: string): number[] {
  let arr = metrics.httpTimings.get(key);
  if (!arr) {
    arr = [];
    metrics.httpTimings.set(key, arr);
  }
  return arr;
}

export function recordHttpTiming(key: string, durationMs: number) {
  getTimings(key).push(durationMs);
}

export function recordQueryCount(key: string, count: number) {
  metrics.queryCounts.set(key, (metrics.queryCounts.get(key) ?? 0) + count);
}

export function recordReload(key: string) {
  metrics.reloadCounts.set(key, (metrics.reloadCounts.get(key) ?? 0) + 1);
}

export function recordHeartbeat() {
  metrics.heartbeatCount++;
}

export function recordConcurrentLoad(key: string) {
  metrics.concurrentLoads.set(key, (metrics.concurrentLoads.get(key) ?? 0) + 1);
}

export function getMetrics() {
  const summary: Record<string, any> = {};
  for (const [key, arr] of metrics.httpTimings) {
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    summary[key] = {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }
  return {
    httpTimings: summary,
    queryCounts: Object.fromEntries(metrics.queryCounts),
    reloadCounts: Object.fromEntries(metrics.reloadCounts),
    heartbeatCount: metrics.heartbeatCount,
    concurrentLoads: Object.fromEntries(metrics.concurrentLoads),
  };
}

export function resetMetrics() {
  metrics.httpTimings.clear();
  metrics.queryCounts.clear();
  metrics.reloadCounts.clear();
  metrics.heartbeatCount = 0;
  metrics.concurrentLoads.clear();
}

if (typeof window !== 'undefined') {
  (window as any).__PERF__ = { getMetrics, resetMetrics };
}