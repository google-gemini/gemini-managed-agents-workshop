// Minimal structured logger. Callers must never pass tokens, codes, keys, or full error objects.

type Meta = Record<string, string | number | boolean | undefined>;

function line(level: string, message: string, meta?: Meta): string {
  const extras = meta
    ? Object.entries(meta)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ")
    : "";
  return `${new Date().toISOString()} ${level} ${message}${extras ? " " + extras : ""}`;
}

export const log = {
  info: (message: string, meta?: Meta) => console.log(line("INFO ", message, meta)),
  warn: (message: string, meta?: Meta) => console.warn(line("WARN ", message, meta)),
  error: (message: string, meta?: Meta) => console.error(line("ERROR", message, meta)),
};

/** Safe one-line error summary: name + status + clipped message, never raw request/response payloads. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return `${err.name}${typeof status === "number" ? ` ${status}` : ""}: ${err.message.slice(0, 200)}`;
  }
  return "non-error thrown";
}
