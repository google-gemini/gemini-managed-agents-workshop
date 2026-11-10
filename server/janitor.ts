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

// Cleanup of remote resources (vault credentials + sandboxes) tied to sessions.

import type { Store } from "express-session";
import { ABSOLUTE_TIMEOUT_MS, CREDENTIAL_PREFIX } from "./config.ts";
import type { GeminiClient } from "./gemini.ts";
import { describeError, log } from "./log.ts";
import type { RemoteResources } from "./types.ts";

const GRACE_MS = ABSOLUTE_TIMEOUT_MS + 15 * 60_000;
const MAX_PAGES = 20;

export async function cleanupRemoteResources(gemini: GeminiClient, resources: RemoteResources): Promise<void> {
  if (!gemini.isConfigured) return;
  const tasks: Array<Promise<void>> = [];
  if (resources.credentialId && resources.credentialId.startsWith(CREDENTIAL_PREFIX)) {
    tasks.push(gemini.deleteCredential(resources.credentialId));
  }
  if (resources.environmentId) {
    tasks.push(gemini.deleteEnvironment(resources.environmentId));
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") {
      log.warn("cleanup failed (janitor will retry orphaned credentials)", { error: describeError(r.reason) });
    }
  }
}

function activeCredentialIds(store: Store): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    if (typeof store.all !== "function") return resolve(null);
    store.all((err, sessions) => {
      if (err) return resolve(null);
      const list = Array.isArray(sessions) ? sessions : Object.values(sessions ?? {});
      const ids = new Set<string>();
      for (const s of list) if (typeof s?.credentialId === "string") ids.add(s.credentialId);
      resolve(ids);
    });
  });
}

export async function sweepOrphanedCredentials(gemini: GeminiClient, store: Store): Promise<number> {
  if (!gemini.isConfigured) return 0;
  const active = await activeCredentialIds(store);
  if (!active) return 0;
  const now = Date.now();
  let deleted = 0;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await gemini.listCredentials(pageToken);
    for (const c of res.credentials) {
      if (!c.id || !c.id.startsWith(CREDENTIAL_PREFIX) || active.has(c.id)) continue;
      const created = Date.parse(c.create_time ?? "");
      if (!Number.isFinite(created) || now - created < GRACE_MS) continue;
      try {
        await gemini.deleteCredential(c.id);
        deleted++;
      } catch (err) {
        log.warn("janitor: delete failed", { error: describeError(err) });
      }
    }
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return deleted;
}

export function startJanitor(gemini: GeminiClient, store: Store, intervalMs = 10 * 60_000): () => void {
  let running = false;
  const run = async () => {
    if (running || !gemini.isConfigured) return;
    running = true;
    try {
      const deleted = await sweepOrphanedCredentials(gemini, store);
      if (deleted > 0) log.info("janitor: removed orphaned credentials", { deleted });
    } catch (err) {
      log.warn("janitor: sweep failed", { error: describeError(err) });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
