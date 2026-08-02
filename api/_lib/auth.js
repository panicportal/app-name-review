const crypto = require("node:crypto");

const COOKIE_NAME = "panic_name_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function createToken(name) {
  const payload = base64url(
    JSON.stringify({
      name: String(name || "Team reviewer").slice(0, 80),
      exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
    })
  );
  return `${payload}.${sign(payload)}`;
}

function readCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function getSession(req) {
  const token = readCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return null;
  }
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

function setSessionCookie(res, name) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(createToken(name))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "Sign in with the team passcode." });
    return null;
  }
  return session;
}

module.exports = {
  clearSessionCookie,
  getSession,
  requireSession,
  setSessionCookie,
};
