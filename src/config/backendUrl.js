/**
 * BACKEND_URL must be the internal Express server (e.g. http://127.0.0.1:4600).
 * Never use the public API hostname — that loops through nginx back to the gateway.
 */
export function resolveBackendUrl(raw = process.env.BACKEND_URL) {
  let value = String(raw || "http://127.0.0.1:4600").trim().replace(/\/$/, "");

  if (!/^https?:\/\//i.test(value)) {
    const isLocal =
      /^localhost(?::\d+)?$/i.test(value) || /^127\.0\.0\.1(?::\d+)?$/.test(value);
    value = `${isLocal ? "http" : "https"}://${value}`;
  }

  try {
    const host = new URL(value).hostname.toLowerCase();
    const publicApiHosts = (process.env.PUBLIC_API_HOSTS || "api.paridhanemporium.com")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (publicApiHosts.includes(host)) {
      console.error(
        `[gateway] BACKEND_URL must not be the public API host (${host}). Use http://127.0.0.1:4600`,
      );
      return "http://127.0.0.1:4600";
    }
  } catch {
    return "http://127.0.0.1:4600";
  }

  return value;
}

export function validateGatewayEnv(backendUrl) {
  const warnings = [];

  if (!process.env.JWT_ACCESS_SECRET?.trim()) {
    warnings.push("JWT_ACCESS_SECRET is not set — auth guard may be weakened");
  }

  const raw = String(process.env.BACKEND_URL || "").trim();
  if (raw && !/^https?:\/\//i.test(raw) && !/^127\.0\.0\.1|^localhost/i.test(raw)) {
    warnings.push(
      `BACKEND_URL missing protocol (${raw}) — use http://127.0.0.1:4600 internally`,
    );
  }

  for (const msg of warnings) {
    console.warn(`[gateway] WARNING: ${msg}`);
  }

  console.log(`[gateway] Upstream backend: ${backendUrl}`);
}
