/**
 * Capture-time redaction. Secret values are registered with the redactor the
 * instant they exist (inside SecretBroker.seal, before seal returns), so no
 * later code path — logging, error formatting, journaling, subprocess output
 * capture — can observe an unredacted buffer through this module.
 */
export class Redactor {
  private readonly entries = new Map<string, string>();

  /** Register a raw secret and the label shown in its place. */
  register(raw: string, label: string): void {
    if (raw.length < 6) return; // refuse to redact trivia; would mangle output
    this.entries.set(raw, label);
    // Common encodings a secret can leak through.
    this.entries.set(encodeURIComponent(raw), label);
    this.entries.set(Buffer.from(raw, "utf8").toString("base64"), label);
  }

  redact(text: string): string {
    let out = text;
    for (const [raw, label] of this.entries) {
      if (out.includes(raw)) out = out.split(raw).join(`[redacted:${label}]`);
    }
    return out;
  }

  /** True when the text still contains a registered secret in any known encoding. */
  contains(text: string): boolean {
    for (const raw of this.entries.keys()) {
      if (text.includes(raw)) return true;
    }
    return false;
  }
}
