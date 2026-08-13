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

  const proc = spawn("node", [serverPath], {
    env: { ...process.env },
    stdio: "inherit",
  });

  proc.on("error", (err) => {
    logger.error({ err }, "Failed to start ride-hailing server");
    process.exit(1);
  });

  proc.on("exit", (code, signal) => {
    logger.info({ code, signal }, "Ride-hailing server exited");
    process.exit(code ?? 1);
  });
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
