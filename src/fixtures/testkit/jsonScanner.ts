/**
 * A minimal, hand-rolled incremental (SAX-style) JSON tokenizer.
 *
 * This intentionally does NOT build a JS object graph the way `JSON.parse`
 * does. It exposes token-at-a-time primitives (read a string, try to read a
 * number, skip an unneeded value, ...) over a source string, and tracks the
 * current line/column/offset as it goes. Callers (see schema.ts) use these
 * primitives to validate a specific known schema entry-by-entry, so a bad
 * entry can be caught — with an accurate source position — without the rest
 * of the file ever being tokenized.
 *
 * This is deliberately scoped to what the vendored fixture schemas need
 * (flat objects, arrays of flat objects, strings, numbers) rather than
 * being a general-purpose JSON library.
 */

export interface SourcePosition {
  /** 0-based character offset into the source text. */
  readonly offset: number;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly column: number;
}

/** Thrown for malformed JSON syntax the scanner encounters (not schema violations). */
export class JsonSyntaxError extends Error {
  constructor(
    public readonly file: string,
    public readonly position: SourcePosition,
    detail: string,
  ) {
    super(
      `Malformed JSON in "${file}" at line ${position.line}, column ${position.column} ` +
        `(offset ${position.offset}): ${detail}`,
    );
    this.name = 'JsonSyntaxError';
  }
}

const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export type TokenDescription =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'object'; raw: string }
  | { kind: 'array'; raw: string };

/** Renders a token description the same way schema.ts's legacy `describe()` does. */
export function describeToken(token: TokenDescription): string {
  switch (token.kind) {
    case 'string':
      return `string (${JSON.stringify(token.value)})`;
    case 'number':
      return `number (${token.value})`;
    case 'boolean':
      return `boolean (${token.value})`;
    case 'null':
      return 'null';
    case 'array':
      return 'an array';
    case 'object':
      return `object (${token.raw})`;
  }
}

/**
 * Token-at-a-time cursor over a JSON source string. Every read advances
 * `offset`; whitespace is the only place newlines are tracked (no JSON
 * token itself may legally contain a raw, unescaped newline), so position
 * bookkeeping stays O(1) per character actually scanned rather than
 * requiring a re-scan of consumed text.
 */
export class JsonScanner {
  private i = 0;
  private line = 1;
  private lineStartOffset = 0;

  constructor(
    private readonly text: string,
    private readonly file: string,
  ) {}

  get position(): SourcePosition {
    return { offset: this.i, line: this.line, column: this.i - this.lineStartOffset + 1 };
  }

  atEnd(): boolean {
    return this.i >= this.text.length;
  }

  error(detail: string, position: SourcePosition = this.position): JsonSyntaxError {
    return new JsonSyntaxError(this.file, position, detail);
  }

  skipWhitespace(): void {
    const text = this.text;
    while (this.i < text.length) {
      const c = text.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0d) {
        this.i++;
      } else if (c === 0x0a) {
        this.i++;
        this.line++;
        this.lineStartOffset = this.i;
      } else {
        break;
      }
    }
  }

  peekChar(): string | undefined {
    return this.text[this.i];
  }

  consumeChar(expected: string): void {
    if (this.text[this.i] !== expected) {
      throw this.error(
        `expected "${expected}", got ${this.atEnd() ? 'end of input' : JSON.stringify(this.text[this.i])}`,
      );
    }
    this.i++;
  }

  /** Reads a `"..."` string token, decoding escapes. Throws on malformed syntax. */
  readString(): string {
    const start = this.i;
    if (this.text[this.i] !== '"') {
      throw this.error(`expected a string, got ${this.atEnd() ? 'end of input' : JSON.stringify(this.text[this.i])}`);
    }
    this.i++;
    let out = '';
    let chunkStart = this.i;
    while (true) {
      if (this.i >= this.text.length) {
        throw this.error('unterminated string', { offset: start, line: this.line, column: start - this.lineStartOffset + 1 });
      }
      const c = this.text.charCodeAt(this.i);
      if (c === 0x22 /* " */) {
        out += this.text.slice(chunkStart, this.i);
        this.i++;
        return out;
      }
      if (c === 0x5c /* \ */) {
        out += this.text.slice(chunkStart, this.i);
        this.i++;
        const esc = this.text[this.i];
        switch (esc) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = this.text.slice(this.i + 1, this.i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw this.error('invalid \\u escape');
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.i += 4;
            break;
          }
          default:
            throw this.error(`invalid escape "\\${esc}"`);
        }
        this.i++;
        chunkStart = this.i;
        continue;
      }
      this.i++;
    }
  }

  /** Reads a string only if the next token is one; otherwise returns undefined without consuming input. */
  tryReadString(): string | undefined {
    if (this.text[this.i] !== '"') return undefined;
    return this.readString();
  }

  /** Reads a JSON number only if the next token looks like one; otherwise returns undefined. */
  tryReadNumber(): number | undefined {
    NUMBER_PATTERN.lastIndex = this.i;
    const match = NUMBER_PATTERN.exec(this.text);
    if (!match || match.index !== this.i || match[0].length === 0) return undefined;
    this.i += match[0].length;
    return Number(match[0]);
  }

  private tryReadKeyword(word: string): boolean {
    if (this.text.startsWith(word, this.i)) {
      this.i += word.length;
      return true;
    }
    return false;
  }

  /**
   * Reads and describes the next JSON value generically, for error messages
   * only (e.g. "expected a number, got string (\"10\")"). Consumes exactly
   * that one value's tokens — objects/arrays are skipped as balanced spans
   * rather than materialized, so describing a bad value never requires
   * tokenizing more than that value's own span.
   */
  readValueForDescription(): TokenDescription {
    this.skipWhitespace();
    const c = this.peekChar();
    if (c === '"') {
      return { kind: 'string', value: this.readString() };
    }
    if (c === '{') {
      return { kind: 'object', raw: this.skipBalanced('{', '}') };
    }
    if (c === '[') {
      return { kind: 'array', raw: this.skipBalanced('[', ']') };
    }
    if (this.tryReadKeyword('true')) return { kind: 'boolean', value: true };
    if (this.tryReadKeyword('false')) return { kind: 'boolean', value: false };
    if (this.tryReadKeyword('null')) return { kind: 'null' };
    const num = this.tryReadNumber();
    if (num !== undefined) return { kind: 'number', value: num };
    throw this.error(`unexpected token ${this.atEnd() ? 'end of input' : JSON.stringify(this.text[this.i])}`);
  }

  /** Skips (discards) the next JSON value without describing it. */
  skipValue(): void {
    this.readValueForDescription();
  }

  /**
   * Consumes a balanced `open`...`close` span starting at the current
   * position (which must be `open`), respecting string literals so brackets
   * inside strings don't affect the depth count. Returns the raw source
   * text of the span. Only scans that span, not the remainder of the file.
   */
  private skipBalanced(open: string, close: string): string {
    const start = this.i;
    this.consumeChar(open);
    let depth = 1;
    while (depth > 0) {
      if (this.i >= this.text.length) {
        throw this.error(`unterminated "${open}"`, { offset: start, line: this.line, column: start - this.lineStartOffset + 1 });
      }
      const c = this.text[this.i];
      if (c === '"') {
        this.readString();
        continue;
      }
      if (c === open) depth++;
      else if (c === close) depth--;
      this.i++;
    }
    return this.text.slice(start, this.i);
  }
}
