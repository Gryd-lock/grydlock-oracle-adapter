import { RiskOracle } from './RiskOracle';

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownWindow: number;
  fallback?: ((destination: string) => Promise<number>) | Error;
  isInfrastructureError?: (error: unknown) => boolean;
}

export function defaultIsInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { message, name: errorName } = error as { message?: string; name?: string };
  const msg = (message || '').toLowerCase();
  const name = (errorName || '').toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('rpc') ||
    name.includes('timeouterror') ||
    name.includes('networkerror')
  );
}

export class CircuitBreakerOracle implements RiskOracle {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failures: number = 0;
  private nextAttempt: number = 0;
  private readonly isInfraError: (error: unknown) => boolean;

  constructor(
    private readonly oracle: RiskOracle,
    private readonly config: CircuitBreakerConfig
  ) {
    this.isInfraError = config.isInfrastructureError || defaultIsInfrastructureError;
  }

  public getState(): CircuitBreakerState {
    return this.state;
  }

  public async getScore(destination: string): Promise<number> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() >= this.nextAttempt) {
        this.state = CircuitBreakerState.HALF_OPEN;
      } else {
        return this.handleFallback(destination);
      }
    }

    try {
      const score = await this.oracle.getScore(destination);
      
      if (this.state === CircuitBreakerState.HALF_OPEN) {
        this.reset();
      }
      
      return score;
    } catch (error) {
      if (this.isInfraError(error)) {
        this.recordFailure();
        return this.handleFallback(destination, error);
      }
      
      // Non-infrastructure errors indicate the system is logically reachable.
      if (this.state === CircuitBreakerState.HALF_OPEN) {
        this.reset();
      }
      
      throw error;
    }
  }

  private recordFailure(): void {
    this.failures++;
    if (this.failures >= this.config.failureThreshold || this.state === CircuitBreakerState.HALF_OPEN) {
      this.state = CircuitBreakerState.OPEN;
      this.nextAttempt = Date.now() + this.config.cooldownWindow;
    }
  }

  private reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failures = 0;
    this.nextAttempt = 0;
  }

  private async handleFallback(destination: string, originalError?: unknown): Promise<number> {
    if (this.config.fallback !== undefined) {
      if (this.config.fallback instanceof Error) {
        throw this.config.fallback;
      }
      if (typeof this.config.fallback === 'function') {
        return this.config.fallback(destination);
      }
    }
    throw originalError || new Error('Circuit Breaker is OPEN');
  }
}
