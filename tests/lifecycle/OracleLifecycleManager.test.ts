import { describe, expect, it } from 'vitest';
import { OracleLifecycleManager } from '../../src/lifecycle/OracleLifecycleManager';

function fakeDisposable() {
  let disposeCalls = 0;
  return {
    get disposeCalls() {
      return disposeCalls;
    },
    dispose: () => {
      disposeCalls++;
    },
  };
}

describe('OracleLifecycleManager', () => {
  it('starts in "created" state', () => {
    expect(new OracleLifecycleManager().getState()).toBe('created');
  });

  it('transitions created -> ready on a successful init()', async () => {
    const manager = new OracleLifecycleManager();
    await manager.init();
    expect(manager.getState()).toBe('ready');
  });

  it('waitUntilReady() resolves once init() completes', async () => {
    const manager = new OracleLifecycleManager();
    let resolveInit: () => void;
    const initPromise = new Promise<void>((r) => (resolveInit = r));
    const initCall = manager.init(() => initPromise);

    let ready = false;
    const waitPromise = manager.waitUntilReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    resolveInit!();
    await initCall;
    await waitPromise;
    expect(ready).toBe(true);
  });

  it('waitUntilReady() before init() throws rather than hanging forever', async () => {
    const manager = new OracleLifecycleManager();
    await expect(manager.waitUntilReady()).rejects.toThrow(/init\(\)/);
  });

  it('a failing init() disposes owned resources and moves to "disposed", then rethrows', async () => {
    const manager = new OracleLifecycleManager();
    const resource = manager.own(fakeDisposable());

    await expect(
      manager.init(async () => {
        throw new Error('init boom');
      }),
    ).rejects.toThrow('init boom');

    expect(manager.getState()).toBe('disposed');
    expect(resource.disposeCalls).toBe(1);
  });

  it('init() is idempotent: a second call returns the same settled result without re-running initFn', async () => {
    const manager = new OracleLifecycleManager();
    let calls = 0;
    await manager.init(async () => {
      calls++;
    });
    await manager.init(async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  it('own() registers a resource for teardown on dispose()', async () => {
    const manager = new OracleLifecycleManager();
    const resource = manager.own(fakeDisposable());
    await manager.dispose();
    expect(resource.disposeCalls).toBe(1);
  });

  it('dispose() is idempotent', async () => {
    const manager = new OracleLifecycleManager();
    const resource = manager.own(fakeDisposable());
    await manager.dispose();
    await manager.dispose();
    await manager.dispose();
    expect(resource.disposeCalls).toBe(1);
    expect(manager.getState()).toBe('disposed');
  });

  it('own() after dispose() disposes the resource immediately instead of leaking it', async () => {
    const manager = new OracleLifecycleManager();
    await manager.dispose();
    const lateResource = manager.own(fakeDisposable());
    expect(lateResource.disposeCalls).toBe(1);
  });

  it('isHealthy() is false before ready', async () => {
    const manager = new OracleLifecycleManager();
    expect(await manager.isHealthy()).toBe(false);
  });

  it('isHealthy() is true once ready with no health-checkable resources registered', async () => {
    const manager = new OracleLifecycleManager();
    await manager.init();
    expect(await manager.isHealthy()).toBe(true);
  });

  it('isHealthy() reflects a registered HealthCheckable resource', async () => {
    const manager = new OracleLifecycleManager();
    let healthy = true;
    manager.own({
      dispose: () => {},
      isHealthy: () => healthy,
    });
    await manager.init();

    expect(await manager.isHealthy()).toBe(true);
    healthy = false;
    expect(await manager.isHealthy()).toBe(false);
  });

  it('isHealthy() returns false, not throws, when a health check itself throws', async () => {
    const manager = new OracleLifecycleManager();
    manager.own({
      dispose: () => {},
      isHealthy: () => {
        throw new Error('health check exploded');
      },
    });
    await manager.init();

    await expect(manager.isHealthy()).resolves.toBe(false);
  });

  it('disposes owned resources in reverse-registration order', async () => {
    const order: string[] = [];
    const manager = new OracleLifecycleManager();
    manager.own({ dispose: () => order.push('a') });
    manager.own({ dispose: () => order.push('b') });
    await manager.dispose();
    expect(order).toEqual(['b', 'a']);
  });
});
