# Browser design observation — mcp-manager dashboard (2026-10-07)

Source: live browser-agent observation (observation-only; screenshots saved by agent, paths below).

## URL & state
- `http://localhost:8787/#/` → "mcp-manager · tool-monitoring dashboard" (the dashboard). Second route `http://localhost:8787/#/rules` (Policy Rules) in same tab.
- State: CONNECTED / LIVE, fully populated. Header badge "Live stream connected · live". ~76 calls / 74 results, avg 3042 ms, 900,950 tokens (in 858,188 / out 42,762), 83 this-session, 59 interventions; 18-row top-tools table; 1 policy rule (hideTool → "hide test", matcher `always`). Not empty/disconnected.

## Layout / IA (top→down)
Header (H1 title + subtitle, nav [Dashboard | Policy Rules], live badge) → toolbar row (time-range select, "Clear on-screen history", Export ×4) → main:
1) "Live tool calls" filterable list/table [Status·Tool·Session·Time·Dur(ms)·In·Out·Total·Size]; rows expand to Arguments | Response | Details tab strip (Response lazily fetches api/tool-results/<id>).
2) "Counts & top tools": stat cards + per-tool sortable table ("Filter rows …/…").
3) "Intervention log": live feed (time + rule UUID + action e.g. hideTool + description).

## Screenshot artifacts
- dashboard-desktop-full.png (@1440, all sections + 3 expanded rows)
- rules-desktop-full.png (@1440, Policy Rules page)
- toolcall-detail-tabstrip.png (single expanded row's Arguments|Response|Details + JSON)
- dashboard-mobile-top.png / dashboard-mobile-table.png (@390px)

## Observed strengths
- Cohesive dark palette: bg #0d1117, panels #1c232e, accent #4c8dff, amber #d29922; semantic status tints (ok green, pending blue, error red); uniform 7px radius on inputs/buttons/cards; system-ui type; footnotes explaining columns and "—" cells.

## Observed issues (element-level)
- Weak section hierarchy: H2s (section titles) only 16px and muted grey #8b98a5 vs 15px light body — barely distinct; only H1 (20px) prominent.
- Terse column headers "In / Out / Total / Size / Dur (ms)" rely on fine-print footnote for meaning.
- Dense flat table (~80+ rows): minimal zebra/divider separation → hard to scan; many "—" cells look incomplete.
- Button inconsistency: "Clear on-screen history" uses danger-red text (255,155,148) while other controls neutral/accent; low-ish contrast of red on dark.
- Truncated session IDs (ses_ee8adf1a…) depend on hover-title for full value.
- Rules card redundancy: "Enabled" checkbox next to a separate "Enabled" text label; long rule-UUID footer is low-value noise.

## Responsive
- At 390px: header/nav + time-range/export controls wrap, BUT content width = 463px in a 375px viewport → horizontal scroll. 9-column "Live tool calls" table stays fixed-width → forces horizontal panning; some columns off-screen, numeric text small/cramped. Consistent with known CSS: responsive viewport-fit block only applies ≥961px, so sub-960px is under-optimized.
