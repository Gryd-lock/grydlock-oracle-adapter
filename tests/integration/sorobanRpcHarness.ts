import http, { type Server } from 'node:http';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { RiskOracleFixtureContract, extractInvocation } from './riskOracleFixture';

/**
 * Per-server behavior knobs used to drive the failure-mode tests. Each knob
 * mirrors a real Soroban RPC failure the adapter must survive.
 */
export interface SorobanRpcServerBehavior {
  /**
   * Destinations for which `get_score` should succeed but return a malformed
   * (non-numeric) return value.
   */
  malformedDestinations?: ReadonlySet<string>;
  /**
   * Destinations for which `get_score` should simulate a contract revert
   * (unknown destination), overriding any fixture score.
   */
  revertDestinations?: ReadonlySet<string>;
  /** Delay every `simulateTransaction` response by this many milliseconds. */
  delayMs?: number;
  /** When set, `simulateTransaction` responds with this HTTP status. */
  httpStatus?: number;
}

export interface SorobanRpcServerHandle {
  /** The `http://127.0.0.1:<port>` base URL the oracle should target. */
  url: string;
  /** Mutable behavior knobs; tests set fields between calls. */
  behavior: SorobanRpcServerBehavior;
  /** Total number of JSON-RPC requests received so far. */
  getRequestCount(): number;
  /** Stops the HTTP server and waits for the port to be released. */
  close(): Promise<void>;
}

const LEDGER_ID = '0'.repeat(64);
const LEDGER_SEQUENCE = 1;

function jsonResponse(res: http.ServerResponse, id: number, result: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function jsonRpcError(res: http.ServerResponse, id: number, message: string, status = 500): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message },
    }),
  );
}

/**
 * Starts a local, self-contained Soroban RPC fixture server bound to
 * `127.0.0.1`. It emulates just enough of the Soroban RPC surface the
 * adapter's client uses (`simulateTransaction`, `getHealth`) against a
 * {@link RiskOracleFixtureContract}, so integration tests exercise the real
 * HTTP + XDR boundary with no external network access.
 *
 * The simulated network is always "healthy" and never advances: every
 * `simulateTransaction` reports the same latest ledger, which keeps repeated
 * CI runs deterministic.
 */
export async function startSorobanRpcServer(
  contract: RiskOracleFixtureContract,
): Promise<SorobanRpcServerHandle> {
  const behavior: SorobanRpcServerBehavior = {};
  let requestCount = 0;

  const server: Server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk;
      });
      req.on('end', () => {
        void handleRequest(req, body, res);
      });
    },
  );

  async function handleRequest(
    req: http.IncomingMessage,
    body: string,
    res: http.ServerResponse,
  ): Promise<void> {
    let parsed: { id?: number; method?: string; params?: { transaction?: string } };
    try {
      parsed = JSON.parse(body);
    } catch {
      jsonRpcError(res, 0, 'invalid JSON-RPC request body', 400);
      return;
    }

    requestCount += 1;
    const id = parsed.id ?? 1;

    if (req.method !== 'POST') {
      jsonRpcError(res, id, 'only POST is supported', 405);
      return;
    }

    if (parsed.method === 'getHealth') {
      jsonResponse(res, id, {
        status: 'healthy',
        latestLedger: LEDGER_SEQUENCE,
        ledgerRetentionWindow: 10,
        oldestLedger: 1,
      });
      return;
    }

    if (parsed.method !== 'simulateTransaction') {
      jsonRpcError(res, id, `method ${parsed.method} not found`, 404);
      return;
    }

    if (behavior.httpStatus !== undefined) {
      jsonRpcError(res, id, 'simulateTransaction failed', behavior.httpStatus);
      return;
    }

    const txXdr = parsed.params?.transaction;
    if (typeof txXdr !== 'string' || txXdr.length === 0) {
      jsonRpcError(res, id, 'missing transaction envelope', 400);
      return;
    }

    if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
    }

    try {
      const { functionName, args } = extractInvocation(txXdr);
      if (functionName !== 'get_score') {
        jsonResponse(res, id, {
          id: LEDGER_ID,
          latestLedger: LEDGER_SEQUENCE,
          events: [],
          error: `HostError: unknown function ${functionName}`,
        });
        return;
      }

      const destination = typeof args[0] === 'string' ? args[0] : undefined;
      if (destination === undefined) {
        jsonResponse(res, id, {
          id: LEDGER_ID,
          latestLedger: LEDGER_SEQUENCE,
          events: [],
          error: 'HostError: get_score expects a string destination',
        });
        return;
      }

      if (behavior.revertDestinations?.has(destination)) {
        jsonResponse(res, id, {
          id: LEDGER_ID,
          latestLedger: LEDGER_SEQUENCE,
          events: [],
          error: `HostError: destination not recognized: ${destination}`,
        });
        return;
      }

      if (behavior.malformedDestinations?.has(destination)) {
        jsonResponse(res, id, {
          id: LEDGER_ID,
          latestLedger: LEDGER_SEQUENCE,
          events: [],
          results: [
            {
              auth: [],
              xdr: nativeToScVal('not-a-number').toXDR('base64'),
            },
          ],
          cost: { cpuInsns: '1000000', memBytes: '1000' },
          transactionData: '',
          minResourceFee: '0',
        });
        return;
      }

      const score = contract.getScore(destination);
      if (score === undefined) {
        jsonResponse(res, id, {
          id: LEDGER_ID,
          latestLedger: LEDGER_SEQUENCE,
          events: [],
          error: `HostError: destination not recognized: ${destination}`,
        });
        return;
      }

      jsonResponse(res, id, {
        id: LEDGER_ID,
        latestLedger: LEDGER_SEQUENCE,
        events: [],
        results: [
          {
            auth: [],
            xdr: nativeToScVal(score, { type: 'u32' }).toXDR('base64'),
          },
        ],
        cost: { cpuInsns: '1000000', memBytes: '1000' },
        transactionData: '',
        minResourceFee: '0',
      });
    } catch (err) {
      jsonRpcError(res, id, `simulation failed: ${String(err)}`);
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    behavior,
    getRequestCount: () => requestCount,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  } as SorobanRpcServerHandle;
}
