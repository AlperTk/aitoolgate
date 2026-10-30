---
name: protocols
description: The protocols module (src/protocols): OpenAI Chat and Anthropic Messages protocol factories and protocol registry. Read when changing wire format encode/decode or adding a protocol.
---
# Module: protocols (`src/protocols/`)

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Coverage: partial — factory ranges and registry names only; protocol decode/encode bodies not read.

## Scope
- Owns: wire-format codecs for OpenAI Chat (`openai-chat/`) and Anthropic Messages (`anthropic-messages/`), protocol registration, protocol-aware client error bodies.
- Consumed by: `src/proxy/` through `CODECS` in `src/proxy/translate.ts`.

## Critical objects
| Symbol | Path | Responsibility |
|---|---|---|
| `Protocol` (port) | src/ports/protocol.ts | Contract all codecs implement |
| `createOpenAIChatProtocol` | src/protocols/openai-chat/protocol.ts | OpenAI Chat codec |
| `createAnthropicMessagesProtocol` | src/protocols/anthropic-messages/protocol.ts | Anthropic Messages codec |
| `protocolRegistration`, `WIRE_PROTOCOL_IDS`, `clientErrorBody`, `upstreamErrorMessage` | src/protocols/registry.ts | Registry and error body helpers |
| `CODECS` | src/proxy/translate.ts | Maps protocol ids to codecs for proxy use |

## Flow (from proxy)
Client body decoded to internal request → `reencodeRequest` to upstream protocol → response `convertResponse` back to client protocol when they differ. Helper names live in `src/proxy/translate.ts`.

## Change recipe — add a protocol
1. Implement `Protocol` under `src/protocols/<name>/`, modeled on the two existing factories.
2. Register in `src/protocols/registry.ts` and add a `CODECS` entry in `src/proxy/translate.ts`.
3. Add `WireProtocol` id in `src/ports/provider.ts` if providers must reference it.
4. Verify with cross-protocol tests (`tests/cross-protocol-*.test.ts`) and 13 `protocols-*.test.ts` files.

## Unknowns
- Exact decode/encode steps and streaming event mapping are not verified in this bootstrap.
- Whether every step in the recipe above is complete is unverified; confirm against `WIRE_PROTOCOL_IDS` usage before relying on it.
