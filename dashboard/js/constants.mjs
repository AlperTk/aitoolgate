/* ==========================================================================
 * aitoolgate dashboard — tunable / config constants.
 *
 * Module-level tunables and pure constants shared across the foundation and
 * feature modules. Zero dependencies; safe to import anywhere. No imports.
 * ========================================================================== */

/* ---- tunables ------------------------------------------------------ */
export const MAX_LIST_ITEMS = 200;   // cap for the live + intervention lists
export const STATS_POLL_MS = 3000;   // fallback poll interval for /api/stats
export const WS_RECONNECT_MS = 1500; // retry delay after the socket closes
export const EVENTS_POLL_MS = 2500;     // polling interval for the /api/events fallback stream
export const WS_KEEPALIVE_MS = 10000;   // periodic keepalive text frame while the WS is open
export const WS_DEAD_AFTER_MS = WS_KEEPALIVE_MS * 3; // ~3 unanswered keepalive windows => dead
export const MAX_SEEN_EVENTS = 1000;    // cap on the dedup set of already-rendered event keys

// Tooltip shown on a stat value / table cell that is still empty ("—").
export const NO_DATA_TIP = 'No data yet \u2014 appears once tool results arrive.';

// Preset minute values for the quick time-range selector (window ends at selection time).
export const TIME_PRESETS = { '5m': 5, '15m': 15, '1h': 60 };
