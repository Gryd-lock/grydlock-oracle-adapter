import { Logger, noopLogger } from '../Logger';
import { Disposable, DisposableGroup } from './Disposable';

/** Lifecycle phase of an {@link OracleLifecycleManager}. */
export type LifecycleState = 'created' | 'initializing' | 'ready' | 'disposing' | 'disposed';

/** A resource the manager can report health for, beyond just being disposable. */
export interface HealthCheckable {
  /** Returns `true` if this resource considers itself healthy right now. Must not throw — a health check that can fail should catch its own errors and return `false`. */
  isHealthy(): boolean | Promise<boolean>;
}

function isHealthCheckable(value: unknown): value is HealthCheckable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<HealthCheckable>).isHealthy === 'function'
  );
}

/** Construction options for {@link OracleLifecycleManager}. */
export interface OracleLifecycleManagerOptions {
  /** Logger for init/health-check/disposal failures. Defaults to the no-op logger. */
  logger?: Logger;
}

/**
 * The single owner of a composed oracle stack's shared resources —
 * channels, durable stores, lease coordinators — so that "who initializes
 * this, who tears it down, in what order, and is it safe to call twice" has
 * one answer instead of being re-decided by every call site that happens to
 * compose these middlewares together (Epic requirement A).
 *
 * Ownership model: register every resource this stack itself created (via
 * {@link own}) exactly once, in acquisition order. `dispose()` tears
 * everything down in reverse order and is idempotent — safe to call from
 * multiple shutdown paths (a `beforeunload`/`onSuspend` handler *and* an
 * explicit caller) without double-closing anything, per `Disposable`'s
 * contract. A resource the caller supplied from outside (e.g. an injected
 * `BroadcastChannelLike`) must never be registered here — the manager only
 * ever owns what the stack itself constructed.
 */
export class OracleLifecycleManager implements Disposable {
  private readonly group = new DisposableGroup();
  private readonly healthCheckable: HealthCheckable[] = [];
  private readonly logger: Logger;
  private state: LifecycleState = 'created';
  private readyPromise: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;

  constructor(options: OracleLifecycleManagerOptions = {}) {
    this.logger = options.logger ?? noopLogger;
  }

  /** This manager's current {@link LifecycleState}. */
  getState(): LifecycleState {
    return this.state;
  }

  /**
   * Registers `resource` as owned by this manager: it will be disposed
   * (once, in reverse-registration order) when this manager is disposed,
   * and included in {@link isHealthy} if it implements
   * {@link HealthCheckable}. Returns `resource` unchanged, so registration
   * composes with construction: `const cache = lifecycle.own(withCache(...)(inner))`.
   */
  own<T extends Disposable>(resource: T): T {
    if (this.state === 'disposing' || this.state === 'disposed') {
      // A resource "acquired" after teardown has begun has no safe owner
      // left to hold it: dispose it immediately rather than registering it
      // into a group that's already torn down (or tearing down), matching
      // `DisposableGroup.add`'s own rule.
      void resource.dispose();
      return resource;
    }
    this.group.add(resource);
    if (isHealthCheckable(resource)) this.healthCheckable.push(resource);
    return resource;
  }

  /**
   * Runs `initFn` (typically the async parts of hydrating shared
   * resources) and marks this manager `'ready'` once it settles — or
   * `'disposed'`-via-failure if it throws, since a stack that failed to
   * initialize has no safe partially-ready state to sit in. Idempotent:
   * calling `init` again returns the same promise. `waitUntilReady` awaits
   * this same promise without re-running `initFn`.
   */
  async init(initFn: () => Promise<void> = async () => {}): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.state = 'initializing';
    this.readyPromise = (async () => {
      try {
        await initFn();
        this.state = 'ready';
      } catch (err) {
        this.logger.warn('OracleLifecycleManager.initFailed', { err });
        await this.dispose();
        throw err;
      }
    })();
    return this.readyPromise;
  }

  /** Awaits the promise `init()` started, without re-running its `initFn`. Throws immediately if `init()` was never called — there is nothing to wait on. */
  async waitUntilReady(): Promise<void> {
    if (!this.readyPromise) {
      throw new Error('OracleLifecycleManager: init() must be called before waitUntilReady()');
    }
    await this.readyPromise;
  }

  /** `true` only once every registered {@link HealthCheckable} resource reports healthy, and the manager itself is `'ready'`. A manager that never registered any health-checkable resource is healthy as soon as it's ready — there is nothing it knows how to consider unhealthy. */
  async isHealthy(): Promise<boolean> {
    if (this.state !== 'ready') return false;
    for (const resource of this.healthCheckable) {
      try {
        if (!(await resource.isHealthy())) return false;
      } catch (err) {
        this.logger.warn('OracleLifecycleManager.healthCheckThrew', { err });
        return false;
      }
    }
    return true;
  }

  /**
   * Idempotent: a second (or concurrent) call resolves once the first
   * call's teardown completes rather than starting a second teardown pass.
   * Disposes every owned resource in reverse-registration order, surfacing
   * the first failure (if any) only after every resource got a disposal
   * attempt — see {@link DisposableGroup}.
   */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    if (this.state === 'disposing') {
      await this.group.dispose().catch(() => undefined);
      return;
    }
    this.state = 'disposing';
    try {
      await this.group.dispose();
    } finally {
      this.state = 'disposed';
    }
  }
}
