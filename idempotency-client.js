(function () {
  const storagePrefix = "dadban:mutation-key:v1:";
  const normalizeBody = (body) => {
    if (body == null) return "";
    try {
      const value = typeof body === "string" ? JSON.parse(body) : body;
      const canonical = (item) => Array.isArray(item)
        ? item.map(canonical)
        : item && typeof item === "object"
          ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]))
          : item;
      return JSON.stringify(canonical(value));
    } catch {
      return String(body);
    }
  };
  const signature = (url, method, body) => {
    const path = new URL(url, window.location.href).pathname;
    const input = [String(method || "GET").toUpperCase(), path, normalizeBody(body)].join("\n");
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    let userScope = "anonymous";
    try {
      const saved = JSON.parse(sessionStorage.getItem("dadban_user") || "null");
      if (saved && saved.id) userScope = String(saved.id);
      else if (saved && saved.user && saved.user.id) userScope = String(saved.user.id);
    } catch {}
    return storagePrefix + userScope + ":" + (hash >>> 0).toString(16);
  };
  window.dadbanMutationKey = function (url, method, body) {
    const slot = signature(url, method, body);
    let key = sessionStorage.getItem(slot);
    if (!key) {
      const random = window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : "k" + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      key = "dbm-" + random;
      sessionStorage.setItem(slot, key);
    }
    return key;
  };
  window.dadbanMutationSucceeded = function (url, method, body, key) {
    const slot = signature(url, method, body);
    if (key && sessionStorage.getItem(slot) === key) sessionStorage.removeItem(slot);
  };
  window.dadbanWithMutationKey = function (url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) return { options, key: null };
    const body = options.body;
    const key = window.dadbanMutationKey(url, method, body);
    return {
      key,
      options: {
        ...options,
        headers: { ...(options.headers || {}), "Idempotency-Key": key }
      }
    };
  };
})();