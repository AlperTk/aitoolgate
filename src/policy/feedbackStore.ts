import type { SessionKey } from '../ports/domain';

/**
 * A feedback message queued for injection into a session's next request.
 *
 * Response-side actions (e.g. a `block`) queue one of these keyed by the session
 * key; it is then drained and appended on the NEXT request for that same session.
 */
export interface FeedbackMessage {
  /** Who the injected message should appear as. */
  role: 'user' | 'system';
  /** The message text to inject. */
  content: string;
}

/**
 * In-memory, per-session FIFO queue of feedback messages used for cross-request
 * intervention.
 *
 * Entries are keyed by the session-key FINGERPRINT (`SessionKey.fingerprint`),
 * so a {@link SessionKey} and the plain fingerprint string address the same
 * queue. Backed only by a single in-memory `Map`; there is no TTL or persistence.
 */
export class SessionFeedbackStore {
  private readonly entries = new Map<string, FeedbackMessage[]>();

  /** Append a message to the queue for `key` (FIFO; creates the queue if absent). */
  queue(key: string | SessionKey, message: FeedbackMessage): void {
    const fingerprint = this.fingerprintOf(key);
    let queue = this.entries.get(fingerprint);
    if (queue === undefined) {
      queue = [];
      this.entries.set(fingerprint, queue);
    }
    queue.push(message);
  }

  /** Return ALL queued messages for `key` in FIFO order and remove them (`[]` if none). */
  drain(key: string | SessionKey): FeedbackMessage[] {
    const fingerprint = this.fingerprintOf(key);
    const queued = this.entries.get(fingerprint);
    if (queued === undefined) {
      return [];
    }
    this.entries.delete(fingerprint);
    return queued;
  }

  /** Remove every queued entry for `key`. */
  clear(key: string | SessionKey): void {
    this.entries.delete(this.fingerprintOf(key));
  }

  /** True when at least one message is queued for `key`. */
  has(key: string | SessionKey): boolean {
    const queue = this.entries.get(this.fingerprintOf(key));
    return queue !== undefined && queue.length > 0;
  }

  /** Count of queued messages for one key, or across all keys when no key is given. */
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

  /** Remove every key (for tests / reset). */
  purgeAll(): void {
    this.entries.clear();
  }

  /** Resolve a key to its fingerprint string. */
  private fingerprintOf(key: string | SessionKey): string {
    return typeof key === 'string' ? key : key.fingerprint;
  }
}
