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
  AssetCodeType,
  assetCodeType,
  BatchCallOptions,
  BatchDestinationRequest,
  BatchItemResult,
  BatchItemStatus,
  BatchResult,
  BatchRiskOracle,
  BatchRiskOracleOptions,
  CacheOptions,
  CacheStatus,
  CircuitBreakerConfig,
  CircuitBreakerOracle,
  CircuitBreakerState,
  CoalescingOracle,
  compose,
  ContractIncompatibilityError,
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
  Logger,
  LogFields,
  noopLogger,
  OracleError,
  OracleErrorContext,
  OracleMiddleware,
  OracleSource,
  OracleTimeoutError,
  OracleUnavailableError,
  ProvenanceOracle,
  ProvenanceOracleOptions,
  QuorumNotMetContext,
  QuorumNotMetError,
  RiskOracle,
  RiskOracleAggregator,
  RiskOracleAggregatorOptions,
  RiskOracleAggregatorSource,
  ScoreProvenance,
  ScoredResult,
  SorobanFinalityPolicy,
  SorobanInterfaceVersionRange,
  SorobanOracle,
  SorobanOracleConfig,
  SorobanOracleEnvironment,
  SorobanProtocolDescriptor,
  SorobanRawLedgerCheckpoint,
  SorobanRawOutcome,
  SorobanRawResponse,
  SorobanRpcTransport,
  SorobanScoreRequest,
  SorobanScoredResult,
  SOROBAN_GET_SCORE_METHOD,
  SOROBAN_ORACLE_INTERFACE_VERSION_RANGE,
  SOROBAN_PROTOCOL_DESCRIPTOR,
  decodeSorobanRawResponse,
  isInterfaceVersionSupported,
  InsufficientFinalityContext,
  InsufficientFinalityError,
  MalformedOracleResponseError,
  ScoreNotYetComputedError,
  UnsupportedInterfaceVersionContext,
  UnsupportedInterfaceVersionError,
  WrongContractContext,
  WrongContractError,
  WrongNetworkContext,
  WrongNetworkError,
  STRKEY_BASE32_ALPHABET,
  StrKeyError,
  StrKeyErrorReason,
  StrKeyType,
  StubOracle,
  TierRoutingDecision,
  TimeoutOptions,
  toBatchOracle,
  UnrecognizedDestinationError,
  ValidatedDestination,
  validateDestination,
  weightedMedian,
  withCache,
  withProvenance,
  withTimeout,
} from '../../src';

const DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';

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

const circuitBreaker = new CircuitBreakerOracle(plainOracle, {
  failureThreshold: 3,
  cooldownWindow: 1_000,
} satisfies CircuitBreakerConfig);
const breakerState: CircuitBreakerState = circuitBreaker.getState();
const circuitBreakerAsOracle: RiskOracle = circuitBreaker;
void [breakerState, CircuitBreakerState.OPEN, circuitBreakerAsOracle.getScore(DESTINATION)];

const fallbackOracle = new FallbackOracle([plainOracle, detailedOracle], undefined, {
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

// --- RiskOracleAggregator.

const aggregatorSources: RiskOracleAggregatorSource[] = [
  { label: 'a', oracle: plainOracle },
  { label: 'b', oracle: detailedOracle },
  { label: 'c', oracle: detailedOracle },
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

// --- Middleware.

const cacheOptions: CacheOptions = { ttlMs: 30_000, staleMs: 5_000 };
const timeoutOptions: TimeoutOptions = { timeoutMs: 1_000 };
const provenanceOptions: ProvenanceOracleOptions = { source: 'test', logger };

const middleware: OracleMiddleware = withCache(cacheOptions);
const composed = compose(withCache(cacheOptions), withTimeout(timeoutOptions))(plainOracle);
const composedDetailed = compose(
  withProvenance(provenanceOptions),
  withTimeout(timeoutOptions),
)(plainOracle);
const detailedAssertion: DetailedRiskOracle = composedDetailed;
void [middleware, composed.getScore(DESTINATION), detailedAssertion.getScoreDetailed(DESTINATION)];

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

// --- SorobanOracle.

const sorobanVersionRange: SorobanInterfaceVersionRange = { min: 1, max: 1 };
const sorobanFinalityPolicy: SorobanFinalityPolicy = {
  minConfirmations: 1,
  maxResultAgeMs: 60_000,
};
const sorobanEnvironment: SorobanOracleEnvironment = 'test';
const sorobanConfig: SorobanOracleConfig = {
  environment: sorobanEnvironment,
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcEndpoints: ['https://soroban-testnet.stellar.org'],
  contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
  supportedInterfaceVersionRange: sorobanVersionRange,
  finalityPolicy: sorobanFinalityPolicy,
  requestBudgetMs: 5_000,
};

const sorobanTransport: SorobanRpcTransport = {
  transportKind: 'fixture',
  invokeGetScore: (
    request: SorobanScoreRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ) => {
    void [request, options];
    return Promise.resolve({});
  },
};

const sorobanOracle = new SorobanOracle(sorobanConfig, sorobanTransport);
const sorobanAsDetailed: RiskOracle & DetailedRiskOracle = sorobanOracle;
const sorobanDetailed: Promise<SorobanScoredResult> = sorobanOracle.getScoreDetailed(DESTINATION);
void [
  sorobanOracle.getScore(DESTINATION),
  sorobanAsDetailed.getScoreDetailed(DESTINATION),
  sorobanDetailed,
];

const sorobanDescriptor: SorobanProtocolDescriptor = SOROBAN_PROTOCOL_DESCRIPTOR;
const sorobanMethod: typeof SOROBAN_GET_SCORE_METHOD = 'get_score';
const sorobanDefaultRange: SorobanInterfaceVersionRange = SOROBAN_ORACLE_INTERFACE_VERSION_RANGE;
const sorobanRawResponse: SorobanRawResponse = decodeSorobanRawResponse({
  interfaceVersion: 1,
  networkPassphrase: 'Test SDF Network ; September 2015',
  contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
  ledger: { sequence: 1, closeTimeUnixMs: 0, latestSeenSequence: 1 },
  outcome: { variant: 'unscored' },
});
const sorobanOutcome: SorobanRawOutcome = sorobanRawResponse.outcome;
const sorobanLedger: SorobanRawLedgerCheckpoint = sorobanRawResponse.ledger;
const sorobanVersionSupported: boolean = isInterfaceVersionSupported(1, sorobanVersionRange);
void [
  sorobanDescriptor,
  sorobanMethod,
  sorobanDefaultRange,
  sorobanOutcome,
  sorobanLedger,
  sorobanVersionSupported,
];

const sorobanUnsupportedVersion: UnsupportedInterfaceVersionError =
  new UnsupportedInterfaceVersionError('bad version', {
    reportedVersion: 2,
    supportedRange: { min: 1, max: 1 },
  } satisfies UnsupportedInterfaceVersionContext);
const sorobanWrongNetwork: WrongNetworkError = new WrongNetworkError(undefined, {
  expectedNetworkPassphrase: 'a',
  actualNetworkPassphrase: 'b',
} satisfies WrongNetworkContext);
const sorobanWrongContract: WrongContractError = new WrongContractError(undefined, {
  expectedContractId: 'a',
  actualContractId: 'b',
} satisfies WrongContractContext);
const sorobanMalformed: MalformedOracleResponseError = new MalformedOracleResponseError();
const sorobanInsufficientFinality: InsufficientFinalityError = new InsufficientFinalityError(
  undefined,
  {
    resultLedgerSequence: 1,
    observedLedgerSequence: 1,
    requiredConfirmations: 2,
    observedConfirmations: 0,
  } satisfies InsufficientFinalityContext,
);
const sorobanPending: ScoreNotYetComputedError = new ScoreNotYetComputedError(DESTINATION);
const sorobanIsContractIncompatible =
  sorobanUnsupportedVersion instanceof ContractIncompatibilityError;
void [
  sorobanUnsupportedVersion,
  sorobanWrongNetwork,
  sorobanWrongContract,
  sorobanMalformed,
  sorobanInsufficientFinality,
  sorobanPending,
  sorobanIsContractIncompatible,
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
