import { describe, expect, it, vi } from 'vitest';
import { Disposable, DisposableGroup, isDisposable } from '../../src/lifecycle/Disposable';

function fakeDisposable(): Disposable & { disposeCalls: number } {
  const obj = {
    disposeCalls: 0,
    dispose(): void {
      obj.disposeCalls++;
    },
  };
  return obj;
}

describe('isDisposable', () => {
  it('recognizes an object with a dispose() function', () => {
    expect(isDisposable(fakeDisposable())).toBe(true);
  });

  it('rejects primitives, null, and objects without dispose', () => {
    expect(isDisposable(null)).toBe(false);
    expect(isDisposable(undefined)).toBe(false);
    expect(isDisposable(42)).toBe(false);
    expect(isDisposable({})).toBe(false);
    expect(isDisposable({ dispose: 'not a function' })).toBe(false);
  });
});

describe('DisposableGroup', () => {
  it('disposes every member exactly once, in reverse registration order', async () => {
    const order: string[] = [];
    const group = new DisposableGroup();
    group.add({
      dispose: () => {
        order.push('first');
      },
    });
    group.add({
      dispose: () => {
        order.push('second');
      },
    });
    group.add({
      dispose: () => {
        order.push('third');
      },
    });

    await group.dispose();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('is idempotent: a second dispose() call does not re-dispose members', async () => {
    const member = fakeDisposable();
    const group = new DisposableGroup();
    group.add(member);

    await group.dispose();
    await group.dispose();
    await group.dispose();

    expect(member.disposeCalls).toBe(1);
  });

  it('disposes every member even if one throws, then surfaces the first failure', async () => {
    const order: string[] = [];
    const group = new DisposableGroup();
    group.add({
      dispose: () => {
        order.push('a');
      },
    });
    group.add({
      dispose: () => {
        order.push('b');
        throw new Error('boom');
      },
    });
    group.add({
      dispose: () => {
        order.push('c');
      },
    });

    await expect(group.dispose()).rejects.toThrow('boom');
    // Every member still got a disposal attempt despite the middle one throwing.
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('disposes a member added after the group is already disposed, immediately', async () => {
    const group = new DisposableGroup();
    await group.dispose();

    const lateMember = fakeDisposable();
    group.add(lateMember);

    expect(lateMember.disposeCalls).toBe(1);
  });

  it('never closes a resource this group does not own — dispose() only ever touches registered members', async () => {
    const notRegistered = fakeDisposable();
    const group = new DisposableGroup();
    group.add(fakeDisposable());

    await group.dispose();

    expect(notRegistered.disposeCalls).toBe(0);
  });

  it('supports an async dispose()', async () => {
    const spy = vi.fn(async () => {
      await Promise.resolve();
    });
    const group = new DisposableGroup();
    group.add({ dispose: spy });

    await group.dispose();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
