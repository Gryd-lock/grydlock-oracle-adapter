import { BroadcastChannelLike } from '../../src/middleware/withRateLimit';

/**
 * Test double for `BroadcastChannel`, used to simulate multiple independent
 * JS contexts (issue #73) coordinating over a shared, adversarial,
 * asynchronous bus — without real timers, so simulations stay deterministic
 * and fast.
 *
 * Delivery is driven entirely by the test: `postMessage` only *enqueues* a
 * delivery (subject to configured loss/duplication and a randomized delay
 * that causes reordering); nothing is actually delivered to a listener until
 * the test calls {@link FakeBroadcastChannelBus.deliverUpTo} with the
 * current virtual time. This lets a simulation fully control both "what time
 * is it" and "what has arrived by now" independently of wall-clock time.
 */
export interface NetworkConditions {
  /** Probability, in [0, 1], that a given delivery to a given listener is dropped entirely. */
  lossRate?: number;
  /** Probability, in [0, 1], that a delivery that wasn't dropped is *also* delivered a second, independently-delayed time. */
  duplicateRate?: number;
  /** Each delivery's delay (added to the virtual send time) is uniform-random in `[0, maxReorderDelay]`. */
  maxReorderDelay?: number;
  /** Injectable RNG returning a value in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
}

interface QueuedDelivery {
  target: FakeBroadcastChannel;
  data: unknown;
  deliverAt: number;
}

export class FakeBroadcastChannelBus {
  private readonly membersByChannel = new Map<string, Set<FakeBroadcastChannel>>();
  private queue: QueuedDelivery[] = [];

  register(channelName: string, member: FakeBroadcastChannel): void {
    let members = this.membersByChannel.get(channelName);
    if (members === undefined) {
      members = new Set();
      this.membersByChannel.set(channelName, members);
    }
    members.add(member);
  }

  unregister(channelName: string, member: FakeBroadcastChannel): void {
    this.membersByChannel.get(channelName)?.delete(member);
  }

  /** Enqueues delivery of `data`, sent by `sender` at virtual time `now`, to
   * every other member of `channelName` (never back to the sender itself —
   * matching real `BroadcastChannel` semantics), subject to `conditions`. */
  publish(
    channelName: string,
    sender: FakeBroadcastChannel,
    data: unknown,
    now: number,
    conditions: NetworkConditions,
  ): void {
    const { lossRate = 0, duplicateRate = 0, maxReorderDelay = 0, random = Math.random } = conditions;
    const members = this.membersByChannel.get(channelName);
    if (members === undefined) return;

    for (const member of members) {
      if (member === sender) continue;
      this.maybeEnqueue(member, data, now, lossRate, maxReorderDelay, random);
      if (random() < duplicateRate) {
        // An independent second copy: its own loss/delay roll, but always
        // actually enqueued (a duplicate that's also dropped is just a drop).
        this.enqueue(member, data, now, maxReorderDelay, random);
      }
    }
  }

  private maybeEnqueue(
    target: FakeBroadcastChannel,
    data: unknown,
    now: number,
    lossRate: number,
    maxReorderDelay: number,
    random: () => number,
  ): void {
    if (random() < lossRate) return; // dropped: never enqueued
    this.enqueue(target, data, now, maxReorderDelay, random);
  }

  private enqueue(
    target: FakeBroadcastChannel,
    data: unknown,
    now: number,
    maxReorderDelay: number,
    random: () => number,
  ): void {
    const delay = maxReorderDelay > 0 ? Math.floor(random() * (maxReorderDelay + 1)) : 0;
    this.queue.push({ target, data, deliverAt: now + delay });
  }

  /** Delivers every currently-queued message whose `deliverAt <= t`, in
   * `deliverAt` order (ties broken by original enqueue order), leaving later
   * deliveries queued for a future call. Call with an ever-increasing `t` to
   * drive the simulation forward. */
  deliverUpTo(t: number): void {
    const due: QueuedDelivery[] = [];
    const remaining: QueuedDelivery[] = [];
    for (const item of this.queue) {
      (item.deliverAt <= t ? due : remaining).push(item);
    }
    due.sort((a, b) => a.deliverAt - b.deliverAt);
    this.queue = remaining;
    for (const item of due) item.target.deliver(item.data);
  }

  /** Drains every remaining queued message regardless of virtual time —
   * useful at the end of a simulation to settle any still-in-flight gossip. */
  flushAll(): void {
    if (this.queue.length === 0) return;
    const maxDeliverAt = Math.max(...this.queue.map((q) => q.deliverAt));
    this.deliverUpTo(maxDeliverAt);
  }
}

export class FakeBroadcastChannel implements BroadcastChannelLike {
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  constructor(
    private readonly bus: FakeBroadcastChannelBus,
    private readonly channelName: string,
    private readonly now: () => number,
    private readonly conditions: NetworkConditions = {},
  ) {
    this.bus.register(channelName, this);
  }

  postMessage(data: unknown): void {
    this.bus.publish(this.channelName, this, data, this.now(), this.conditions);
  }

  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.bus.unregister(this.channelName, this);
    this.listeners.clear();
  }

  /** @internal invoked by {@link FakeBroadcastChannelBus} on delivery. */
  deliver(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}
