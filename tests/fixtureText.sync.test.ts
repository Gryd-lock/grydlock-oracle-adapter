import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_TEXT_FILES, generatedModuleSource } from '../scripts/generate-fixture-text.mjs';

const fixturesDir = join(__dirname, '..', 'src', 'fixtures', 'testkit');

describe('generated fixture text modules', () => {
  it.each(FIXTURE_TEXT_FILES)(
    '$ts is in sync with $json (run `npm run generate:fixtures` if this fails)',
    ({ json, ts }) => {
      const committed = readFileSync(join(fixturesDir, ts), 'utf-8');
      const expected = generatedModuleSource(json);
      expect(committed).toBe(expected);
    },
  );
});
