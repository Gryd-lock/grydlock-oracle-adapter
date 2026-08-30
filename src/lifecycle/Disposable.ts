/**
 * Idempotent teardown contract for anything that owns a resource which
 * outlives a single call: a timer, an event listener, a channel, in-flight
 * work it started. `dispose()` must be safe to call more than once (a second
 * call is a no-op, not an error) and must never throw for "already
 * disposed" — callers that don't track disposal state themselves (a
 * lifecycle manager tearing down several owned resources, some of which may
 * already be gone) need to be able to call it unconditionally.
 *
 * Disposal only ever touches resources this object *owns*. A resource
 * supplied by the caller (e.g. an injected `BroadcastChannelLike`) is never
 * closed by `dispose()` — only resources this object created for itself.
 * Each disposable documents which of its own resources are and aren't
 * owned; see `middleware/withRateLimit.ts` and `middleware/withCache.ts` for
 * the concrete ownership rules that matter there.
 */
export interface Disposable {
  /** Idempotent: safe to call more than once. Never rejects for "already disposed". */
  dispose(): Promise<void> | void;
}

/** True when `value` implements {@link Disposable}. */
export function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<Disposable>).dispose === 'function'
  );
}

/**
 * Aggregates several independently-owned {@link Disposable}s behind one
 * idempotent `dispose()`. Disposing the group disposes every member exactly
 * once, in reverse registration order (last-acquired, first-released — the
 * usual resource-teardown convention), even if one member's `dispose()`
 * throws or rejects: every member still gets a disposal attempt, and the
 * group surfaces the *first* failure (if any) after all attempts complete
 * rather than aborting partway through and leaking the rest.
 */
export class DisposableGroup implements Disposable {
  private readonly members: Disposable[] = [];
  private disposed = false;

  /** Registers `member` for teardown when this group is disposed. A member added after the group has already been disposed is disposed immediately. */
  add<T extends Disposable>(member: T): T {
    if (this.disposed) {
      void member.dispose();
      return member;
    }
    this.members.push(member);
    return member;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const owned = this.members.splice(0).reverse();
    let firstError: unknown;
    for (const member of owned) {
      try {
        await member.dispose();
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
