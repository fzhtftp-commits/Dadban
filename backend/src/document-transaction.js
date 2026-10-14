const releasedClients = new WeakSet();

export async function rollbackQuietly(client, context) {
  if (!client) return false;
  try {
    await client.query("rollback");
    return true;
  } catch (rollbackError) {
    // A client whose rollback failed must be discarded rather than returned to the pool.
    console.error(`Database rollback failed (${context})`, { name: typeof rollbackError?.name === "string" ? rollbackError.name.slice(0, 80) : "Error", code: typeof rollbackError?.code === "string" ? rollbackError.code.slice(0, 40) : undefined });
    releasedClients.add(client);
    try {
      client.release(rollbackError);
    } catch (releaseError) {
      console.error(`Database client discard failed (${context})`, { name: typeof releaseError?.name === "string" ? releaseError.name.slice(0, 80) : "Error", code: typeof releaseError?.code === "string" ? releaseError.code.slice(0, 40) : undefined });
    }
    return false;
  }
}

export function releaseClient(client) {
  if (!client || releasedClients.has(client)) return;
  releasedClients.add(client);
  client.release();
}
