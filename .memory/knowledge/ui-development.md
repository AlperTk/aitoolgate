---
name: ui-development
description: Decision guide for dashboard UI module/component boundaries, reuse, extension patterns, and verification. Read before planning or implementing dashboard UI tasks.
---

# UI Development Guide

## Purpose and current architecture
The dashboard is a vanilla JavaScript ES-module UI served as static files. `dashboard/app.js` is its composition/wiring entry; `dashboard/js/*.mjs` hold feature behavior. This guide describes how to evolve that architecture without letting modules become catch-all files or introducing abstractions that are harder to maintain than the repetition they remove.

Use the existing architecture by default. Moving to React/Angular, adding a framework/build pipeline, changing module ownership boundaries across the app, or introducing a general UI framework is an architectural decision—not a routine cleanup. Recommend and obtain explicit approval before such a change.

## Vocabulary: module, component, shared abstraction
- **Module**: an ES module (`.mjs`) that owns a cohesive behavior or feature and exposes a narrow API. It is the default unit of organization.
- **UI component**: a cohesive, reusable UI unit with its own markup/rendering and narrowly defined inputs/actions. In the current vanilla UI it can simply be a function/module; do not create a framework-style component runtime.
- **Shared helper**: a stateless, broadly useful operation with stable semantics, placed in an existing helper module or a narrowly named helper module.
- **Base class/base page**: inheritance-based shared page workflow. This is not the default in this project. Consider it only if multiple pages have a genuinely identical lifecycle and extension points; prefer composition and explicit helper functions for shared mechanics.

## Decision guide: where does new UI code go?
1. **Same feature, same reason to change:** extend its owning module (e.g. rule behavior in `rules.mjs`, transport behavior in `transport.mjs`). Keep related state transitions together.
2. **Distinct responsibility or independent lifecycle:** create a focused feature module. Examples: a new dashboard view, a distinct settings pane, or a separately initialized editor. Have it expose a small `init*`/`bind*` API and wire it once from `app.js` after `mountLayout()`.
3. **Reusable visual region:** make a UI component when it has a clear boundary, can be rendered/updated independently, or appears in multiple contexts. Keep its inputs and emitted callbacks/events explicit. A one-off small fragment does not need its own module.
4. **Shared non-UI behavior:** extract a helper when the same meaningful behavior is used by at least two callers or has a single authoritative implementation requirement (for example escaping, formatting, time handling). Reuse existing `dom.mjs`, `format.mjs`, `time.mjs`, and `state.mjs` before creating another utility.
5. **Page-specific variation:** keep genuinely unique behavior local. Do not force superficially similar pages through a shared abstraction if their validation, data flow, or lifecycle differs.
6. **Cross-feature coordination:** do not create reverse imports or cycles. Keep imports one-way; wire coordination in `app.js` or expose a narrow operation from the owning feature. Avoid turning `state.mjs` into a dumping ground for feature-specific logic.

## Reuse strategy: prefer composition over base-page inheritance
The Angular base-page example is a useful signal to identify repeated workflows, but it does not imply that this project should introduce base classes. First identify what is truly invariant across screens, then extract in this order:

1. Existing DOM/format/time/state utility, if it already owns the behavior.
2. A small pure shared function for repeated logic (validation, mapping, serialization, or formatting) with explicit arguments/results.
3. A composed UI helper/component for repeated rendering and interaction, with explicit inputs and callbacks.
4. A feature-level coordinator only when multiple related components share one lifecycle.
5. A base class only as an exception: at least two or more real screens must share the same ordered lifecycle and stable override points; subclassing must remove meaningful duplication without hidden state, fragile call-order requirements, or many no-op overrides. Document the invariant and provide focused tests. Do not add a base class just because screens all list/add/edit/update data at a superficial level.

Shared code should have one owner. Page-specific behavior stays in the page/feature; extension should use explicit function parameters or narrow callbacks rather than copying and then overriding a whole workflow. Avoid speculative abstractions for future pages.

## Current dashboard ownership map
- `app.js`: composition and startup ordering only; mount layout before feature initialization/binding.
- `layout.mjs`: mount static layout fragments into shell slots.
- `transport.mjs`: WebSocket lifecycle, reconnect/keepalive, polling.
- `ingest.mjs`: event normalization/deduplication/routing into the UI.
- `live-view.mjs`: stream rows, filters, counters and intervention rendering. It already has broad responsibilities; before adding a distinct concern, extract that concern instead of growing the module.
- `rules.mjs` + `rule-schema.mjs`: rule editor/list operations and schema/field definitions. Keep policy/rule authoring logic out of stream transport/rendering where possible.
- `controls.mjs`: toolbar/control actions; `views.mjs`: view switching and view-level wiring.
- `settings.mjs` + `settings-providers.mjs`: settings and provider settings.
- `state.mjs`: shared runtime state only; `dom.mjs`, `format.mjs`, `time.mjs`: common primitives.

These are starting ownership boundaries, not immutable rules. If a concern is found in the wrong module during a requested change, move only what is needed while preserving callers and behavior.

## State, dependencies, and UI boundaries
- Keep feature modules independently understandable. Pass data/options where practical; use shared `state.mjs` only for state that is intentionally shared across features.
- A UI component should receive the data it needs and report user intent via callbacks/events rather than reaching into unrelated feature internals.
- Keep DOM construction and escaping consistent with existing `dom.mjs` helpers (`$`, `el`, `esc`, notices/form errors). Avoid unsafe HTML interpolation; escape untrusted or dynamic text through established helpers.
- Bind listeners in the owning feature/component and make setup idempotent where the existing startup may invoke it more than once. Keep listener cleanup/lifecycle explicit if dynamic mounting/removal is introduced.
- Do not let rendering helpers silently perform network requests or unrelated global state changes. Keep data acquisition/update and DOM rendering separable enough to test.
- Maintain a one-way dependency direction and avoid import cycles. In particular, current `live-view.mjs` imports rule operations; `rules.mjs` must not import `live-view.mjs`.

## When to split or extract
Split by cohesive responsibility and independent reason to change, not by arbitrary line count. Extraction is warranted when one or more observable signs appear:
- unrelated features require changes in the same file;
- a module has multiple independent initialization/lifecycle responsibilities;
- imports/exports or cross-feature coupling keep growing;
- a focused behavior is difficult to test without initializing unrelated UI;
- the same nontrivial logic is duplicated and changes must stay synchronized.

Keep related behavior together and avoid one-function-per-file fragmentation. For each extraction, preserve existing exports/callers where practical, move one concern at a time, and add/retain focused behavior tests.

## Testing and acceptance for UI changes
- Add or update a focused `tests/dashboard-*.test.ts` for observable UI behavior or interaction changes, using `node:test` and `node:assert/strict`.
- Load the real dashboard `.mjs` modules; use `tests/dom-stub.ts::createDomStub` / `FakeEl` for DOM-facing behavior and reset shared state in `beforeEach`.
- Test public behavior at the owning feature boundary: user action/event → state or DOM outcome. Test helpers separately only when they contain meaningful branching or invariants.
- For a new feature module, verify its setup/bind function is wired in `app.js` after layout mounting and does not duplicate initialization.
- Review for escaped dynamic content, import direction/cycles, unintended global state, and preserved behavior/callers.
- Standard command: `npm test` invokes the configured Node test runner; focused dashboard tests may be run by the project-supported equivalent identified in `knowledge/commands.md`.

## Task planning checklist
Before implementation, record briefly in the task plan:
1. User-visible behavior and owning feature/module.
2. Whether it is a module responsibility, reusable component, shared helper, or page-specific logic—and why.
3. Existing state/helpers/components to reuse; import direction and wiring point.
4. Shared behavior versus allowed page-specific variation; why inheritance is or is not appropriate.
5. Focused test(s) and acceptance outcome.
6. Any architectural/public-contract or dependency change; request approval if required.

## Evidence and limits
The current stack, entrypoint, module responsibilities, DOM test setup, and dashboard test pattern were inspected at snapshot `78cfbba5f3e552a858a3d41165ee9ee1c608aa0e` in the working tree; dashboard/test paths were tracked and matched HEAD. The repository-wide memory checkpoint remains at `9a2fbb5b684093c9197a81929d7741a91c9718ec`; this targeted UI guide does not claim a full memory synchronization. Base-page inheritance recommendations are design guidance for future work, not an observed existing project pattern.
