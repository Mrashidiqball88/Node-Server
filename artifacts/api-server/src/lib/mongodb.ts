import { MongoClient, type Db } from "mongodb";
import { logger } from "./logger";

const mongoUri = process.env["MONGO_URI"];

if (!mongoUri) {
  throw new Error(
    "MONGO_URI environment variable is required but was not provided.",
  );
}

export const mongoClient = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 5_000,
});

let database: Db | undefined;

export async function connectToMongoDB(): Promise<Db> {
  if (database) {
    return database;
  }

  await mongoClient.connect();
  database = mongoClient.db();
  logger.info("Connected to MongoDB");
  return database;
}

export function isMongoDBConnected(): boolean {
  return database !== undefined;
}

export async function closeMongoDB(): Promise<void> {
  if (!database) {
    return;
  }

  await mongoClient.close();
  database = undefined;
  logger.info("Disconnected from MongoDB");
}