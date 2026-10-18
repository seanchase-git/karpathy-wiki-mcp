/**
 * Ask LM Studio which LLMs are loaded. This only says what is loaded, not who is calling,
 * so it is used as a fallback label only when exactly one LLM is loaded.
 * v1 (`/api/v1/models`) is tried first, then the older v0 shape.
 */
export async function loadedModels(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 1000): Promise<string[] | null> {
  const base = baseUrl.replace(/\/+$/, "");
  for (const p of ["/api/v1/models", "/api/v0/models"]) {
    try {
      const res = await fetchImpl(base + p, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const names = parseLoaded(await res.json());
      if (names) return names;
    } catch {
      /* not reachable or wrong shape — try the next endpoint */
    }
  }
  return null;
}

export function parseLoaded(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // v1: { models: [{ type: "llm", key, loaded_instances: [{ id }] }] }
  if (Array.isArray(b.models)) {
    const out: string[] = [];
    for (const m of b.models as Record<string, unknown>[]) {
      if (m?.type !== "llm" && m?.type !== "vlm") continue;
      const inst = Array.isArray(m.loaded_instances) ? (m.loaded_instances as Record<string, unknown>[]) : [];
      if (!inst.length) continue;
      out.push(String(m.key ?? inst[0]?.id ?? m.display_name ?? "unknown"));
    }
    return out;
  }
  // v0: { data: [{ id, type: "llm" | "vlm", state: "loaded" }] }
  if (Array.isArray(b.data)) {
    return (b.data as Record<string, unknown>[])
      .filter((m) => (m?.type === "llm" || m?.type === "vlm") && m?.state === "loaded")
      .map((m) => String(m.id));
  }
  return null;
}
