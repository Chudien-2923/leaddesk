import { readdir, readFile } from "node:fs/promises";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

export interface TestDatabase {
  pool: Pool;
  createPool(max?: number): Pool;
  stop(): Promise<void>;
}

// Every connection originates from this disposable container, never DATABASE_URL.
export async function startTestDatabase(): Promise<TestDatabase> {
  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
      .withDatabase("leaddesk_regression")
      .withUsername("leaddesk_test")
      .withPassword("container-only-test-password")
      .start();
  } catch (cause) {
    throw new Error(
      "DB regression tests require a working Docker daemon and the pgvector/pgvector:pg16 image. Start Docker Desktop (or your Docker-compatible runtime) and rerun the db project. Tests cannot skip or fall back to DATABASE_URL/.env.local.",
      { cause },
    );
  }

  const pools: Pool[] = [];
  const createPool = (max = 6): Pool => {
    const pool = new Pool({
      connectionString: container.getConnectionUri(),
      max,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 1_000,
    });
    pools.push(pool);
    return pool;
  };
  const pool = createPool();
  const stop = async (): Promise<void> => {
    try {
      await Promise.all(pools.map((ownedPool) => ownedPool.end()));
    } finally {
      await container.stop();
    }
  };

  try {
    // Supabase supplies these roles; the isolated PostgreSQL image does not.
    // No test grants the roles table access: migrations must secure that boundary.
    await pool.query("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
    const migrationsDirectory = new URL("../../supabase/migrations/", import.meta.url);
    let filenames: string[];
    try {
      filenames = (await readdir(migrationsDirectory))
        .filter((filename) => filename.endsWith(".sql"))
        .sort();
    } catch (cause) {
      throw new Error("DB regression requires supabase/migrations/*.sql; no migrations directory exists.", { cause });
    }
    if (filenames.length === 0) {
      throw new Error("DB regression requires at least one supabase/migrations/*.sql migration; refusing an empty schema.");
    }
    for (const filename of filenames) {
      await pool.query(await readFile(new URL(filename, migrationsDirectory), "utf8"));
    }
  } catch (cause) {
    await stop();
    throw cause;
  }

  return { pool, createPool, stop };
}

export function deferred<T>() {
  return Promise.withResolvers<T>();
}

// A broken blocking lock must fail quickly instead of hanging the test process.
export async function within<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer: NodeJS.Timeout = setTimeout(
    () => timeout.reject(new Error(`Operation did not settle within ${milliseconds}ms`)),
    milliseconds,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}
