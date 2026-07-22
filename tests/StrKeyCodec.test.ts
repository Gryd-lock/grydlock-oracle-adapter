import { describe, expect, it } from 'vitest';
import {
  crc16XModem,
  decodeBase32,
  decodeStrKey,
  encodeBase32,
  encodeStrKey,
  isValidStrKey,
  StrKeyError,
  STRKEY_BASE32_ALPHABET,
} from '../src/StrKeyCodec';

/** A real fixture account address. */
const ACCOUNT = 'GCRRYBV5IY7DSI54DKW33ZELC2LWYCAHC43TXAM2A2HTFN5GWOFWXPC2';

/** The same account muxed with subaccount id 1234567890. */
const MUXED = 'MCRRYBV5IY7DSI54DKW33ZELC2LWYCAHC43TXAM2A2HTFN5GWOFWWAAAAAAETFQC2LX6E';

/** Contract address for a 32-byte payload of `0x07`. */
const CONTRACT = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

/** Liquidity pool id for a 32-byte payload of `0x09`. */
const LIQUIDITY_POOL = 'LAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQT2QG';

/** Secret seed for a 32-byte payload of `0x03` — a valid strkey we must reject. */
const SECRET_SEED = 'SABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGC45';

function expectReason(run: () => unknown, reason: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StrKeyError);
    expect((error as StrKeyError).reason).toBe(reason);
    return;
  }

  throw new Error(`expected a StrKeyError with reason "${reason}"`);
}

describe('crc16XModem', () => {
  it('matches the canonical CRC16-XModem check value', () => {
    // The standard known-answer test vector: CRC16/XMODEM("123456789") = 0x31C3.
    expect(crc16XModem(new TextEncoder().encode('123456789'))).toBe(0x31c3);
  });

  it('is 0x0000 for empty input', () => {
    expect(crc16XModem(new Uint8Array())).toBe(0x0000);
  });

  it('changes when any single byte changes', () => {
    const bytes = Uint8Array.from([0x30, 0x00, 0x11, 0x22, 0x33]);
    const mutated = Uint8Array.from(bytes);
    mutated[3] = 0x23;

    expect(crc16XModem(mutated)).not.toBe(crc16XModem(bytes));
  });
});

describe('base32', () => {
  it('round-trips arbitrary byte lengths', () => {
    for (let length = 1; length <= 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_unused, index) => (index * 37 + 11) & 0xff);

      expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    }
  });

  it('emits only alphabet characters and never pads', () => {
    const encoded = encodeBase32(Uint8Array.from([1, 2, 3]));

    expect(encoded).not.toContain('=');
    for (const character of encoded) {
      expect(STRKEY_BASE32_ALPHABET).toContain(character);
    }
  });

  it('rejects the empty string', () => {
    expectReason(() => decodeBase32(''), 'empty');
  });

  it('rejects lowercase input rather than normalizing it', () => {
    expectReason(() => decodeBase32(ACCOUNT.toLowerCase()), 'invalid-character');
  });

  it('rejects "=" padding', () => {
    expectReason(() => decodeBase32('AAAAAAAA='), 'invalid-character');
  });

  it('rejects the 0/1 lookalikes some base32 variants accept', () => {
    expectReason(() => decodeBase32('AAAAAAA0'), 'invalid-character');
    expectReason(() => decodeBase32('AAAAAAA1'), 'invalid-character');
  });

  it('rejects lengths no encoder can produce', () => {
    for (const length of [1, 3, 6, 9]) {
      expectReason(() => decodeBase32('A'.repeat(length)), 'invalid-length');
    }
  });

  it('rejects non-zero trailing bits', () => {
    // 4 characters carry 20 bits: 16 data bits plus 4 bits that must be zero.
    expectReason(() => decodeBase32('AAAB'), 'non-canonical-padding');
  });
});

describe('decodeStrKey', () => {
  it('accepts a classic account address and returns its 32-byte key', () => {
    const decoded = decodeStrKey(ACCOUNT);

    expect(decoded.type).toBe('ed25519PublicKey');
    expect(decoded.versionByte).toBe(6 << 3);
    expect(decoded.payload).toHaveLength(32);
  });

  it('accepts a muxed account and returns its 40-byte payload', () => {
    const decoded = decodeStrKey(MUXED);

    expect(decoded.type).toBe('med25519PublicKey');
    expect(decoded.payload).toHaveLength(40);
    // The first 32 bytes are the base account's key.
    expect(decoded.payload.subarray(0, 32)).toEqual(decodeStrKey(ACCOUNT).payload);
  });

  it('accepts a contract address', () => {
    const decoded = decodeStrKey(CONTRACT);

    expect(decoded.type).toBe('contract');
    expect(decoded.payload).toEqual(new Uint8Array(32).fill(0x07));
  });

  it('accepts a liquidity pool identifier', () => {
    const decoded = decodeStrKey(LIQUIDITY_POOL);

    expect(decoded.type).toBe('liquidityPool');
    expect(decoded.payload).toEqual(new Uint8Array(32).fill(0x09));
  });

  it('rejects strkey types that are not destinations', () => {
    expectReason(() => decodeStrKey(SECRET_SEED), 'unsupported-version-byte');
  });

  it('rejects a near-miss forgery with a valid charset and length', () => {
    // Same length, same alphabet, one character changed: only the checksum
    // catches this.
    const forged = `${ACCOUNT.slice(0, 10)}A${ACCOUNT.slice(11)}`;

    expect(forged).toHaveLength(ACCOUNT.length);
    expect(forged).not.toBe(ACCOUNT);
    expectReason(() => decodeStrKey(forged), 'invalid-checksum');
  });

  it('rejects a transposed checksum', () => {
    const transposed = `${ACCOUNT.slice(0, -2)}${ACCOUNT.slice(-1)}${ACCOUNT.slice(-2, -1)}`;

    expectReason(() => decodeStrKey(transposed), 'invalid-checksum');
  });

  it('rejects a strkey of the wrong requested type', () => {
    expectReason(() => decodeStrKey(CONTRACT, 'ed25519PublicKey'), 'unexpected-type');
  });

  it('rejects a frame too short to hold a checksum', () => {
    expectReason(() => decodeStrKey('AAAA'), 'invalid-length');
  });
});

describe('encodeStrKey', () => {
  it('round-trips every supported type', () => {
    const key = decodeStrKey(ACCOUNT).payload;

    expect(encodeStrKey('ed25519PublicKey', key)).toBe(ACCOUNT);
    expect(encodeStrKey('med25519PublicKey', decodeStrKey(MUXED).payload)).toBe(MUXED);
    expect(encodeStrKey('contract', new Uint8Array(32).fill(0x07))).toBe(CONTRACT);
    expect(encodeStrKey('liquidityPool', new Uint8Array(32).fill(0x09))).toBe(LIQUIDITY_POOL);
  });

  it('rejects a payload of the wrong length', () => {
    expectReason(
      () => encodeStrKey('ed25519PublicKey', new Uint8Array(31)),
      'invalid-payload-length',
    );
  });
});

describe('isValidStrKey', () => {
  it('reports validity without throwing', () => {
    expect(isValidStrKey(ACCOUNT)).toBe(true);
    expect(isValidStrKey(ACCOUNT, 'ed25519PublicKey')).toBe(true);
    expect(isValidStrKey(ACCOUNT, 'contract')).toBe(false);
    expect(isValidStrKey('not-a-stellar-address')).toBe(false);
  });
});
