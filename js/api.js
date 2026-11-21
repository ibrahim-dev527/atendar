// Thin RPC wrapper. Always resolves to {ok, code, message, ...}; never throws, and
// never shows raw technical errors to users.
export const NETWORK_MSG = "We couldn't reach the server. Check your internet connection and try again.";

export async function call(client, fn, args = {}) {
  try {
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      console.error("[rpc]", fn, error);
      const m = String(error.message || "");
      if (/fetch|network|Load failed/i.test(m)) return { ok: false, code: "NETWORK", message: NETWORK_MSG };
      if (error.code === "42501" || /permission denied/i.test(m)) return { ok: false, code: "FORBIDDEN", message: "You do not have permission to do this." };
      return { ok: false, code: "SERVER_ERROR", message: "Something went wrong on our side. Please try again in a moment." };
    }
    if (data && typeof data === "object") return data;
    return { ok: false, code: "SERVER_ERROR", message: "Unexpected response from the server. Please try again." };
  } catch (e) {
    console.error("[rpc]", fn, e);
    return { ok: false, code: "NETWORK", message: NETWORK_MSG };
  }
}

/** Run a PostgREST query builder; returns {data, error:string|null}. */
export async function q(builder) {
  try {
    const { data, error } = await builder;
    if (error) {
      console.error("[query]", error);
      const m = String(error.message || "");
      let msg = "Something went wrong. Please try again.";
      if (/fetch|network/i.test(m)) msg = NETWORK_MSG;
      else if (error.code === "42501" || /permission denied|row-level security/i.test(m)) msg = "You do not have permission to do this.";
      else if (error.code === "23505") msg = "That already exists.";
      else if (error.code === "23503") msg = "This item is in use elsewhere, so it can't be removed. Archive it instead.";
      return { data: null, error: msg };
    }
    return { data, error: null };
  } catch (e) { console.error("[query]", e); return { data: null, error: NETWORK_MSG }; }
}
