/**
 * Popular = lifetime activity. Trending = recent activity compared with the
 * item's own baseline rate, so small-but-surging items can outrank big steady ones.
 *
 * growth = (recent - expected) / max(expected, 1), where expected is the baseline
 * rate scaled to the recent window. Score dampens tiny absolute numbers.
 */
export function trendScore(recent, baseline, windowMs, baselineMs) {
  const expected = (baseline * windowMs) / baselineMs;
  const growth = (recent - expected) / Math.max(expected, 1);
  const score = recent === 0 ? 0 : Math.log10(1 + recent) * Math.max(0, growth + 1);
  return { recent, expected: Math.round(expected * 10) / 10, growthPct: Math.round(growth * 100), score: Math.round(score * 1000) / 1000 };
}

export const WINDOWS = {
  '1h': 3600_000,
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 86400_000,
  '30d': 30 * 86400_000,
};
