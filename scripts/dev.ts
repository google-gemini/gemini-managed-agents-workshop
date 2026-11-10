// Development runner: builds & watches `web/` with Vite and runs `server/index.ts`.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const serverEntry = "server/index.ts";
const hasEnvFile = existsSync(path.join(ROOT_DIR, ".env"));
const hasWebEntry = existsSync(path.join(ROOT_DIR, "web", "index.html"));

const children: Array<ReturnType<typeof Bun.spawn>> = [];
let shuttingDown = false;

function cleanup(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
  setTimeout(() => process.exit(exitCode), 150).unref();
}

process.once("SIGINT", () => cleanup(0));
process.once("SIGTERM", () => cleanup(0));

if (hasWebEntry) {
  console.log("[dev] Building initial web bundle (dist/web) ...");
  const initialBuild = Bun.spawnSync(["bunx", "--bun", "vite", "build"], {
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (initialBuild.exitCode !== 0) {
    console.warn("[dev] Initial vite build reported an error; continuing with --watch ...");
  }

  const viteWatcher = Bun.spawn(["bunx", "--bun", "vite", "build", "--watch"], {
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(viteWatcher);
} else {
  console.log("[dev] web/index.html not found yet; skipping Vite watcher.");
}

if (!hasEnvFile) {
  console.warn("[dev] Note: .env file not found yet (copy .env.example to .env when ready).");
}

const serverArgs = ["bun", "--watch", ...(hasEnvFile ? ["--env-file=.env"] : []), serverEntry];
console.log(`[dev] Starting server (${serverEntry}) ...`);

const serverProc = Bun.spawn(serverArgs, {
  cwd: ROOT_DIR,
  stdout: "inherit",
  stderr: "inherit",
});
children.push(serverProc);

const code = await serverProc.exited;
cleanup(code);
