import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  decodeStrKey,
  encodeStrKey,
  isValidStrKey,
  STRKEY_BASE32_ALPHABET,
  type StrKeyType,
} from '../src/StrKeyCodec';

/**
 * Differential fuzz suite.
 *
 * `@stellar/stellar-sdk`'s `StrKey` is imported **here and nowhere else** in
 * the repository: it is the ground-truth oracle this codec is checked against,
 * never a dependency of the production validation path (see
 * `src/StrKeyCodec.ts`). Every generated input must produce the same
 * accept/reject verdict from both implementations, and identical payload bytes
 * wherever both accept.
 */

/** Minimum number of distinct inputs the corpus must contain. */
const MINIMUM_CORPUS_SIZE = 5000;

/** The strkey types this codec supports, paired with the SDK's equivalents. */
const TYPES: ReadonlyArray<{
  type: StrKeyType;
  isValid: (encoded: string) => boolean;
  decode: (encoded: string) => Uint8Array;
  payloadLength: number;
}> = [
  {
    type: 'ed25519PublicKey',
    isValid: (encoded) => StrKey.isValidEd25519PublicKey(encoded),
    decode: (encoded) => StrKey.decodeEd25519PublicKey(encoded),
    payloadLength: 32,
  },
  {
    type: 'med25519PublicKey',
    isValid: (encoded) => StrKey.isValidMed25519PublicKey(encoded),
    decode: (encoded) => StrKey.decodeMed25519PublicKey(encoded),
    payloadLength: 40,
  },
  {
    type: 'contract',
    isValid: (encoded) => StrKey.isValidContract(encoded),
    decode: (encoded) => StrKey.decodeContract(encoded),
    payloadLength: 32,
  },
  {
    type: 'liquidityPool',
    isValid: (encoded) => StrKey.isValidLiquidityPool(encoded),
    decode: (encoded) => StrKey.decodeLiquidityPool(encoded),
    payloadLength: 32,
  },
];

/** Deterministic PRNG, so any disagreement reproduces exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0x5ee9);

function randomInt(bound: number): number {
  return Math.floor(random() * bound);
}

function randomBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, () => randomInt(256));
}

function randomAlphabetString(length: number): string {
  let value = '';

  for (let index = 0; index < length; index += 1) {
    value += STRKEY_BASE32_ALPHABET[randomInt(STRKEY_BASE32_ALPHABET.length)];
  }

  return value;
}

/** Characters chosen to probe the decoders' handling of near-alphabet input. */
const HOSTILE_CHARACTERS = '018=+/ \t-_:abcdefghijklmnopqrstuvwxyzé ';

function mutate(input: string): string {
  const strategy = randomInt(8);
  const index = randomInt(Math.max(input.length, 1));

  switch (strategy) {
    case 0:
      // Swap one character for another valid one — only the checksum catches it.
      return `${input.slice(0, index)}${randomAlphabetString(1)}${input.slice(index + 1)}`;
    case 1:
      // Swap in a character outside the alphabet.
      return `${input.slice(0, index)}${HOSTILE_CHARACTERS[randomInt(HOSTILE_CHARACTERS.length)]}${input.slice(index + 1)}`;
    case 2:
      return input.slice(0, index) + input.slice(index + 1);
    case 3:
      return `${input.slice(0, index)}${randomAlphabetString(1)}${input.slice(index)}`;
    case 4:
      return input.toLowerCase();
    case 5:
      return `${input}=`;
    case 6:
      // Transpose two adjacent characters.
      return index + 1 < input.length
        ? `${input.slice(0, index)}${input[index + 1]}${input[index]}${input.slice(index + 2)}`
        : input.slice(0, -1);
    default:
      // Re-badge a valid body with a different version prefix.
      return `${randomAlphabetString(1)}${input.slice(1)}`;
  }
}

/** Builds the corpus of inputs both implementations must agree on. */
function buildCorpus(): string[] {
  const corpus = new Set<string>();

  // Valid strkeys of every supported type.
  for (const { type, payloadLength } of TYPES) {
    for (let index = 0; index < 400; index += 1) {
      corpus.add(encodeStrKey(type, randomBytes(payloadLength)));
    }
  }

  // Near-valid mutations of valid strkeys.
  const valid = [...corpus];
  for (const strkey of valid) {
    for (let index = 0; index < 4; index += 1) {
      corpus.add(mutate(strkey));
    }
  }

  // Strkey-shaped strings: right alphabet and length, arbitrary content.
  for (let index = 0; index < 1200; index += 1) {
    corpus.add(randomAlphabetString([56, 56, 69, 58, 55, 57, 70].at(index % 7) as number));
  }

  // Free-form junk, including empty and non-base32 input.
  const junkLengths = [0, 1, 2, 3, 5, 8, 12, 40, 56, 69, 100, 200];
  for (let index = 0; index < 600; index += 1) {
    const length = junkLengths.at(index % junkLengths.length) as number;
    let value = '';

    for (let position = 0; position < length; position += 1) {
      value +=
        random() < 0.5
          ? randomAlphabetString(1)
          : HOSTILE_CHARACTERS[randomInt(HOSTILE_CHARACTERS.length)];
    }

    corpus.add(value);
  }

  // Fixed cases worth pinning down explicitly.
  corpus.add('');
  corpus.add('not-a-stellar-address');
  corpus.add('G');
  corpus.add('A'.repeat(56));
  corpus.add(`${'A'.repeat(55)}=`);

  return [...corpus];
}

describe('StrKeyCodec differential fuzz against @stellar/stellar-sdk', () => {
  const corpus = buildCorpus();

  it(`generates at least ${MINIMUM_CORPUS_SIZE} distinct inputs`, () => {
    expect(corpus.length).toBeGreaterThanOrEqual(MINIMUM_CORPUS_SIZE);
  });

  it('agrees with the SDK on every accept/reject verdict and payload', () => {
    for (const input of corpus) {
      for (const { type, isValid, decode } of TYPES) {
        const mine = isValidStrKey(input, type);
        const theirs = isValid(input);

        if (mine !== theirs) {
          throw new Error(
            `verdict mismatch for ${type} on ${JSON.stringify(input)}: ours=${mine} sdk=${theirs}`,
          );
        }

        if (mine) {
          const ours = decodeStrKey(input, type).payload;
          const sdk = Uint8Array.from(decode(input));

          if (ours.length !== sdk.length || ours.some((byte, index) => byte !== sdk[index])) {
            throw new Error(`payload mismatch for ${type} on ${JSON.stringify(input)}`);
          }
        }
      }
    }
  });

  it('encodes byte-for-byte identically to the SDK', () => {
    for (let index = 0; index < 500; index += 1) {
      const key = randomBytes(32);
      const id = randomBytes(8);
      const muxed = new Uint8Array(40);
      muxed.set(key, 0);
      muxed.set(id, 32);

      expect(encodeStrKey('ed25519PublicKey', key)).toBe(
        StrKey.encodeEd25519PublicKey(Buffer.from(key)),
      );
      expect(encodeStrKey('med25519PublicKey', muxed)).toBe(
        StrKey.encodeMed25519PublicKey(Buffer.from(muxed)),
      );
      expect(encodeStrKey('contract', key)).toBe(StrKey.encodeContract(Buffer.from(key)));
      expect(encodeStrKey('liquidityPool', key)).toBe(StrKey.encodeLiquidityPool(Buffer.from(key)));
    }
  });
});
