/**
 * Compile-time-only type tests for the package entry point (`src/index.ts`).
 *
 * Every import documented in the README (and the full supported public
 * surface) must resolve and type-check against the barrel. Nothing here is
 * executed — it exists purely to be type-checked by `npm run typecheck`
 * (see tsconfig.typetest.json), so every assertion is either a direct
 * type-checked assignment/member access or a `// @ts-expect-error` proving
 * the compiler rejects what it should. See
 * OracleMiddleware.type-test.ts's file doc for the pattern.
 */
import {
  AllDetailed,
  AssetCodeType,
  assetCodeType,
  BatchCallOptions,
  BatchDestinationRequest,
  BatchItemResult,
  BatchItemStatus,
  BatchResult,
  BatchRiskOracle,
  BatchRiskOracleOptions,
  BroadcastChannelLike,
  BucketMap,
  CacheOptions,
  CacheStatus,
  CircuitBreakerConfig,
  CircuitBreakerOracle,
  CircuitBreakerState,
  CoalescingOracle,
  compose,
  ContractIncompatibilityError,
  DefaultOracle,
  DecodedStrKey,
  decodeStrKey,
  DetailedRiskOracle,
  encodeAssetCode,
  encodeStrKey,
  FallbackBanditConfig,
  FallbackObserver,
  FallbackOracle,
  FallbackScoredResult,
  honestOrderBounds,
  InvalidDestinationError,
  joinBucketMaps,
  Logger,
  LogFields,
  noopLogger,
  OracleError,
  OracleErrorContext,
  OracleMiddleware,
  OracleRateLimitError,
  OracleSource,
  OracleTimeoutError,
  OracleUnavailableError,
  ProvenanceOracle,
  ProvenanceOracleOptions,
  QuorumNotMetContext,
  QuorumNotMetError,
  RateLimitDenialDetails,
  RateLimitOptions,
  RiskOracle,
  RiskOracleAggregator,
  RiskOracleAggregatorOptions,
  RiskOracleAggregatorSource,
  ScoreProvenance,
  ScoredResult,
  STRKEY_BASE32_ALPHABET,
  StrKeyError,
  StrKeyErrorReason,
  StrKeyType,
  StubOracle,
  TierRoutingDecision,
  TimeoutOptions,
  toBatchOracle,
  typedFallbackOracle,
  UnrecognizedDestinationError,
  ValidatedDestination,
  validateDestination,
  weightedMedian,
  withCache,
  withProvenance,
  withRateLimit,
  withTimeout,
} from '../../src';

const DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';

/** Compiles only when `T` is exactly `true`. */
type ExpectTrue<T extends true> = T;

// --- The README Quick Start, verbatim shape: must compile against the barrel.

const logger: Logger = {
  debug: (message: string, meta?: LogFields) => void [message, meta],
  info: (message: string, meta?: LogFields) => void [message, meta],
  warn: (message: string, meta?: LogFields) => void [message, meta],
  error: (message: string, meta?: LogFields) => void [message, meta],
};

const quickStartOracle = new CoalescingOracle(new StubOracle(), logger);
void quickStartOracle.getScore(DESTINATION);

// --- Core interfaces and metadata types.

const plainOracle: RiskOracle = new StubOracle();
const detailedOracle: DetailedRiskOracle = new ProvenanceOracle(plainOracle);
const detailedScore: Promise<ScoredResult> = detailedOracle.getScoreDetailed(DESTINATION);
const cacheStatus: CacheStatus = 'cache-fresh';
const source: OracleSource = 'StubOracle';
void [plainOracle, detailedScore, cacheStatus, source];

// --- Oracle implementations.

const coalescing: RiskOracle = new CoalescingOracle(plainOracle);
void coalescing.getScore(DESTINATION);

const defaults: RiskOracle = new DefaultOracle();
const defaultsAt50: RiskOracle = new DefaultOracle(50);
void [defaults.getScore(DESTINATION), defaultsAt50];

const circuitBreaker = new CircuitBreakerOracle(plainOracle, {
  failureThreshold: 3,
  cooldownWindow: 1_000,
} satisfies CircuitBreakerConfig);
const breakerState: CircuitBreakerState = circuitBreaker.getState();
const circuitBreakerAsOracle: RiskOracle = circuitBreaker;
void [breakerState, CircuitBreakerState.OPEN, circuitBreakerAsOracle.getScore(DESTINATION)];

const fallbackOracle = new FallbackOracle([plainOracle, defaults], undefined, {
  explorationFactor: 1.5,
  discountFactor: 0.95,
  tierNames: ['a', 'b'],
} satisfies FallbackBanditConfig);
const fallbackAsDetailed: DetailedRiskOracle = fallbackOracle;
void fallbackAsDetailed.getScoreDetailed(DESTINATION);
const fallbackScore: Promise<FallbackScoredResult> = fallbackOracle.getScoreDetailed(DESTINATION);
const routing: TierRoutingDecision[] = [];
const answered: number = 0;
void [fallbackScore, routing, answered];

const typedDetailed = typedFallbackOracle([detailedOracle, detailedOracle]);
const typedDetailedAssertion: DetailedRiskOracle = typedDetailed;
void typedDetailedAssertion.getScoreDetailed(DESTINATION);

const typedMixed = typedFallbackOracle([detailedOracle, plainOracle]);
// @ts-expect-error — a mixed chain is not statically DetailedRiskOracle.
void typedMixed.getScoreDetailed(DESTINATION);

type AllDetailedAll = ExpectTrue<AllDetailed<[DetailedRiskOracle, DetailedRiskOracle]>>;
type AllDetailedMixed = ExpectTrue<AllDetailed<[DetailedRiskOracle]>>; // type-only smoke; see AllDetailed.type-test.ts
export type { AllDetailedAll, AllDetailedMixed };

// --- RiskOracleAggregator.

const aggregatorSources: RiskOracleAggregatorSource[] = [
  { label: 'a', oracle: plainOracle },
  { label: 'b', oracle: defaults },
  { label: 'c', oracle: defaults },
];
const aggregatorOptions: RiskOracleAggregatorOptions = {
  sources: aggregatorSources,
  faultTolerance: 1,
  timeoutMs: 1_000,
};
const aggregator: RiskOracle = new RiskOracleAggregator(aggregatorOptions);
void aggregator.getScore(DESTINATION);
const median: number = weightedMedian([1, 2, 3], [1, 1, 1]);
const bounds: { lo: number; hi: number } = honestOrderBounds([1, 2, 3], 0);
void [median, bounds];

// --- Batch.

const batchOptions: BatchRiskOracleOptions = { maxConcurrency: 2 };
const batch: BatchRiskOracle = toBatchOracle(plainOracle, batchOptions);
const batchRequests: BatchDestinationRequest[] = [{ destination: DESTINATION, priority: 1 }];
const batchCallOptions: BatchCallOptions = { deadlineMs: 1_000 };
const batchResult: Promise<BatchResult> = batch.getScores(batchRequests, batchCallOptions);
const batchItem: BatchItemResult = {
  destination: DESTINATION,
  status: 'fulfilled' as BatchItemStatus,
};
void [batchResult, batchItem.score];

// --- Error taxonomy.

const unavailable: OracleUnavailableError = new OracleUnavailableError();
const timeoutError: OracleTimeoutError = new OracleTimeoutError();
const invalid: InvalidDestinationError = new InvalidDestinationError('GABC');
const unrecognized: UnrecognizedDestinationError = new UnrecognizedDestinationError('GABC');
const incompatible: ContractIncompatibilityError = new ContractIncompatibilityError();
const quorum: QuorumNotMetError = new QuorumNotMetError(DESTINATION, {
  required: 3,
  succeeded: 1,
  total: 5,
} satisfies Omit<QuorumNotMetContext, 'destination'>);
const quorumContext: QuorumNotMetContext = quorum.context;
const errContext: OracleErrorContext = { destination: DESTINATION };
const isOracleError = [
  unavailable,
  timeoutError,
  invalid,
  unrecognized,
  incompatible,
  quorum,
].every((error) => error instanceof OracleError);
void [quorumContext, errContext, isOracleError];

// --- Rate-limit error + middleware option types.

const denialDetails: RateLimitDenialDetails = {
  budget: 10,
  windowMs: 1_000,
  contextId: 'ctx',
  globalEstimate: 9,
  fairShare: 10,
  selfCount: 5,
  reason: 'global-budget',
};
const rateLimitError: OracleRateLimitError = new OracleRateLimitError(DESTINATION, denialDetails);
void [rateLimitError.details.reason, rateLimitError.message];

// --- Middleware.

const cacheOptions: CacheOptions = { ttlMs: 30_000, staleMs: 5_000 };
const timeoutOptions: TimeoutOptions = { timeoutMs: 1_000 };
const provenanceOptions: ProvenanceOracleOptions = { source: 'test', logger };
const rateLimitOptions: RateLimitOptions = { budget: 10, windowMs: 1_000, contextId: 'ctx' };

const middleware: OracleMiddleware = withCache(cacheOptions);
const composed = compose(withCache(cacheOptions), withTimeout(timeoutOptions))(plainOracle);
const composedDetailed = compose(
  withProvenance(provenanceOptions),
  withTimeout(timeoutOptions),
)(plainOracle);
const detailedAssertion: DetailedRiskOracle = composedDetailed;
void [middleware, composed.getScore(DESTINATION), detailedAssertion.getScoreDetailed(DESTINATION)];

const fakeChannel: BroadcastChannelLike = {
  postMessage: () => undefined,
  addEventListener: () => undefined,
};
const withChannel: RateLimitOptions = { ...rateLimitOptions, channel: fakeChannel };
const limited: RiskOracle = withRateLimit(withChannel)(plainOracle);
void limited.getScore(DESTINATION);

const bucketsA: BucketMap = new Map([[1, 2]]);
const bucketsB: BucketMap = new Map([[1, 3]]);
const merged: BucketMap = joinBucketMaps(bucketsA, bucketsB);
void merged.size;

// --- Fallback observer.

const observer: FallbackObserver = {
  onFallback: (error: unknown, oracle: RiskOracle) => void [error, oracle.getScore(DESTINATION)],
};
void new FallbackOracle([plainOracle], observer);

// --- Destination validation + strkey codec.

const validated: ValidatedDestination = validateDestination(DESTINATION);
const assetCode: AssetCodeType = assetCodeType('SCAM');
const encodedAsset: Uint8Array = encodeAssetCode('SCAM');
const decoded: DecodedStrKey = decodeStrKey(DESTINATION);
const reEncoded: string = encodeStrKey(decoded.type, decoded.payload);
const strKeyType: StrKeyType = decoded.type;
const reason: StrKeyErrorReason = 'invalid-checksum';
const strKeyError: StrKeyError = new StrKeyError(reason, 'bad');
const alphabet: string = STRKEY_BASE32_ALPHABET;
void [
  validated.canonical,
  assetCode,
  encodedAsset,
  reEncoded,
  strKeyType,
  strKeyError.message,
  alphabet,
];

// --- Provenance record shape.

const provenance: ScoreProvenance = {
  event: 'score_provenance',
  destination: DESTINATION,
  score: 95,
  source: 'StubOracle',
  cacheStatus: 'unknown',
  timestamp: 0,
  latencyMs: 1,
  outcome: 'success',
};
void [provenance.event, noopLogger];
