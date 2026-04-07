import { randomUUID } from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import Redis from "ioredis";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
const PORT = Number(process.env.GATEWAY_PORT || 4000);
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:5000";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const REDIS_CACHE_PREFIX = process.env.REDIS_CACHE_PREFIX || "paridhan-gateway";
const REDIS_AUTH_PREFIX = process.env.REDIS_AUTH_PREFIX || "paridhan:auth";
const REDIS_PRODUCT_LIST_TTL = Number(process.env.REDIS_PRODUCT_LIST_TTL || 300);
const REDIS_PRODUCT_SINGLE_TTL = Number(process.env.REDIS_PRODUCT_SINGLE_TTL || 600);
const REDIS_HERO_TTL = Number(process.env.REDIS_HERO_TTL || 300);
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const ACCESS_COOKIE = "pa_access";

const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.warn("Gateway Redis error:", err.message);
});

app.use(
  cors({
    origin: true,
    credentials: true,
    exposedHeaders: ["X-Transaction-Id", "X-Request-Timestamp", "X-Response-Timestamp"],
  }),
);

app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Paridhan API Gateway",
    service: "gateway",
    upstream: BACKEND_URL,
  });
});

const noStore = (res) => {
  res.setHeader("Cache-Control", "no-store");
  return res;
};

const timed = async (fn) => {
  const started = Date.now();
  try {
    const data = await fn();
    return { status: "up", latencyMs: Date.now() - started, ...(data ?? {}) };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

app.get("/health/live", (_req, res) => {
  return noStore(res).status(200).json({
    service: "paridhan-api-gateway",
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
  });
});

app.get("/health/ready", async (_req, res) => {
  const redisCheck = timed(async () => {
    const connected = await ensureRedisConnection();
    if (!connected) throw new Error("Redis unavailable");
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error("Redis ping failed");
  });

  const backendCheck = timed(async () => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 1200);
    try {
      const upstreamRes = await fetch(`${BACKEND_URL}/health/ready`, {
        method: "GET",
        signal: ctrl.signal,
      });
      const json = await upstreamRes.json().catch(() => null);
      if (!upstreamRes.ok) {
        throw new Error(`Backend not ready (${upstreamRes.status})`);
      }
      return json ? { backend: json } : undefined;
    } finally {
      clearTimeout(timeout);
    }
  });

  const [redisStatus, backendStatus] = await Promise.all([redisCheck, backendCheck]);
  const checks = { redis: redisStatus, backend: backendStatus };
  const healthy = redisStatus.status === "up" && backendStatus.status === "up";

  return noStore(res).status(healthy ? 200 : 503).json({
    service: "paridhan-api-gateway",
    status: healthy ? "healthy" : "unhealthy",
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    checks,
  });
});

const attachRequestContext = (req, res, next) => {
  const transactionId = randomUUID();
  const requestTimestamp = new Date().toISOString();

  req.gatewayTransactionId = transactionId;
  req.gatewayRequestTimestamp = requestTimestamp;
  req.gatewayStartedAtMs = Date.now();

  req.headers["x-transaction-id"] = transactionId;
  req.headers["x-request-timestamp"] = requestTimestamp;

  res.setHeader("X-Transaction-Id", transactionId);
  res.setHeader("X-Request-Timestamp", requestTimestamp);
  next();
};

const gatewayApiLogger = (req, res, next) => {
  res.on("finish", () => {
    const responseTimestamp = new Date().toISOString();
    const durationMs = Date.now() - (req.gatewayStartedAtMs || Date.now());
    console.log(
      `[gateway] method=${req.method} path=${req.originalUrl} status=${res.statusCode} tx=${req.gatewayTransactionId || "-"} reqTs=${req.gatewayRequestTimestamp || "-"} resTs=${responseTimestamp} durationMs=${durationMs}`
    );
  });
  next();
};

const isProtectedPath = (path) =>
  path.startsWith("/api/v1/user") ||
  path.startsWith("/api/v1/customer") ||
  path.startsWith("/user") ||
  path.startsWith("/customer") ||
  path === "/api/v1/auth/logout" ||
  path === "/api/v1/auth/logout-all" ||
  path === "/auth/logout" ||
  path === "/auth/logout-all";

const parseCookie = (req, name) => {
  const cookieHeader = req.headers.cookie || "";
  const pairs = cookieHeader.split(";").map((v) => v.trim());
  for (const pair of pairs) {
    if (!pair) continue;
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (key === name) return decodeURIComponent(value);
  }
  return null;
};

const ensureRedisConnection = async () => {
  if (redis.status === "ready" || redis.status === "connecting") return true;
  try {
    await redis.connect();
    return true;
  } catch {
    return false;
  }
};

const buildListCacheKey = (query) =>
  `${REDIS_CACHE_PREFIX}:products:list:${JSON.stringify({
    page: query.page ?? "",
    limit: query.limit ?? "",
    category: query.category ?? "",
    seller: query.seller ?? "",
    featured: query.featured ?? "",
    minPrice: query.minPrice ?? "",
    maxPrice: query.maxPrice ?? "",
    sort: query.sort ?? "",
    q: query.q ?? "",
    inStock: query.inStock ?? "",
  })}`;

const buildSingleCacheKey = (productId) =>
  `${REDIS_CACHE_PREFIX}:products:single:${productId}`;

const authSessionKey = (sid) => `${REDIS_AUTH_PREFIX}:sid:${sid}`;

const getCached = async (key) => {
  const connected = await ensureRedisConnection();
  if (!connected) return null;
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

const setCached = async (key, value, ttlSeconds) => {
  const connected = await ensureRedisConnection();
  if (!connected) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {}
};

const authGuard = async (req, res, next) => {
  if (!isProtectedPath(req.path)) return next();
  const isLogoutPath = req.path === "/auth/logout" || req.path === "/auth/logout-all" || req.path === "/api/v1/auth/logout" || req.path === "/api/v1/auth/logout-all";

  const token = parseCookie(req, ACCESS_COOKIE);
  if (!token) {
    return res.status(401).json({
      success: false,
      code: "TOKEN_MISSING",
      message: "Authentication required",
      data: null,
    });
  }

  try {
    const decoded = jwt.verify(token, ACCESS_SECRET);
    if (decoded.type !== "access" || !decoded.sub || !decoded.sid) {
      return res.status(401).json({
        success: false,
        code: "TOKEN_INVALID",
        message: "Invalid access token",
        data: null,
      });
    }

    const connected = await ensureRedisConnection();
    if (!connected) {
      if (isLogoutPath) {
        req.auth = {
          userId: String(decoded.sub),
          role: String(decoded.activeRole || ""),
          activeRole: String(decoded.activeRole || ""),
          roles: Array.isArray(decoded.roles) ? decoded.roles : [],
          sid: String(decoded.sid),
          jti: decoded.jti ? String(decoded.jti) : "",
        };
        return next();
      }
      return res.status(503).json({
        success: false,
        code: "REDIS_UNAVAILABLE",
        message: "Auth service unavailable",
        data: null,
      });
    }

    const raw = await redis.get(authSessionKey(decoded.sid));
    if (!raw) {
      return res.status(401).json({
        success: false,
        code: "SESSION_MISSING",
        message: "Session expired or revoked",
        data: null,
      });
    }

    const session = JSON.parse(raw);
    if (session.revoked || String(session.userId) !== String(decoded.sub)) {
      return res.status(401).json({
        success: false,
        code: "SESSION_REVOKED",
        message: "Session revoked",
        data: null,
      });
    }

    req.auth = {
      userId: String(decoded.sub),
      role: String(decoded.activeRole || session.activeRole || ""),
      activeRole: String(decoded.activeRole || session.activeRole || ""),
      roles: Array.isArray(decoded.roles) ? decoded.roles : session.roles || [],
      sid: String(decoded.sid),
      jti: decoded.jti ? String(decoded.jti) : "",
    };
    next();
  } catch {
    return res.status(401).json({
      success: false,
      code: "TOKEN_INVALID",
      message: "Invalid or expired token",
      data: null,
    });
  }
};

const forwardToServer = async (req) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const url = `${BACKEND_URL}${req.path}${query}`;
  const serverRes = await fetch(url, {
    method: "GET",
    headers: {
      cookie: req.headers.cookie || "",
      "x-transaction-id": req.headers["x-transaction-id"] || "",
      "x-request-timestamp": req.headers["x-request-timestamp"] || "",
      ...(req.auth
        ? {
            "x-auth-user-id": req.auth.userId,
            "x-auth-role": req.auth.role,
            "x-auth-active-role": req.auth.activeRole,
            "x-auth-roles": Array.isArray(req.auth.roles) ? req.auth.roles.join(",") : "",
            "x-auth-session-id": req.auth.sid,
            "x-auth-jti": req.auth.jti,
          }
        : {}),
    },
  });
  const body = await serverRes.json();
  return { status: serverRes.status, body };
};

app.get("/api/v1/public/hero", attachRequestContext, gatewayApiLogger, authGuard, async (req, res) => {
  const key = buildHeroCacheKey();
  const cached = await getCached(key);
  if (cached) {
    res.setHeader("X-Response-Timestamp", new Date().toISOString());
    return res.status(200).json(cached);
  }

  try {
    const response = await forwardToServer(req);
    if (response.status === 200 && response.body?.success) {
      await setCached(key, response.body, REDIS_HERO_TTL);
    }
    res.setHeader("X-Response-Timestamp", new Date().toISOString());
    return res.status(response.status).json(response.body);
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: "Gateway failed to fetch hero slides",
      data: null,
      error: error.message,
    });
  }
});

app.get("/api/v1/public/products", attachRequestContext, gatewayApiLogger, authGuard, async (req, res) => {
  const key = buildListCacheKey(req.query);
  const cached = await getCached(key);
  if (cached) {
    res.setHeader("X-Response-Timestamp", new Date().toISOString());
    return res.status(200).json(cached);
  }

  try {
    const response = await forwardToServer(req);
    if (response.status === 200 && response.body?.success) {
      await setCached(key, response.body, REDIS_PRODUCT_LIST_TTL);
    }
    res.setHeader("X-Response-Timestamp", new Date().toISOString());
    return res.status(response.status).json(response.body);
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: "Gateway failed to fetch products",
      data: null,
      error: error.message,
    });
  }
});

app.get("/api/v1/public/products/single/:slug", attachRequestContext, gatewayApiLogger, authGuard, async (req, res) => {
  const key = buildSingleCacheKey(req.params.slug);
  const cached = await getCached(key);
  if (cached) {
    res.setHeader("X-Response-Timestamp", new Date().toISOString());
    return res.status(200).json(cached);
  }

  try {
    const response = await forwardToServer(req);
    if (response.status === 200 && response.body?.success) {
      await setCached(key, response.body, REDIS_PRODUCT_SINGLE_TTL);
    }
    res.setHeader("X-Response-Timestamp", new Date().toISOString());
    return res.status(response.status).json(response.body);
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: "Gateway failed to fetch product",
      data: null,
      error: error.message,
    });
  }
});

app.use(
  "/api/v1",
  attachRequestContext,
  gatewayApiLogger,
  authGuard,
  createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    pathRewrite: (path) => `/api/v1${path}`,
    on: {
      proxyReq(proxyReq, req) {
        if (req.auth) {
          proxyReq.setHeader("x-auth-user-id", req.auth.userId);
          proxyReq.setHeader("x-auth-role", req.auth.role);
          proxyReq.setHeader("x-auth-active-role", req.auth.activeRole);
          proxyReq.setHeader("x-auth-roles", Array.isArray(req.auth.roles) ? req.auth.roles.join(",") : "");
          proxyReq.setHeader("x-auth-session-id", req.auth.sid);
          proxyReq.setHeader("x-auth-jti", req.auth.jti);
        }
      },
      proxyRes(_proxyRes, req, res) {
        const id = req.gatewayTransactionId;
        const ts = req.gatewayRequestTimestamp;
        if (id) res.setHeader("X-Transaction-Id", id);
        if (ts) res.setHeader("X-Request-Timestamp", ts);
        res.setHeader("X-Response-Timestamp", new Date().toISOString());
      },
    },
  }),
);

app.listen(PORT, () => {
  console.log(`API Gateway listening on port ${PORT} -> ${BACKEND_URL}`);
});
