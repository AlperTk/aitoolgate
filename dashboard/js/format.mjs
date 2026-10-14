/* ==========================================================================
 * aitoolgate dashboard — shared number / size formatting (leaf module).
 *
 * Pure, framework-free formatters shared by the stats panel (token stat
 * tiles + top-tools table) and the live view (per-row In/Out/Total token
 * columns + result-size column). Both render large values compactly instead
 * of raw integers:
 *
 *   formatCount(1100)    -> "1.1k"      formatCount(1500000) -> "1.5M"
 *   formatSize(1234560)  -> "1.2 MB"    formatSize(999)      -> "999 B"
 *
 * Shared rules (1000-based / decimal, so the two formatters stay consistent):
 *   - values below 1000 stay plain (count: "999"; size: "999 B");
 *   - a 1-decimal mantissa with a trailing ".0" stripped ("10k" not "10.0k",
 *     "1.5M" not "1.50M", "1.2 MB" not "1.20 MB");
 *   - no awkward "1000k" rollover: a mantissa that rounds to 1000 bumps up
 *     one unit (999.95M -> "1.0G").
 * The size formatter uses 1000-based (decimal) thresholds, so "1.2 MB" is the
 * decimal megabyte (1 000 000 bytes), not the binary mebibyte. Absent /
 * non-finite values render as '—' (mirroring dom.mjs's fmtOpt) so callers keep
 * their "no data yet" tooltip behavior.
 *
 * Leaf: no imports; safe to import anywhere.
 * ========================================================================== */

// Largest-first unit tables, entries are [scale, suffix]. Count suffixes are
// appended directly ("M"); size suffixes carry a leading space (" MB").
var COUNT_UNITS = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
var SIZE_UNITS = [[1e9, ' GB'], [1e6, ' MB'], [1e3, ' KB']];

// Compact `x` (>= 1000) into a 1-decimal mantissa + the suffix of the largest
// unit (largest-first `units`) whose rounded mantissa stays below 1000.
function compactUnit(x, units) {
  var unitIndex = units.length - 1;
  for (var i = 0; i < units.length; i += 1) {
    if (x >= units[i][0]) { unitIndex = i; break; }
  }
  // Avoid an awkward "1000k" / "1000M" rollover: if the 1-decimal mantissa
  // rounds to 1000 (e.g. 999.95M), move up one unit (becomes "1.0G").
  while (unitIndex > 0 && Math.round(x / units[unitIndex][0] * 10) / 10 >= 1000) {
    unitIndex -= 1;
  }
  var unit = units[unitIndex];
  var s = (Math.round(x / unit[0] * 10) / 10).toFixed(1);
  if (s.slice(-2) === '.0') s = s.slice(0, -2);
  return s + unit[1];
}

// Compact a token/char count (turn totals, per-tool token aggregates): a plain
// integer below 1000, else k/M/G/T with a 1-decimal mantissa.
export function formatCount(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '\u2014';
  var sign = n < 0 ? '-' : '';
  var x = Math.abs(n);
  if (x < 1000) return sign + String(Math.round(x));
  return sign + compactUnit(x, COUNT_UNITS);
}

// Compact a byte/char size: "… B" below 1 KB, else KB/MB/GB (1000-based) with
// a 1-decimal mantissa.
export function formatSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes)) return '\u2014';
  var sign = bytes < 0 ? '-' : '';
  var x = Math.abs(bytes);
  if (x < 1000) return sign + String(Math.round(x)) + ' B';
  return sign + compactUnit(x, SIZE_UNITS);
}
