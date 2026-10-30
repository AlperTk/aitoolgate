---
name: policy
description: The policy module (src/policy) and session key derivation (src/session): rule engine ordering and matching, request/response policy phases, action dispatch, matchers, and per-session feedback. Read when changing rules, actions, matchers, or session keys.
---
# Module: policy (`src/policy/`) and session (`src/session/`)

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Coverage: partial — engine, stage, action map, matcher adapter, session derivation read; action and matcher factory bodies not read.

## Scope
- Policy owns: rule evaluation, ordering, matcher/action application, per-session feedback queue, intervention telemetry.
- Session owns: session-key derivation only (`src/session/session.ts`). Session state is held by the policy feedback store and the proxy session token.

## Critical objects
| Symbol | Path | Responsibility |
|---|---|---|
| `createPolicyStage` | src/policy/policyStage.ts | `PipelineStage`: request/response phases; holds last session key in closure |
| `createRuleEngine` | src/policy/ruleEngine.ts | Resolves rules each call, orders, matches, applies, collects effects |
| `orderByPriority` | src/policy/ruleEngine.ts | Filter enabled; sort by priority asc (missing = +Infinity); stable by index |
| `ACTION_STRATEGIES` | src/policy/actions/index.ts | Map by `ActionEffectKind`: `hideTool`, `rewriteArgs`, `injectMessage`, `addDescription` |
| `strategyFor` | src/policy/policyStage.ts | Dispatch by effect type |
| `toPortMatcher` | src/policy/matchers/index.ts | Adapts policy matcher to port matcher (true iff `matched === true`) |
| `SessionFeedbackStore` | src/policy/feedbackStore.ts | Per-session queue: queue, drain, has, size, clear, purgeAll |
| `deriveSessionKey` | src/session/session.ts | Key = normalized token if present; else hash of stable message prefix |

Matcher factories: `createToolNameMatcher`, `createArgPatternMatcher`, `createAlwaysMatcher`, `loopDetector` (`src/policy/matchers/*.ts`).

## Flow — request phase
1. `createPolicyStage.onRequest` drains feedback for the session and splices it into messages.
2. `createRuleEngine.evaluate` resolves rules, orders them, runs each matcher; matching rules yield action effects.
3. Request effects applied via `ACTION_STRATEGIES`; intervention telemetry emitted (`policy.intervention`).

## Flow — response phase
`onResponse` evaluates again; response effects are queued into `SessionFeedbackStore` for the next request of the same session.

## Change recipes
- **New action:** add kind to `ActionEffectKind` (`src/policy/types.ts`); factory in `src/policy/actions/<name>.ts`; entry in `ACTION_STRATEGIES` (compile-time enforced). Verify: `tests/add-description-action.test.ts`, `tests/e2e-actions.test.ts`.
- **New matcher:** factory returning `PolicyMatcher` in `src/policy/matchers/<name>.ts`; re-export in `src/policy/matchers/index.ts`; attached per rule object (no registry). Verify: `tests/policy-matchers.test.ts`.
- **Rules persistence/validation:** `tests/rule-store.test.ts`, `tests/rule-persistence.test.ts`, `tests/e2e-runtime-rules.test.ts`.

## Invariants / hot-path notes (observed)
- Flagship loop rule is spliced in at wiring and never persisted.
- `deriveSessionKey` hashes the stable message prefix on every request.
- `createRuleEngine.evaluate` resolves, copies, and sorts rules on each call; request and response each evaluate. No caching visible.

## Unknowns
- Whether `applyRequestEffect` / `applyResponseEffect` need new cases when adding an action — not read.
- Whether a rule validation path enumerates matcher types — not read (validation is per action in `src/api/ruleSpec.ts::validateSpec`).
- Action and matcher factory bodies beyond the summaries in `domain.md` — not read.

## Resolved
- Session token: set in `src/proxy/index.ts::createProxyHandler` (`tokenPipeline.setSessionToken(readStringHeader(...))`); the SessionKey is built in `src/proxy/context.ts::sessionKeyFromHeaders` via `buildRequestContext`.
- Request order: `deriveSessionKey` → `feedback.drain` → splice messages → `engine.evaluate` (`src/policy/policyStage.ts::createPolicyStage` `onRequest`).
- Session feedback clear/purgeAll: no separate runtime caller was identified in this bootstrap; treat as unused unless a test shows otherwise.
