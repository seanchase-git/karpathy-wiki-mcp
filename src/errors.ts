/**
 * An error meant to be read by the calling model. `fix` says what to do instead and
 * `example` shows a corrected call, because small models recover far better from a
 * concrete example than from a bare message.
 */
export class WikiError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
    readonly example?: string,
  ) {
    super(message);
    this.name = "WikiError";
  }

  format(): string {
    const lines = [`Error: ${this.message}`];
    if (this.fix) lines.push(`Fix: ${this.fix}`);
    if (this.example) lines.push(`Example: ${this.example}`);
    return lines.join("\n");
  }
}
