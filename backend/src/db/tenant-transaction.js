import { z } from "zod";

const officeIdSchema = z.string().uuid();

/**
 * Run tenant-data queries with transaction-local office context.
 *
 * IMPORTANT: This helper is a building block only until every tenant-data
 * query is migrated to use it and matching RLS policies are installed.
 * Never set app.current_office_id at session scope on a pooled connection.
 */
export async function withOfficeTransaction(pool, officeId, callback) {
  const parsedOfficeId = officeIdSchema.safeParse(officeId);
  if (!parsedOfficeId.success) {
    throw new TypeError("A valid authenticated office ID is required");
  }
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL pool is required");
  }
  if (typeof callback !== "function") {
    throw new TypeError("A transaction callback is required");
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    // The third argument makes this setting transaction-local. PostgreSQL
    // automatically clears it on COMMIT/ROLLBACK before the pooled client
    // can be reused by another request.
    await client.query(
      "SELECT set_config('app.current_office_id', $1, true)",
      [parsedOfficeId.data]
    );

    const result = await callback(client);
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original query/callback error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
