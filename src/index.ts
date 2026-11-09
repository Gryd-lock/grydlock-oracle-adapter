// ============================================================================
// Stable API
//
// What grydlock-extension and the README quick start use, plus the live
// Soroban client. Semver-governed: a breaking change here is a major bump.
// ============================================================================

// --- Core contract.
export {
  RiskOracle,
  DetailedRiskOracle,
  ScoredResult,
  OracleSource,
  CacheStatus,
} from './RiskOracle';
export { CancellableRiskOracle, isCancellable } from './CancellableRiskOracle';

// --- Live Soroban oracle (docs/adr/0001-soroban-oracle-protocol.md, contract/README.md).
export {
  createSorobanOracle,
  CreateSorobanOracleOptions,
  SorobanNetworkTarget,
  GRYDLOCK_TESTNET,
  DEFAULT_SOROBAN_FINALITY_POLICY,
} from './createSorobanOracle';
export {
  SorobanOracle,
  SorobanOracleConfig,
  SorobanOracleEnvironment,
  SorobanFinalityPolicy,
  SorobanRpcTransport,
  SorobanScoredResult,
} from './SorobanOracle';
export {
  StellarRpcTransport,
  StellarRpcTransportOptions,
  StellarRpcClient,
  encodeTarget as encodeSorobanTarget,
} from './StellarRpcTransport';
export {
  PROTOCOL_DESCRIPTOR as SOROBAN_PROTOCOL_DESCRIPTOR,
  ProtocolDescriptor as SorobanProtocolDescriptor,
  SOROBAN_GET_SCORE_METHOD,
  SOROBAN_ORACLE_INTERFACE_VERSION_RANGE,
  InterfaceVersionRange as SorobanInterfaceVersionRange,
  SorobanScoreRequest,
  SorobanRawResponse,
  SorobanRawOutcome,
  SorobanRawLedgerCheckpoint,
  decodeSorobanRawResponse,
  isInterfaceVersionSupported,
  SorobanResponseSchemaError,
} from './fixtures/soroban';

// --- Development stub (grydlock-testkit fixtures; returns 0 for unknown destinations).
export { StubOracle } from './StubOracle';

// --- Resilience: composition, cache, timeout, circuit breaker.
export { OracleMiddleware, compose, InnermostIn, ChainOut } from './OracleMiddleware';
export { withCache, CacheOptions } from './middleware/withCache';
export { withTimeout, TimeoutOptions } from './middleware/withTimeout';
export {
  CircuitBreakerOracle,
  CircuitBreakerConfig,
  CircuitBreakerState,
  defaultIsInfrastructureError,
} from './CircuitBreakerOracle';

// --- Errors.
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
  UnsupportedInterfaceVersionError,
  UnsupportedInterfaceVersionContext,
  WrongNetworkError,
  WrongNetworkContext,
  WrongContractError,
  WrongContractContext,
  MalformedOracleResponseError,
  InsufficientFinalityError,
  InsufficientFinalityContext,
  ScoreNotYetComputedError,
  RiskDecisionValidationError,
  RiskDecisionValidationContext,
  CacheControlUnsupportedError,
  CacheControlUnsupportedContext,
} from './OracleError';

// --- Destination validation and the strkey codec.
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

// ============================================================================
// Experimental API (`@experimental` in the docs)
//
// No downstream consumer yet. These are exported and tested, but may change
// or be removed in a minor release. Pin an exact version if you depend on
// them, and open an issue so they can be promoted.
// ============================================================================

// --- Multi-source routing and aggregation.
export {
  FallbackOracle,
  FallbackBanditConfig,
  FallbackScoredResult,
  TierRoutingDecision,
} from './FallbackOracle';
export { FallbackObserver } from './FallbackObserver';
export {
  RiskOracleAggregator,
  RiskOracleAggregatorOptions,
  RiskOracleAggregatorSource,
  OrderBounds,
  weightedMedian,
  honestOrderBounds,
  computeDisagreement,
} from './RiskOracleAggregator';
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
export { CoalescingOracle } from './CoalescingOracle';

// --- Score provenance logging.
export { ProvenanceOracle, ProvenanceOracleOptions, ScoreProvenance } from './ProvenanceOracle';
export { withProvenance } from './middleware/withProvenance';

// --- Evidence-bearing risk-decision contract (progresses #110).
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

// --- Deprecated: fail-closed bridge for numeric-only consumers.
export { NumericAdapterOptions, toLegacyScore, toLegacyRiskOracle } from './legacy/numericAdapter';
