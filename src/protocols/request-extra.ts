import type { InternalRequest, RequestExtra } from '../ports/llm';

type Obj = Record<string, unknown>;

/** Keeps wire fields the protocol does not model, tagged with the protocol id. */
export function captureRequestExtra(protocol: string, wire: Obj, modeled: readonly string[]): RequestExtra | undefined {
  const fields: Obj = {};
  for (const [key, value] of Object.entries(wire)) {
    if (value !== undefined && !modeled.includes(key)) fields[key] = value;
  }
  return Object.keys(fields).length > 0 ? { protocol, fields } : undefined;
}

/** Re-merges an opaque bag onto a wire node only for the same protocol; modeled keys are never overwritten or resurrected. */
export function mergeNodeExtra(extra: RequestExtra | undefined, protocol: string, wire: Obj, modeled: readonly string[]): void {
  if (extra?.protocol !== protocol) return;
  for (const [key, value] of Object.entries(extra.fields)) {
    if (!(key in wire) && !modeled.includes(key)) wire[key] = value;
  }
}

/** Request-level merge: the top-level bag of an InternalRequest. */
export function mergeRequestExtra(request: InternalRequest, protocol: string, wire: Obj, modeled: readonly string[]): void {
  mergeNodeExtra(request.extra, protocol, wire, modeled);
}
