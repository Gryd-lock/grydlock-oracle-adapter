import { describe, expect, it } from 'vitest';
import { assetCodeType, encodeAssetCode, validateDestination } from '../src/DestinationValidator';
import { InvalidDestinationError } from '../src/OracleError';
import { destinations as testkitDestinations } from '../src/fixtures/testkit';

const ACCOUNT = 'GCRRYBV5IY7DSI54DKW33ZELC2LWYCAHC43TXAM2A2HTFN5GWOFWXPC2';
const ISSUER = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';
const MUXED = 'MCRRYBV5IY7DSI54DKW33ZELC2LWYCAHC43TXAM2A2HTFN5GWOFWWAAAAAAETFQC2LX6E';
const MUXED_ID_ZERO = 'MCRRYBV5IY7DSI54DKW33ZELC2LWYCAHC43TXAM2A2HTFN5GWOFWWAAAAAAAAAAAADADQ';
const MUXED_ID_MAX = 'MCRRYBV5IY7DSI54DKW33ZELC2LWYCAHC43TXAM2A2HTFN5GWOFWX7777777777774QZ4';
const CONTRACT = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const LIQUIDITY_POOL = 'LAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQT2QG';
const SECRET_SEED = 'SABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGC45';

describe('validateDestination', () => {
  it('accepts every grydlock-testkit fixture destination', () => {
    for (const { id } of testkitDestinations.destinations) {
      expect(() => validateDestination(id)).not.toThrow();
    }
  });

  it('accepts a classic account address unchanged', () => {
    expect(validateDestination(ACCOUNT)).toEqual({
      kind: 'account',
      canonical: ACCOUNT,
      address: ACCOUNT,
    });
  });

  it('accepts a contract address unchanged', () => {
    const result = validateDestination(CONTRACT);

    expect(result.kind).toBe('contract');
    expect(result.canonical).toBe(CONTRACT);
  });

  it('accepts a liquidity pool identifier unchanged', () => {
    const result = validateDestination(LIQUIDITY_POOL);

    expect(result.kind).toBe('liquidityPool');
    expect(result.canonical).toBe(LIQUIDITY_POOL);
  });

  it('accepts a muxed account and canonicalizes it to its base account', () => {
    const result = validateDestination(MUXED);

    expect(result.kind).toBe('muxedAccount');
    expect(result.canonical).toBe(ACCOUNT);
    if (result.kind === 'muxedAccount') {
      expect(result.address).toBe(MUXED);
      expect(result.baseAddress).toBe(ACCOUNT);
      expect(result.subaccountId).toBe(1234567890n);
    }
  });

  it('reads the muxed subaccount id at both ends of its 64-bit range', () => {
    const zero = validateDestination(MUXED_ID_ZERO);
    const max = validateDestination(MUXED_ID_MAX);

    expect(zero.kind === 'muxedAccount' && zero.subaccountId).toBe(0n);
    expect(max.kind === 'muxedAccount' && max.subaccountId).toBe(18446744073709551615n);
    expect(zero.canonical).toBe(ACCOUNT);
    expect(max.canonical).toBe(ACCOUNT);
  });

  it('rejects strkey types that are not payment destinations', () => {
    expect(() => validateDestination(SECRET_SEED)).toThrow(InvalidDestinationError);
  });

  it('rejects malformed destinations', () => {
    for (const malformed of [
      '',
      'not-a-stellar-address',
      ACCOUNT.toLowerCase(),
      ACCOUNT.slice(0, -1),
      `${ACCOUNT}A`,
      `${ACCOUNT} `,
      ` ${ACCOUNT}`,
    ]) {
      expect(() => validateDestination(malformed)).toThrow(InvalidDestinationError);
    }
  });

  it('rejects a near-miss forgery that only the checksum catches', () => {
    const forged = `${ACCOUNT.slice(0, 10)}A${ACCOUNT.slice(11)}`;

    expect(forged).toHaveLength(ACCOUNT.length);
    expect(() => validateDestination(forged)).toThrow(InvalidDestinationError);
  });

  it('carries the offending destination on the error', () => {
    try {
      validateDestination('not-a-stellar-address');
      throw new Error('expected validateDestination to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDestinationError);
      expect((error as InvalidDestinationError).context.destination).toBe('not-a-stellar-address');
    }
  });
});

describe('validateDestination — composite asset identifiers', () => {
  it('accepts a fixture asset identifier', () => {
    const result = validateDestination(`SCAM:${ISSUER}`);

    expect(result).toEqual({
      kind: 'asset',
      canonical: `SCAM:${ISSUER}`,
      assetCode: 'SCAM',
      assetCodeType: 'alphanum4',
      issuer: ISSUER,
    });
  });

  it('accepts asset codes at both wire-encoding boundaries', () => {
    for (const [code, expected] of [
      ['A', 'alphanum4'],
      ['USDC', 'alphanum4'],
      ['USDCX', 'alphanum12'],
      ['ABCDEFGHIJKL', 'alphanum12'],
      ['0123456789ab', 'alphanum12'],
    ] as const) {
      const result = validateDestination(`${code}:${ISSUER}`);

      expect(result.kind).toBe('asset');
      expect(result.kind === 'asset' && result.assetCodeType).toBe(expected);
    }
  });

  it('preserves asset code case', () => {
    const result = validateDestination(`uSdC:${ISSUER}`);

    expect(result.kind === 'asset' && result.assetCode).toBe('uSdC');
    expect(result.canonical).toBe(`uSdC:${ISSUER}`);
  });

  it('rejects a 13-character asset code', () => {
    expect(() => validateDestination(`ABCDEFGHIJKLM:${ISSUER}`)).toThrow(InvalidDestinationError);
  });

  it('rejects an empty or non-alphanumeric asset code', () => {
    for (const code of ['', 'US-DC', 'US DC', 'USD€', 'USD_C', 'USD.C']) {
      expect(() => validateDestination(`${code}:${ISSUER}`)).toThrow(InvalidDestinationError);
    }
  });

  it('rejects an issuer that is not a classic account address', () => {
    for (const issuer of [
      '',
      'not-an-issuer',
      CONTRACT,
      LIQUIDITY_POOL,
      MUXED,
      ISSUER.toLowerCase(),
    ]) {
      expect(() => validateDestination(`USDC:${issuer}`)).toThrow(InvalidDestinationError);
    }
  });

  it('rejects more than one separator', () => {
    expect(() => validateDestination(`USDC:${ISSUER}:extra`)).toThrow(InvalidDestinationError);
    expect(() => validateDestination(':')).toThrow(InvalidDestinationError);
  });
});

describe('encodeAssetCode', () => {
  it('zero-pads a 1-3 character code to four bytes', () => {
    expect(encodeAssetCode('A')).toEqual(Uint8Array.from([0x41, 0, 0, 0]));
    expect(encodeAssetCode('BTC')).toEqual(Uint8Array.from([0x42, 0x54, 0x43, 0]));
  });

  it('uses all four bytes for a 4-character code, with no padding', () => {
    const encoded = encodeAssetCode('USDC');

    expect(encoded).toHaveLength(4);
    expect(encoded).toEqual(Uint8Array.from([0x55, 0x53, 0x44, 0x43]));
    expect(encoded).not.toContain(0);
  });

  it('widens to twelve bytes the moment the code exceeds four characters', () => {
    const encoded = encodeAssetCode('USDCX');

    expect(encoded).toHaveLength(12);
    // One character past the alphanum4 boundary means seven padding bytes.
    expect(encoded.subarray(5)).toEqual(new Uint8Array(7));
    expect(assetCodeType('USDCX')).toBe('alphanum12');
  });

  it('uses all twelve bytes for a 12-character code, with no padding', () => {
    const encoded = encodeAssetCode('ABCDEFGHIJKL');

    expect(encoded).toHaveLength(12);
    expect(encoded).not.toContain(0);
  });

  it('rejects codes outside the SEP-11 grammar', () => {
    for (const code of ['', 'ABCDEFGHIJKLM', 'US-DC']) {
      expect(() => encodeAssetCode(code)).toThrow(RangeError);
    }
  });
});
