const releasedClients = new WeakSet();

export async function rollbackQuietly(client, context) {
  if (!client) return false;
  try {
    await client.query("rollback");
    return true;
  } catch (rollbackError) {
    // A client whose rollback failed must be discarded rather than returned to the pool.
    console.error(`Database rollback failed (${context}):`, rollbackError);
    releasedClients.add(client);
    try {
      client.release(rollbackError);
    } catch (releaseError) {
      console.error(`Database client discard failed (${context}):`, releaseError);
    }
    return false;
  }
}

export function releaseClient(client) {
  if (!client || releasedClients.has(client)) return;
  releasedClients.add(client);
  client.release();
}
