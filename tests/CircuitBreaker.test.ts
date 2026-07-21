import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreakerOracle, CircuitBreakerState, CircuitBreakerConfig } from '../src/CircuitBreakerOracle';
import { RiskOracle } from '../src/RiskOracle';

class MockOracle implements RiskOracle {
  getScore = vi.fn<[string], Promise<number>>();
}

describe('CircuitBreakerOracle', () => {
  let mockOracle: MockOracle;
  let config: CircuitBreakerConfig;
  let circuitBreaker: CircuitBreakerOracle;

  beforeEach(() => {
    vi.useFakeTimers();
    mockOracle = new MockOracle();
    config = {
      failureThreshold: 3,
      cooldownWindow: 5000,
      isInfrastructureError: (error: any) => error.message === 'Network Error'
    };
    circuitBreaker = new CircuitBreakerOracle(mockOracle, config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in CLOSED state and passes calls to underlying oracle', async () => {
    mockOracle.getScore.mockResolvedValue(50);
    const score = await circuitBreaker.getScore('addr1');
    expect(score).toBe(50);
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
    expect(mockOracle.getScore).toHaveBeenCalledTimes(1);
  });

  it('transitions to OPEN after failureThreshold is reached', async () => {
    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));
    
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);
  });

  it('ignores non-infrastructure errors for state transitions', async () => {
    mockOracle.getScore.mockRejectedValue(new Error('Business Error'));
    
    for (let i = 0; i < 5; i++) {
      await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Business Error');
    }
    
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('transitions to HALF_OPEN after cooldownWindow', async () => {
    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));
    
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(circuitBreaker.getScore('addr1')).rejects.toThrow();
    }
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    // Call while OPEN fails fast
    mockOracle.getScore.mockClear();
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Circuit Breaker is OPEN');
    expect(mockOracle.getScore).not.toHaveBeenCalled();

    // Advance time
    vi.advanceTimersByTime(5000);

    // Next call should be HALF_OPEN and pass through
    mockOracle.getScore.mockResolvedValue(80);
    const score = await circuitBreaker.getScore('addr1');
    
    expect(score).toBe(80);
    expect(mockOracle.getScore).toHaveBeenCalledTimes(1);
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('transitions from HALF_OPEN back to OPEN if probe fails', async () => {
    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));
    
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(circuitBreaker.getScore('addr1')).rejects.toThrow();
    }
    
    // Advance time to allow probe
    vi.advanceTimersByTime(5000);

    // Probe fails
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    // Next call should fail fast again (new cooldown)
    mockOracle.getScore.mockClear();
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Circuit Breaker is OPEN');
    expect(mockOracle.getScore).not.toHaveBeenCalled();
  });

  it('uses fallback function when OPEN', async () => {
    circuitBreaker = new CircuitBreakerOracle(mockOracle, {
      ...config,
      fallback: async () => 99
    });

    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));
    for (let i = 0; i < 3; i++) {
      // First 3 calls actually reach the oracle and fail
      const result = await circuitBreaker.getScore('addr1');
      expect(result).toBe(99);
    }
    
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    // Subsequent call uses fallback without reaching oracle
    mockOracle.getScore.mockClear();
    const fallbackScore = await circuitBreaker.getScore('addr2');
    expect(fallbackScore).toBe(99);
    expect(mockOracle.getScore).not.toHaveBeenCalled();
  });

  it('throws fallback error when OPEN', async () => {
    const fallbackError = new Error('Custom Fallback Error');
    circuitBreaker = new CircuitBreakerOracle(mockOracle, {
      ...config,
      fallback: fallbackError
    });

    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));
    for (let i = 0; i < 2; i++) {
      await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Custom Fallback Error');
    }
    
    // 3rd failure trips the breaker
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Custom Fallback Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    // Subsequent call throws custom error fast
    mockOracle.getScore.mockClear();
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Custom Fallback Error');
    expect(mockOracle.getScore).not.toHaveBeenCalled();
  });
});
