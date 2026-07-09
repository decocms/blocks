#!/usr/bin/env -S npx tsx
/**
 * E2E Test Runner Script
 * ======================
 * This script:
 * 1. Checks if the dev server is already running on port 3000 (Vite/Next default)
 * 2. If not, starts it in the background
 * 3. Waits for the server to be ready (liveness check)
 * 4. Runs the e2e tests
 * 5. Reports the results
 * 6. Cleans up server on exit (including Ctrl+C)
 *
 * Usage:
 *   npm run test:e2e             # Run tests (auto-start server if needed)
 *   npm run test:e2e:headed      # Run tests with visible browser
 *
 * Placeholders to replace:
 *   {{SITE_NAME}} - Your site name (e.g., "lojastorra-2")
 */

import { spawn, type ChildProcess } from "node:child_process";

const SITE_URL = "http://localhost:3000";
const LIVENESS_PATH = "/deco/_liveness";
const E2E_DIR = "./tests/e2e";
const MAX_LIVENESS_RETRIES = 60;
const LIVENESS_RETRY_DELAY = 1000;

// Global state for cleanup
let serverProcess: ChildProcess | null = null;
let serverStartedByUs = false;
let isCleaningUp = false;

function cleanup(exitCode: number = 1): void {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (serverProcess && serverStartedByUs) {
    console.log("\n🛑 Stopping dev server...");
    try {
      serverProcess.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }
    // Give it a moment to terminate gracefully, then force kill
    setTimeout(() => {
      try {
        serverProcess?.kill("SIGKILL");
      } catch {
        // Ignore
      }
      process.exit(exitCode);
    }, 1000);
  } else {
    process.exit(exitCode);
  }
}

// Handle Ctrl+C and other termination signals
process.on("SIGINT", () => {
  console.log("\n⚠️ Interrupted (Ctrl+C)");
  cleanup(130); // Standard exit code for SIGINT
});

process.on("SIGTERM", () => {
  console.log("\n⚠️ Terminated");
  cleanup(143); // Standard exit code for SIGTERM
});

// Handle uncaught errors
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled error:", reason);
  cleanup(1);
});

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${SITE_URL}${LIVENESS_PATH}`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(): Promise<boolean> {
  console.log("⏳ Waiting for server to be ready...");

  for (let i = 0; i < MAX_LIVENESS_RETRIES; i++) {
    if (await isServerRunning()) {
      console.log(`✅ Server is ready (attempt ${i + 1})`);
      return true;
    }
    await new Promise((r) => setTimeout(r, LIVENESS_RETRY_DELAY));
    if ((i + 1) % 10 === 0) {
      console.log(`   Still waiting... (${i + 1}/${MAX_LIVENESS_RETRIES})`);
    }
  }

  return false;
}

async function startServer(): Promise<ChildProcess> {
  console.log("🚀 Starting dev server...");

  // "bun run dev" for TanStack Start sites, "npm run dev" for Next.js sites
  // (both invoke `package.json`'s "dev" script — vite dev / next dev under
  // the hood). Swap the command below if this site uses npm instead of bun.
  const child = spawn("bun", ["run", "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Log server output in background — Vite prints "ready in", Next prints
  // "Ready in" / "started server on". Neither runtime prints "Fresh ready"
  // (that was the old Deno/Fresh dev server's banner).
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (/ready in|started server|listening/i.test(text)) {
      console.log("   📡 Server started");
    }
  });

  return child;
}

async function runTests(headed: boolean = false): Promise<boolean> {
  console.log(`\n🧪 Running e2e tests${headed ? " (headed mode)" : ""}...\n`);

  const args = ["test", "--project=desktop-chrome"];
  if (headed) {
    args.push("--headed");
  }

  return await new Promise<boolean>((resolve) => {
    const child = spawn("npm", args, {
      cwd: E2E_DIR,
      env: {
        ...process.env,
        SITE_URL,
        HEADED: headed ? "true" : "false",
      },
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code === 0));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const headed = args.includes("--headed") || args.includes("-h");
  const skipServerCheck = args.includes("--skip-server-check");

  try {
    // Check if server is already running
    if (!skipServerCheck) {
      const serverAlreadyRunning = await isServerRunning();

      if (serverAlreadyRunning) {
        console.log("✅ Dev server already running");
      } else {
        // Start the server
        serverProcess = await startServer();
        serverStartedByUs = true;

        // Wait for it to be ready
        const ready = await waitForServer();
        if (!ready) {
          console.error("❌ Server failed to start within timeout");
          cleanup(1);
          return;
        }
      }
    }

    // Run the tests
    const testsPassed = await runTests(headed);

    if (testsPassed) {
      console.log("\n✅ All tests passed!");
    } else {
      console.log("\n❌ Some tests failed");
    }

    cleanup(testsPassed ? 0 : 1);
  } catch (err) {
    console.error("❌ Error:", err);
    cleanup(1);
  }
}

main();
