import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// node-postgres emits 'error' on the pool for problems with *idle* clients
// (e.g. the server terminating a connection, a network blip) — these are
// not tied to any in-flight query, so without a listener here they surface
// as an uncaught exception and take the whole process down. Log and let
// the pool recover by creating a fresh connection on the next query.
pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
});
export const db = drizzle(pool, { schema });

export * from "./schema";
