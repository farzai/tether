export interface Output {
  write(text: string): unknown;
}

/** An encoded form shorter than this is not matched, so short values do not redact ordinary text. */
export const MIN_ENCODED_LENGTH = 16;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The base64 text that stands for `bytes` wherever they sit in a longer value: for each of the
 * three byte offsets, the characters that depend only on the secret's own bytes. Both alphabets.
 */
function base64Forms(bytes: Buffer): string[] {
  const forms: string[] = [];
  for (const offset of [0, 1, 2]) {
    const text = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    forms.push(text.slice(start, end));
  }
  // A secret encoded on its own ends in a last character (and padding) that the cores leave out.
  const whole = bytes.toString("base64");
  forms.push(whole, whole.replace(/=+$/, ""));
  return forms.flatMap((form) => [form, form.replace(/\+/g, "-").replace(/\//g, "_")]);
}

/** One percent-escaped byte, hex digits in either case. */
function percentByte(byte: number): string {
  const digits = byte.toString(16).padStart(2, "0");
  return `%${[...digits].map((d) => (/[a-f]/.test(d) ? `[${d}${d.toUpperCase()}]` : d)).join("")}`;
}

/**
 * Percent-encoded forms as patterns: as `encodeURIComponent` writes it, and with every byte
 * escaped. Each only when its encoded text is long enough.
 */
function percentPatterns(value: string, bytes: Buffer): string[] {
  const patterns: string[] = [];
  const component = encodeURIComponent(value);
  if (component !== value && component.length >= MIN_ENCODED_LENGTH) {
    const parts = component.split(/(%[0-9A-F]{2})/);
    patterns.push(
      parts
        .map((part) =>
          part.startsWith("%")
            ? percentByte(Number.parseInt(part.slice(1), 16))
            : escapeRegExp(part),
        )
        .join(""),
    );
  }
  if (bytes.length * 3 >= MIN_ENCODED_LENGTH) patterns.push([...bytes].map(percentByte).join(""));
  return patterns;
}

/** The patterns that match one secret: itself, and its encoded forms that are long enough. */
function secretPatterns(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = base64Forms(bytes).filter((form) => form.length >= MIN_ENCODED_LENGTH);
  return [escapeRegExp(value), ...base64.map(escapeRegExp), ...percentPatterns(value, bytes)];
}

/**
 * Every secret this process holds (device credentials, device codes, task tokens, the agent's own
 * API key). Text that may carry one, raw, in base64 or percent-encoded, passes through `redact`
 * before it is printed or sent to an app.
 */
export class Secrets {
  /** Each secret with its own patterns, so deleting one never drops another's. */
  readonly #patterns = new Map<string, string[]>();
  #matcher: RegExp | undefined;

  add(value: string): void {
    if (value.length === 0 || this.#patterns.has(value)) return;
    this.#patterns.set(value, secretPatterns(value));
    this.#matcher = undefined;
  }

  delete(value: string): void {
    if (this.#patterns.delete(value)) this.#matcher = undefined;
  }

  redact(text: string): string {
    if (this.#patterns.size === 0) return text;
    this.#matcher ??= matcher([...this.#patterns.values()].flat());
    return text.replace(this.#matcher, "[redacted]");
  }
}

/** One pattern for all secrets, longest first, so a longer form wins over a shorter one inside it. */
function matcher(patterns: string[]): RegExp {
  const unique = [...new Set(patterns)].sort((a, b) => b.length - a.length);
  return new RegExp(unique.join("|"), "g");
}

// C0 controls, DEL, C1 controls, and the bidirectional overrides that can reorder what a terminal
// shows. App and agent text can carry any of them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g;

/** One line of untrusted text, safe to print: control characters become a space. */
export function clean(text: string, max = 2000): string {
  const line = text.replace(UNSAFE, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** Prints lines of text that may hold app or agent content: redacted, then cleaned. */
export class Log {
  readonly #out: Output;
  readonly #secrets: Secrets;

  constructor(out: Output, secrets: Secrets) {
    this.#out = out;
    this.#secrets = secrets;
  }

  line(text: string): void {
    this.#out.write(`${clean(this.#secrets.redact(text), 10_000)}\n`);
  }
}
