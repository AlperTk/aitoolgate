import { randomUUID } from 'node:crypto';
import type { DeviceFlow } from '../providers/auth/deviceOAuth';

/** A pending device-code login held server-side; the device_code never leaves the process. */
export interface PendingDeviceFlow extends DeviceFlow {
  readonly flowId: string;
  readonly expiresAt: number;
}

/** In-memory pending-flow map keyed by an opaque flow id; never throws. */
export interface DeviceFlowRegistry {
  /** Store a flow; returns its opaque id. */
  start(flow: DeviceFlow): string;
  /** The live (unexpired) flow for `flowId`, or `undefined`. */
  get(flowId: string): PendingDeviceFlow | undefined;
  /** Update the poll interval after a `slow_down`; `false` when the flow is unknown or expired. */
  setInterval(flowId: string, interval: number): boolean;
  /** Drop a flow; `true` when it existed. */
  delete(flowId: string): boolean;
  size(): number;
}

export interface DeviceFlowRegistryOptions {
  /** Clock in ms; defaults to Date.now. */
  now?: () => number;
  /** Opaque id generator; defaults to randomUUID. */
  createId?: () => string;
}

/** Create the pending-flow registry; expired flows are swept lazily on each access. */
export function createDeviceFlowRegistry(options: DeviceFlowRegistryOptions = {}): DeviceFlowRegistry {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const flows = new Map<string, PendingDeviceFlow>();

  function sweep(): void {
    const current = now();
    for (const [id, flow] of flows) {
      if (flow.expiresAt <= current) flows.delete(id);
    }
  }

  return {
    start(flow: DeviceFlow): string {
      sweep();
      const flowId = createId();
      flows.set(flowId, { ...flow, flowId, expiresAt: now() + flow.expiresIn * 1000 });
      return flowId;
    },

    get(flowId: string): PendingDeviceFlow | undefined {
      sweep();
      return flows.get(flowId);
    },

    setInterval(flowId: string, interval: number): boolean {
      sweep();
      const existing = flows.get(flowId);
      if (existing === undefined) return false;
      flows.set(flowId, { ...existing, interval });
      return true;
    },

    delete(flowId: string): boolean {
      return flows.delete(flowId);
    },

    size(): number {
      sweep();
      return flows.size;
    },
  };
}
