---
name: domain
description: Domain terminology, core entities, matcher and action semantics, business rules, and state invariants of aitoolgate. Read when naming things, changing rule/provider behavior, or reasoning about what a rule or provider means.
---
# Domain model

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Owners are the source symbols listed; this file defines meaning, the module docs define flows.

## Glossary
| Term | Meaning | Anchor |
|---|---|---|
| Rule | Enabled flag + priority + matcher + action + description. Lower priority runs first. | `src/ports/domain.ts::Rule` |
| Matcher | Predicate that returns a `Match` (`{matched, reason, details?}`) or null | `src/ports/strategy.ts::Matcher`, `src/policy/types.ts::PolicyMatcher` |
| Action | Named behavior applied to request/response; carries an effect | `src/ports/strategy.ts::Action`, `src/policy/types.ts::ActionStrategy` |
| Effect kind | Discriminant of action effects: `hideTool`, `rewriteArgs`, `injectMessage`, `addDescription` | `src/policy/types.ts::ActionEffectKind` |
| SessionKey | `{fingerprint, token?}` identifying a conversation for feedback queueing | `src/ports/domain.ts::SessionKey` |
| Provider (ApiProvider) | Upstream configuration row; at most one is active | `src/api/providerStore.ts::createApiProviderStore` |
| Flagship loop rule | Built-in rule id `flagship-loop-rule`; spliced in at wiring, never persisted | `src/policy/ruleEngine.ts`, `src/api/persistentRuleStore.ts` |
| Feedback message | Response-side effect queued per session and spliced into the next request | `src/policy/feedbackStore.ts::SessionFeedbackStore` |
| Intervention | Telemetry record that a rule's action fired (`policy.intervention`) | `src/telemetry/events.ts::InterventionEvent` |
| Turn usage | Per-turn token counts, reported or estimated (`turn.usage`) | `src/telemetry/events.ts::TurnUsageEvent` |

## Entities
| Entity | Key fields | Owner |
|---|---|---|
| ToolCall | id, name, arguments | `src/ports/domain.ts::ToolCall` |
| ToolResult | toolCallId, name, isError, content | `src/ports/domain.ts::ToolResult` |
| ModelConfig | id, baseUrl, model, apiKey? | `src/ports/domain.ts::ModelConfig` |
| ClientConfig | apiKey, name, model (default route) | `src/ports/domain.ts::ClientConfig` |
| Rule | id, enabled, priority, matcher, action, description | `src/ports/domain.ts::Rule` |
| PolicyEvent | id, at, type, sessionKey?, ruleId?, payload | `src/ports/domain.ts::PolicyEvent` |
| RuleContext | sessionKey, client, messages, toolSchemas, toolCalls, toolResults | `src/policy/types.ts::RuleContext` |
| ToolSchema | name, description?, parameters? | `src/policy/types.ts::ToolSchema` |
| PolicyContext | union of request, response, and result contexts | `src/ports/strategy.ts::PolicyContext` |
| Provider | id, name, baseUrl, model, apiKey, adapterId, protocol (derived from adapterId), authType, authState, isActive, createdAt | `src/api/providerStore.ts`, `src/api/persistentProviderStore.ts` |
| Telemetry event | `tool.call`, `tool.result`, `policy.intervention`, `turn.usage` | `src/telemetry/events.ts::TelemetryEvent` |

### Matcher kinds (`src/policy/matchers/`)
- **toolName** — fires when a configured name appears in response `toolCalls`, assistant `tool_calls` in messages, or request `raw.tools` (OpenAI `function.name` / Anthropic `name`). No names configured → never fires.
- **argPattern** — regex (string converted to RegExp; case-sensitive) tested on serialized arguments of each call, optionally restricted by tool name(s).
- **always** — always matches.
- **loopDetector** — window default 4; `requireConsecutive` default true; identity default `normalized`; signature = name + params + result. Stateless across turns. Shown as `loop` in README.

### Action kinds (`src/policy/actions/`)
- **hideTool** — request: removes matching tool definitions from `raw.tools` and strips matching `tool_calls` / tool-result references from messages; supports `!` allow-list and `*` globs. Response: no-op. Preserves the messages reference when nothing matches (`stripHiddenToolReferences`).
- **rewriteArgs** — targets by `toolCallId`, else first name match; mode `replace` (default) or `merge`. Request rewrites the assistant tool call arguments; response rewrites `ctx.toolCalls`.
- **injectMessage** — role `user` (default) or `system`. Request: spliced after the leading system prefix and before the trailing user turn. Response: queued to the session feedback store for the next request.
- **addDescription** — uses `match.details.matchedToolNames`; request sets description on matched tool definitions (OpenAI `function.description` or Anthropic top-level). Response: no-op.

## Business rules
| Rule | Condition | Anchor |
|---|---|---|
| Rule spec requires boolean `enabled` | validation | `src/api/ruleSpec.ts::validateSpec` |
| Rule spec requires matcher and action passing their validators | validation | `src/api/ruleSpec.ts::validateSpec` |
| Optional id/priority/description must have the right types when provided | validation | `src/api/ruleSpec.ts::validateSpec` |
| Rule id = spec id if non-empty string, else random UUID | id assignment | `src/api/ruleSpec.ts`, `src/api/crudStore.ts::assignId` |
| Rule update is a shallow merge; matcher/action replaced only when defined; id change moves the entry | update | `src/api/ruleStore.ts::createRuleStore.update` |
| Provider defaults: `authType` = `apiKey`, `isActive` = false, protocol derived from `adapterId` (client-supplied protocol ignored) | defaults | `src/api/providerStore.ts::createApiProviderStore.toStored` |
| First stored provider becomes active | auto-activation | `src/api/providerStore.ts::createApiProviderStore.afterStore` |
| Removing the active provider promotes the lowest-sorted remaining id | removal | `src/api/providerStore.ts::createApiProviderStore.remove` |
| Empty provider table + seed fallback → one persisted auto-active row | startup seed | `src/api/persistentProviderStore.ts::createPersistentProviderStore` |
| Action spec validation: hideTool needs non-empty string array `toolNames`; rewriteArgs needs object `arguments`; injectMessage needs string `content`; addDescription needs string `description` | validation | `src/policy/actions/*.ts` (`validateSpec` / `buildSpec`) |

## Invariants
| Invariant | Anchor | Basis |
|---|---|---|
| At most one active provider | `src/api/providerStore.ts` (`markActive` clears all then sets one; `reconcileSingleActive` keeps one) | code |
| Rules evaluated in priority order (lower first, stable by index, missing priority last) | `src/policy/ruleEngine.ts::orderByPriority`; `src/ports/domain.ts::Rule` | code, doc |
| Flagship rule is not persisted and is skipped on rehydrate | `src/api/persistentRuleStore.ts` (`persistId`, `seedFromDb`) | code |
| Store reads return copies (callers cannot mutate stored rules) | `src/api/ruleStore.ts` | code |
| Matchers are stateless between turns | `src/policy/matchers/always.ts`, `loopDetector.ts` | code |
| Pending feedback is drained before rule evaluation on each request | `src/policy/policyStage.ts::createPolicyStage` `onRequest` (drain → splice → evaluate) | code |
| Telemetry failures do not affect the client response | `src/telemetry/event-bus.ts::createEventBus`; README | code, doc |

## Unknowns
- Whether the rule API rejects writes to `flagship-loop-rule` (`ruleSpec.ts::describeRule` special-cases it; no rejection observed).
- `markActive` invariant is inferred from its body and call sites; no dedicated test name was checked.
