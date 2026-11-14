export interface Output {
  write(text: string): unknown;
}

/**
 * Every secret this process holds (device credentials, device codes, task tokens). Text that may
 * carry one passes through `redact` before it is printed or sent to an app.
 */
export class Secrets {
  readonly #values = new Set<string>();

  add(value: string): void {
    if (value.length > 0) this.#values.add(value);
  }

  delete(value: string): void {
    this.#values.delete(value);
  }

  redact(text: string): string {
    let out = text;
    for (const value of this.#values) out = out.split(value).join("[redacted]");
    return out;
  }
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
