import { InvalidDestinationError } from './OracleError';
import { decodeStrKey, encodeStrKey, StrKeyError } from './StrKeyCodec';

/**
 * The grammar of a `RiskOracle` destination, and the validator that enforces
 * it before any score lookup happens.
 *
 * A destination is one of:
 *
 * 1. `G...` — a classic ed25519 account address.
 * 2. `M...` — a SEP-23 muxed account. **Accepted**, and canonicalized to its
 *    base `G` address (see {@link validateDestination} for the reasoning).
 * 3. `C...` — a Soroban contract address.
 * 4. `L...` — a liquidity pool identifier.
 * 5. `<asset_code>:<issuer>` — a SEP-11 composite asset identifier.
 *
 * Everything else — including near-miss forgeries that have a plausible
 * length and character set but fail the CRC16-XModem check — is rejected with
 * {@link InvalidDestinationError}.
 */

/** Maximum length of a SEP-11 `alphanum4` asset code. */
const ALPHANUM4_MAX_LENGTH = 4;

/** Maximum length of a SEP-11 `alphanum12` asset code. */
const ALPHANUM12_MAX_LENGTH = 12;

/** SEP-11 asset codes are 1-12 ASCII alphanumeric characters. */
const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;

/** Which of the two SEP-11 wire encodings an asset code uses. */
export type AssetCodeType = 'alphanum4' | 'alphanum12';

/** A destination that passed validation, decomposed into its parts. */
export type ValidatedDestination =
  | {
      /** Discriminant: a classic `G` account address. */
      kind: 'account';
      /** The form used for fixture lookup. */
      canonical: string;
      /** The `G` address as supplied. */
      address: string;
    }
  | {
      /** Discriminant: a SEP-23 muxed `M` account. */
      kind: 'muxedAccount';
      /** The base `G` address the muxed account resolves to. */
      canonical: string;
      /** The `M` address as supplied. */
      address: string;
      /** The base `G` address decoded out of the muxed payload. */
      baseAddress: string;
      /** The 64-bit subaccount id decoded out of the muxed payload. */
      subaccountId: bigint;
    }
  | {
      /** Discriminant: a Soroban `C` contract address. */
      kind: 'contract';
      /** The form used for fixture lookup. */
      canonical: string;
      /** The `C` address as supplied. */
      address: string;
    }
  | {
      /** Discriminant: an `L` liquidity pool identifier. */
      kind: 'liquidityPool';
      /** The form used for fixture lookup. */
      canonical: string;
      /** The `L` identifier as supplied. */
      address: string;
    }
  | {
      /** Discriminant: a SEP-11 `<asset_code>:<issuer>` composite. */
      kind: 'asset';
      /** The form used for fixture lookup. */
      canonical: string;
      /** The asset code exactly as supplied; case is significant. */
      assetCode: string;
      /** Which SEP-11 wire encoding the code uses. */
      assetCodeType: AssetCodeType;
      /** The issuing `G` address. */
      issuer: string;
    };

/**
 * The SEP-11 wire encoding of an asset code: a code of 1-4 characters is a
 * 4-byte `alphanum4` right-padded with zero bytes, and a code of 5-12
 * characters is a 12-byte `alphanum12` right-padded with zero bytes.
 *
 * A 4-character code is therefore *not* padded at all while a 5-character code
 * carries seven padding bytes — the boundary where implementations commonly
 * pick the wrong width.
 *
 * @throws {RangeError} If `assetCode` is not a valid SEP-11 asset code.
 */
export function encodeAssetCode(assetCode: string): Uint8Array {
  if (!ASSET_CODE_PATTERN.test(assetCode)) {
    throw new RangeError(`"${assetCode}" is not a valid SEP-11 asset code`);
  }

  const width =
    assetCode.length <= ALPHANUM4_MAX_LENGTH ? ALPHANUM4_MAX_LENGTH : ALPHANUM12_MAX_LENGTH;
  const bytes = new Uint8Array(width);

  for (let index = 0; index < assetCode.length; index += 1) {
    bytes[index] = assetCode.charCodeAt(index);
  }

  return bytes;
}

/** Classifies a valid asset code as `alphanum4` or `alphanum12`. */
export function assetCodeType(assetCode: string): AssetCodeType {
  return assetCode.length <= ALPHANUM4_MAX_LENGTH ? 'alphanum4' : 'alphanum12';
}

/**
 * Reads the 64-bit subaccount id out of a decoded SEP-23 muxed payload.
 *
 * The payload is the 32-byte ed25519 key followed by the id as a big-endian
 * unsigned 64-bit integer, matching the XDR `MuxedAccount.med25519` encoding.
 */
function readSubaccountId(payload: Uint8Array): bigint {
  let id = 0n;

  for (let index = payload.length - 8; index < payload.length; index += 1) {
    id = (id << 8n) | BigInt(payload[index] as number);
  }

  return id;
}

/**
 * Validates and canonicalizes a destination identifier.
 *
 * Muxed (`M`) destinations are **accepted** and score as their base account:
 * a muxed address is the same underlying ed25519 account with a routing tag
 * attached, so its on-chain risk is the base account's risk. Rejecting them
 * would leave a user paying a custodial exchange deposit address with no
 * warning at all, which is strictly worse than scoring the account the funds
 * actually land in. The subaccount id is decoded and exposed rather than
 * discarded so a future scorer can use it.
 *
 * Contract (`C`) and liquidity pool (`L`) destinations are accepted as-is:
 * both name real, scoreable on-chain destinations that a payment or swap can
 * be addressed to, and both are already reachable through the adapter's public
 * `getScore` surface.
 *
 * Secret seeds (`S`), pre-auth transactions (`T`), sha256 hashes (`X`), signed
 * payloads (`P`) and claimable balances (`B`) are rejected: they are signer or
 * transaction constructs, not payment destinations, and accepting an `S` seed
 * in particular would mean echoing a secret key back through the scoring path.
 *
 * @param destination A Stellar address or asset identifier.
 * @returns The destination decomposed into its parts, with `canonical` giving
 * the form to use for score lookup.
 * @throws {InvalidDestinationError} If `destination` does not match the
 * grammar above.
 */
export function validateDestination(destination: string): ValidatedDestination {
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new InvalidDestinationError(String(destination));
  }

  if (destination.includes(':')) {
    return validateAsset(destination);
  }

  let decoded;

  try {
    decoded = decodeStrKey(destination);
  } catch (cause) {
    throw new InvalidDestinationError(destination, { cause });
  }

  switch (decoded.type) {
    case 'ed25519PublicKey':
      return { kind: 'account', canonical: destination, address: destination };

    case 'contract':
      return { kind: 'contract', canonical: destination, address: destination };

    case 'liquidityPool':
      return { kind: 'liquidityPool', canonical: destination, address: destination };

    case 'med25519PublicKey': {
      const baseAddress = encodeStrKey('ed25519PublicKey', decoded.payload.subarray(0, 32));

      return {
        kind: 'muxedAccount',
        canonical: baseAddress,
        address: destination,
        baseAddress,
        subaccountId: readSubaccountId(decoded.payload),
      };
    }
  }
}

/** Validates a SEP-11 `<asset_code>:<issuer>` composite identifier. */
function validateAsset(destination: string): ValidatedDestination {
  const parts = destination.split(':');

  if (parts.length !== 2) {
    throw new InvalidDestinationError(destination);
  }

  const [assetCode, issuer] = parts as [string, string];

  if (!ASSET_CODE_PATTERN.test(assetCode)) {
    throw new InvalidDestinationError(destination, {
      cause: new StrKeyError('invalid-character', `"${assetCode}" is not a valid asset code`),
    });
  }

  try {
    decodeStrKey(issuer, 'ed25519PublicKey');
  } catch (cause) {
    throw new InvalidDestinationError(destination, { cause });
  }

  return {
    kind: 'asset',
    canonical: destination,
    assetCode,
    assetCodeType: assetCodeType(assetCode),
    issuer,
  };
}
