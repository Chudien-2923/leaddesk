import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { getDatabaseConfig } from "../config";

const server = globalThis as typeof globalThis & { leadDeskPool?: Pool };
const connections = new AsyncLocalStorage<ReadonlyMap<Pool, PoolClient>>();

export function getPool(): Pool {
  return server.leadDeskPool ??= new Pool({
    connectionString: getDatabaseConfig().DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

// Repository calls inside a lock use its connection, including single-connection pools.
export function getQueryExecutor(pool: Pool): Pool | PoolClient {
  return connections.getStore()?.get(pool) ?? pool;
}

export function withDatabaseConnection<T>(pool: Pool, client: PoolClient, action: () => Promise<T>): Promise<T> {
  const scoped = new Map(connections.getStore());
  scoped.set(pool, client);
  return connections.run(scoped, action);
}
