/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
