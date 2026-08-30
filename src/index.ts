export {
  RiskOracle,
  DetailedRiskOracle,
  ScoredResult,
  OracleSource,
  CacheStatus,
} from './RiskOracle';
export { CancellableRiskOracle, isCancellable } from './CancellableRiskOracle';
export { StubOracle } from './StubOracle';
export {
  validateDestination,
  encodeAssetCode,
  assetCodeType,
  AssetCodeType,
  ValidatedDestination,
} from './DestinationValidator';
export {
  decodeStrKey,
  encodeStrKey,
  isValidStrKey,
  decodeBase32,
  encodeBase32,
  crc16XModem,
  StrKeyError,
  StrKeyType,
  StrKeyErrorReason,
  DecodedStrKey,
  STRKEY_BASE32_ALPHABET,
} from './StrKeyCodec';
export { Logger, LogFields, noopLogger } from './Logger';
export { ProvenanceOracle, ProvenanceOracleOptions, ScoreProvenance } from './ProvenanceOracle';
export {
  BatchRiskOracle,
  BatchRiskOracleOptions,
  BatchDestinationRequest,
  BatchCallOptions,
  BatchItemResult,
  BatchItemStatus,
  BatchResult,
  toBatchOracle,
} from './BatchRiskOracle';
export {
  OracleError,
  OracleErrorContext,
  OracleUnavailableError,
  OracleTimeoutError,
  OracleCancelledError,
  InvalidDestinationError,
  UnrecognizedDestinationError,
  ContractIncompatibilityError,
  QuorumNotMetError,
  QuorumNotMetContext,
  RiskDecisionValidationError,
  RiskDecisionValidationContext,
  CacheControlUnsupportedError,
  CacheControlUnsupportedContext,
} from './OracleError';
export { CoalescingOracle } from './CoalescingOracle';
export { DefaultOracle } from './DefaultOracle';
export {
  CircuitBreakerOracle,
  CircuitBreakerConfig,
  CircuitBreakerState,
  defaultIsInfrastructureError,
} from './CircuitBreakerOracle';
export {
  FallbackOracle,
  FallbackBanditConfig,
  FallbackScoredResult,
  TierRoutingDecision,
} from './FallbackOracle';
export { typedFallbackOracle } from './TypedFallbackOracle';
export { AllDetailed, ElementIsDetailed } from './AllDetailed';
export {
  RiskOracleAggregator,
  RiskOracleAggregatorOptions,
  RiskOracleAggregatorSource,
  OrderBounds,
  weightedMedian,
  honestOrderBounds,
  computeDisagreement,
} from './RiskOracleAggregator';
export { OracleMiddleware, compose, InnermostIn, ChainOut } from './OracleMiddleware';
export { FallbackObserver } from './FallbackObserver';
export { withCache, CacheOptions, CacheNamespace } from './middleware/withCache';
export { withTimeout, TimeoutOptions } from './middleware/withTimeout';
export { withProvenance } from './middleware/withProvenance';
export {
  withRateLimit,
  RateLimitOptions,
  RateLimitedRiskOracle,
  RateLimitCoordinationStatus,
  OracleRateLimitError,
  RateLimitDenialDetails,
  BroadcastChannelLike,
  BucketMap,
  joinBucketMaps,
} from './middleware/withRateLimit';

// --- Restart-safe lifecycle, persistence, and cross-context coordination
// (Epic #112): lifecycle ownership, durable evidence/state persistence, and
// bounded cross-context refresh leases, composed by
// `createProductionOracleStack`.
export { Disposable, isDisposable, DisposableGroup } from './lifecycle/Disposable';
export {
  DurableStore,
  InMemoryDurableStore,
  ChromeStorageAreaLike,
  createChromeStorageLocalStore,
  DurableEnvelope,
  wrapEnvelope,
  readEnvelope,
} from './lifecycle/DurableStore';
export {
  RefreshLeaseCoordinator,
  RefreshLeaseCoordinatorOptions,
  LeaseHandle,
  LockManagerLike,
  CoordinationStatus,
} from './lifecycle/RefreshLeaseCoordinator';
export {
  OracleLifecycleManager,
  OracleLifecycleManagerOptions,
  LifecycleState,
  HealthCheckable,
} from './lifecycle/OracleLifecycleManager';
export {
  createProductionOracleStack,
  ProductionOracleStackOptions,
  ProductionOracleStack,
  ProductionCacheOptions,
  ProductionRateLimitOptions,
  ProductionRefreshLeaseOptions,
} from './createProductionOracleStack';

// --- Evidence-bearing risk-decision contract (progresses #110). Additive
// alongside RiskOracle/ScoredResult above; see RiskDecision.ts's module doc.
export {
  RISK_DECISION_SCHEMA_VERSION,
  RiskDecisionSchemaVersion,
  RiskDecisionOutcome,
  RiskDecision,
  ScoredRiskDecision,
  VerifiedRiskDecision,
  UnscoredRiskDecision,
  DegradedRiskDecision,
  PolicyBlockedRiskDecision,
  UnavailableRiskDecision,
  IncompatibleRiskDecision,
  isScoredRiskDecision,
} from './RiskDecision';
export {
  RequestContext,
  CacheControl,
  DEFAULT_CACHE_CONTROL,
  CreateRequestContextOptions,
  createRequestContext,
  remainingBudgetMs,
  isExpired,
  deriveRequestContext,
  CacheControlCapabilities,
  requireCacheControlSupport,
} from './RequestContext';
export {
  ValidateRiskDecisionOptions,
  validateRiskDecision,
  isValidRiskDecision,
} from './validateRiskDecision';
export {
  RISK_DECISION_PROVENANCE_SCHEMA_VERSION,
  RiskDecisionProvenanceSchemaVersion,
  RiskDecisionProvenanceEvent,
  RiskDecisionRedactionOptions,
  RiskDecisionProvenanceMeta,
  pseudonymizeDestination,
  createRiskDecisionProvenanceEvent,
  riskDecisionLogLevel,
  emitRiskDecisionProvenance,
} from './RiskDecisionProvenance';
export { NumericAdapterOptions, toLegacyScore, toLegacyRiskOracle } from './legacy/numericAdapter';
