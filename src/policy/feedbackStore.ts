import type { SessionKey } from '../ports/domain';

/** A feedback message queued for injection; drained and appended on the NEXT request for the same session. */
export interface FeedbackMessage {
  role: 'user' | 'system';
  content: string;
}

/** In-memory, per-session FIFO feedback queue; entries are keyed by the session-key FINGERPRINT (so a {@link SessionKey} and the plain string address the same queue) and it has no TTL or persistence. */
export class SessionFeedbackStore {
  private readonly entries = new Map<string, FeedbackMessage[]>();

  queue(key: string | SessionKey, message: FeedbackMessage): void {
    const fingerprint = this.fingerprintOf(key);
    let queue = this.entries.get(fingerprint);
    if (queue === undefined) {
      queue = [];
      this.entries.set(fingerprint, queue);
    }
    queue.push(message);
  }

  drain(key: string | SessionKey): FeedbackMessage[] {
    const fingerprint = this.fingerprintOf(key);
    const queued = this.entries.get(fingerprint);
    if (queued === undefined) {
      return [];
    }
    this.entries.delete(fingerprint);
    return queued;
  }

  clear(key: string | SessionKey): void {
    this.entries.delete(this.fingerprintOf(key));
  }

  has(key: string | SessionKey): boolean {
    const queue = this.entries.get(this.fingerprintOf(key));
    return queue !== undefined && queue.length > 0;
  }

  size(key?: string | SessionKey): number {
    if (key === undefined) {
      let total = 0;
      for (const queue of this.entries.values()) {
        total += queue.length;
      }
      return total;
    }
    const queue = this.entries.get(this.fingerprintOf(key));
    return queue === undefined ? 0 : queue.length;
  }

  purgeAll(): void {
    this.entries.clear();
  }

  private fingerprintOf(key: string | SessionKey): string {
    return typeof key === 'string' ? key : key.fingerprint;
  }
}
