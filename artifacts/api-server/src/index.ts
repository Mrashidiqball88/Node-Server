import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { closeMongoDB, connectToMongoDB } from "./lib/mongodb";
import { initializeRealtime } from "./realtime";

/**
 * In production the platform runs this compiled file via artifact mode.
 * The ride-hailing Express server already provides the full stack —
 * HTML apps, all /api/* routes, Socket.io, and graceful MongoDB fallback —
 * so we delegate to it rather than duplicating that logic here.
 *
 * In development the TypeScript api-server runs normally so local tooling
 * and the monorepo workflow are unaffected.
 */
if (process.env.NODE_ENV !== "development") {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  // dist/index.mjs lives at artifacts/api-server/dist/
  // ride-hailing/server.js lives at the workspace root (three levels up)
  const distDir = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(distDir, "../../../ride-hailing/server.js");

  logger.info({ serverPath }, "Production mode — delegating to ride-hailing server");

  // Auto-restart with exponential backoff so a transient crash never takes
  // down the VM permanently. Back off up to 30 s to avoid a crash loop.
  let restartDelayMs = 1_000;
  const MAX_RESTART_DELAY_MS = 30_000;

  function launchRideHailing(): void {
    logger.info({ serverPath, restartDelayMs }, "Spawning ride-hailing server");

    const proc = spawn("node", [serverPath], {
      env: { ...process.env },
      stdio: "inherit",
    });

    // Reset backoff after the child has been alive for at least 30 s
    const stableTimer = setTimeout(() => { restartDelayMs = 1_000; }, 30_000);

    proc.on("error", (err) => {
      clearTimeout(stableTimer);
      logger.error({ err }, "Failed to start ride-hailing server — will retry");
      scheduleRestart();
    });

    proc.on("exit", (code, signal) => {
      clearTimeout(stableTimer);
      // Graceful shutdown: propagate and exit cleanly
      if (signal === "SIGTERM" || signal === "SIGINT") {
        logger.info({ code, signal }, "Ride-hailing server stopped gracefully");
        process.exit(0);
      }
      logger.warn({ code, signal }, "Ride-hailing server crashed — restarting");
      scheduleRestart();
    });
  }

  function scheduleRestart(): void {
    logger.info({ retryInMs: restartDelayMs }, "Scheduling ride-hailing restart");
    setTimeout(() => {
      restartDelayMs = Math.min(restartDelayMs * 2, MAX_RESTART_DELAY_MS);
      launchRideHailing();
    }, restartDelayMs);
  }

  // Forward SIGTERM/SIGINT to the child so it can shut down cleanly
  process.on("SIGTERM", () => process.kill(process.pid, "SIGTERM"));
  process.on("SIGINT",  () => process.kill(process.pid, "SIGINT"));

  launchRideHailing();
} else {
  // ── Development: run the compiled TypeScript api-server normally ──────────

  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error("PORT environment variable is required but was not provided.");
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  async function startServer(): Promise<void> {
    try {
      await connectToMongoDB();
    } catch (err) {
      logger.error({ err }, "Unable to connect to MongoDB — exiting");
      process.exit(1);
    }

    const server = createServer(app);
    initializeRealtime(server);

    server.listen(port, () => {
      logger.info({ port }, "Server listening");
    });

    const shutdown = async (signal: string): Promise<void> => {
      logger.info({ signal }, "Shutdown signal received");
      server.close(async (err) => {
        if (err) {
          logger.error({ err }, "Error closing HTTP server");
          process.exitCode = 1;
        }
        try {
          await closeMongoDB();
        } catch (closeError) {
          logger.error({ err: closeError }, "Error closing MongoDB connection");
          process.exitCode = 1;
        }
      });
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  }

  void startServer();
}
