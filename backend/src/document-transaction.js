const releasedClients = new WeakSet();
const clientErrorHandlers = new WeakMap();
const clientErrors = new WeakMap();

const safeErrorMetadata = error => ({
  name: typeof error?.name === "string" ? error.name.slice(0, 80) : "Error",
  code: typeof error?.code === "string" ? error.code.slice(0, 40) : undefined
});

const detachClientErrorHandler = client => {
  const handler = clientErrorHandlers.get(client);
  if (handler) client.removeListener?.("error", handler);
  clientErrorHandlers.delete(client);
};

const discardClient = (client, error, context) => {
  if (!client || releasedClients.has(client)) return;
  releasedClients.add(client);
  detachClientErrorHandler(client);
  try {
    client.release(error);
  } catch (releaseError) {
    console.error(`Database client discard failed (${context})`, safeErrorMetadata(releaseError));
  }
};

export async function acquireClient(pool) {
  const client = await pool.connect();
  // pg.Pool may hand the same PoolClient object out again after release.
  // Reset the one-checkout release guard and connection-error state on checkout.
  releasedClients.delete(client);
  clientErrors.delete(client);
  detachClientErrorHandler(client);
  // A checked-out pg Client may emit a connection-level 'error' in addition to
  // rejecting the active query. Always observe it so a lost COMMIT response cannot
  // become an unhandled EventEmitter error that terminates the API process.
  const onClientError = error => {
    clientErrors.set(client, error);
    console.error("Database client connection failed", safeErrorMetadata(error));
  };
  client.on?.("error", onClientError);
  clientErrorHandlers.set(client, onClientError);
  return client;
}

export async function rollbackQuietly(client, context) {
  if (!client) return false;
  const connectionError = clientErrors.get(client);
  if (connectionError) {
    // Once the connection has failed, a rollback attempt cannot prove transaction
    // outcome. Discard the client and let the caller report an unknown DB outcome.
    discardClient(client, connectionError, context);
    return false;
  }
  try {
    await client.query("rollback");
    return true;
  } catch (rollbackError) {
    // A client whose rollback failed must be discarded rather than returned to the pool.
    console.error(`Database rollback failed (${context})`, safeErrorMetadata(rollbackError));
    discardClient(client, rollbackError, context);
    return false;
  }
}

export function releaseClient(client) {
  if (!client || releasedClients.has(client)) return;
  const connectionError = clientErrors.get(client);
  if (connectionError) {
    discardClient(client, connectionError, "release after connection error");
    return;
  }
  releasedClients.add(client);
  detachClientErrorHandler(client);
  client.release();
}
