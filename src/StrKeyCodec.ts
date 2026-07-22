/**
 * A from-scratch implementation of the Stellar "strkey" encoding.
 *
 * A strkey is the base32 encoding of
 *
 * ```text
 *   version byte (1) || payload (n) || CRC16-XModem checksum (2, little-endian)
 * ```
 *
 * where the checksum is computed over the version byte *and* the payload
 * (i.e. every byte except the two checksum bytes themselves).
 *
 * This module deliberately does **not** use `@stellar/stellar-sdk`'s `StrKey`,
 * `decodeCheck` or `encodeCheck`: the adapter's fund-safety warnings depend on
 * this validation, so the codec is implemented from the specification and the
 * SDK is used only as a differential-testing oracle in `tests/`.
 *
 * @see https://developers.stellar.org/docs/encyclopedia/strkeys
 * @see https://stellar.org/protocol/sep-23
 */

/**
 * The base32 alphabet strkeys use (RFC 4648, uppercase only).
 *
 * Stellar's convention differs from RFC 4648 in one important way: strkeys are
 * never `=`-padded, and the trailing bits of the final character must be zero.
 * Both rules are enforced by {@link decodeBase32}, so a strkey has exactly one
 * valid textual form and near-miss re-spellings are rejected rather than
 * silently decoded.
 */
export const STRKEY_BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Strkey shapes this codec accepts as a payment destination. */
export type StrKeyType = 'ed25519PublicKey' | 'med25519PublicKey' | 'contract' | 'liquidityPool';

/** Machine-readable reason a string was rejected by the codec. */
export type StrKeyErrorReason =
  | 'not-a-string'
  | 'empty'
  | 'invalid-character'
  | 'invalid-length'
  | 'non-canonical-padding'
  | 'unsupported-version-byte'
  | 'invalid-payload-length'
  | 'invalid-checksum'
  | 'unexpected-type';

/** Raised by the codec for any input that is not a well-formed strkey. */
export class StrKeyError extends Error {
  /** Stable machine-readable rejection reason. */
  public readonly reason: StrKeyErrorReason;

  constructor(reason: StrKeyErrorReason, message: string) {
    super(message);
    this.name = 'StrKeyError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Version bytes for the strkey shapes this codec accepts, with the exact
 * payload length each one requires.
 *
 * The version byte occupies the top 5 bits of the first base32 character,
 * which is why e.g. `6 << 3` renders as a leading `G`. Other version bytes
 * exist (`S` secret seeds, `T` pre-auth transactions, `X` sha256 hashes,
 * `P` signed payloads, `B` claimable balances); they are intentionally absent
 * here because none of them names a destination that can be scored, so they
 * are rejected as `unsupported-version-byte`.
 */
const STRKEY_TYPES: ReadonlyArray<{
  type: StrKeyType;
  versionByte: number;
  payloadLength: number;
}> = [
  // "G" — classic ed25519 account address, 32-byte public key.
  { type: 'ed25519PublicKey', versionByte: 6 << 3, payloadLength: 32 },
  // "M" — SEP-23 muxed account, 32-byte public key || 8-byte big-endian id.
  { type: 'med25519PublicKey', versionByte: 12 << 3, payloadLength: 40 },
  // "C" — Soroban contract address, 32-byte contract id.
  { type: 'contract', versionByte: 2 << 3, payloadLength: 32 },
  // "L" — liquidity pool, 32-byte pool id.
  { type: 'liquidityPool', versionByte: 11 << 3, payloadLength: 32 },
];

/** A successfully decoded strkey. */
export interface DecodedStrKey {
  /** Which strkey shape the version byte identified. */
  type: StrKeyType;
  /** The raw version byte. */
  versionByte: number;
  /** The payload bytes, excluding the version byte and the checksum. */
  payload: Uint8Array;
}

/**
 * CRC16-XModem (polynomial `0x1021`, initial value `0x0000`, no final XOR,
 * no input/output reflection) over `bytes`.
 *
 * @returns The checksum as a 16-bit unsigned integer.
 */
export function crc16XModem(bytes: Uint8Array): number {
  let crc = 0x0000;

  for (const byte of bytes) {
    crc ^= byte << 8;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc;
}

/**
 * Decodes a strkey-flavoured base32 string.
 *
 * Rejects lowercase input, `=` padding, characters outside
 * {@link STRKEY_BASE32_ALPHABET} (including the `0`/`1` lookalikes some base32
 * variants map onto `O`/`I`), lengths that cannot be produced by encoding a
 * whole number of bytes, and trailing bits that are not zero. Together these
 * guarantee `encodeBase32(decodeBase32(s)) === s` for every accepted `s`.
 */
export function decodeBase32(encoded: string): Uint8Array {
  if (encoded.length === 0) {
    throw new StrKeyError('empty', 'empty string is not a valid strkey');
  }

  const bytes = new Uint8Array(Math.floor((encoded.length * 5) / 8));
  let byteCount = 0;
  let buffer = 0;
  let bufferedBits = 0;

  for (const character of encoded) {
    const value = STRKEY_BASE32_ALPHABET.indexOf(character);

    if (value < 0) {
      throw new StrKeyError(
        'invalid-character',
        `"${character}" is not in the strkey base32 alphabet`,
      );
    }

    buffer = (buffer << 5) | value;
    bufferedBits += 5;

    if (bufferedBits >= 8) {
      bufferedBits -= 8;
      bytes[byteCount] = (buffer >> bufferedBits) & 0xff;
      byteCount += 1;
    }
  }

  // Five or more leftover bits mean a whole extra character contributed
  // nothing, which no encoder would ever emit.
  if (bufferedBits >= 5) {
    throw new StrKeyError('invalid-length', `${encoded.length} is not a valid base32 length`);
  }

  if ((buffer & ((1 << bufferedBits) - 1)) !== 0) {
    throw new StrKeyError('non-canonical-padding', 'trailing bits of the final character are set');
  }

  return bytes;
}

/** Encodes bytes as unpadded, uppercase, strkey-flavoured base32. */
export function encodeBase32(bytes: Uint8Array): string {
  let encoded = '';
  let buffer = 0;
  let bufferedBits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;

    while (bufferedBits >= 5) {
      bufferedBits -= 5;
      encoded += STRKEY_BASE32_ALPHABET[(buffer >> bufferedBits) & 0x1f];
    }
  }

  if (bufferedBits > 0) {
    encoded += STRKEY_BASE32_ALPHABET[(buffer << (5 - bufferedBits)) & 0x1f];
  }

  return encoded;
}

/**
 * Decodes and fully verifies a strkey.
 *
 * @param encoded The candidate strkey. Case is significant; the input is never
 * normalized.
 * @param expected When given, the decoded strkey must be of this type.
 * @throws {StrKeyError} If `encoded` is not a well-formed strkey of a
 * supported type with a matching CRC16-XModem checksum.
 */
export function decodeStrKey(encoded: string, expected?: StrKeyType): DecodedStrKey {
  if (typeof encoded !== 'string') {
    throw new StrKeyError('not-a-string', 'strkey must be a string');
  }

  const decoded = decodeBase32(encoded);

  // 1 version byte + 2 checksum bytes is the smallest decodable frame.
  if (decoded.length < 3) {
    throw new StrKeyError('invalid-length', 'strkey is too short to contain a checksum');
  }

  const versionByte = decoded[0] as number;
  const spec = STRKEY_TYPES.find((candidate) => candidate.versionByte === versionByte);

  if (spec === undefined) {
    throw new StrKeyError(
      'unsupported-version-byte',
      `version byte 0x${versionByte.toString(16)} is not a supported destination type`,
    );
  }

  const payload = decoded.subarray(1, decoded.length - 2);

  if (payload.length !== spec.payloadLength) {
    throw new StrKeyError(
      'invalid-payload-length',
      `${spec.type} payload must be ${spec.payloadLength} bytes, got ${payload.length}`,
    );
  }

  // The checksum covers the version byte and the payload, never itself.
  const checksum = crc16XModem(decoded.subarray(0, decoded.length - 2));
  const expectedLow = checksum & 0xff;
  const expectedHigh = (checksum >> 8) & 0xff;

  if (decoded[decoded.length - 2] !== expectedLow || decoded[decoded.length - 1] !== expectedHigh) {
    throw new StrKeyError('invalid-checksum', 'checksum does not match the payload');
  }

  if (expected !== undefined && spec.type !== expected) {
    throw new StrKeyError('unexpected-type', `expected a ${expected} strkey, got a ${spec.type}`);
  }

  return { type: spec.type, versionByte, payload: Uint8Array.from(payload) };
}

/** Encodes a payload as a strkey of the given type. */
export function encodeStrKey(type: StrKeyType, payload: Uint8Array): string {
  const spec = STRKEY_TYPES.find((candidate) => candidate.type === type);

  if (spec === undefined) {
    throw new StrKeyError('unsupported-version-byte', `${type} is not a supported strkey type`);
  }

  if (payload.length !== spec.payloadLength) {
    throw new StrKeyError(
      'invalid-payload-length',
      `${type} payload must be ${spec.payloadLength} bytes, got ${payload.length}`,
    );
  }

  const framed = new Uint8Array(payload.length + 3);
  framed[0] = spec.versionByte;
  framed.set(payload, 1);

  const checksum = crc16XModem(framed.subarray(0, framed.length - 2));
  framed[framed.length - 2] = checksum & 0xff;
  framed[framed.length - 1] = (checksum >> 8) & 0xff;

  return encodeBase32(framed);
}

/** Whether `encoded` is a valid strkey, optionally of a specific type. */
export function isValidStrKey(encoded: string, expected?: StrKeyType): boolean {
  try {
    decodeStrKey(encoded, expected);
    return true;
  } catch {
    return false;
  }
}
