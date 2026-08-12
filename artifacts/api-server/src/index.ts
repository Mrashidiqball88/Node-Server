import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import {
  closeMongoDB,
  connectToMongoDB,
} from "./lib/mongodb";
import { initializeRealtime } from "./realtime";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function startServer(): Promise<void> {
  try {
    await connectToMongoDB();

    const server = createServer(app);
    initializeRealtime(server);
    server.listen(port, () => {
      logger.info({ port }, "Server listening");
    });

    const shutdown = async (signal: string) => {
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
  } catch (err) {
    logger.error({ err }, "Unable to connect to MongoDB");
    process.exit(1);
  }
}

void startServer();
