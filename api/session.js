const crypto = require("node:crypto");
const {
  clearSessionCookie,
  getSession,
  setSessionCookie,
} = require("./_lib/auth");

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    const session = getSession(req);
    return res.status(200).json({
      authenticated: Boolean(session),
      reviewer: session?.name || "",
    });
  }
  if (req.method === "DELETE") {
    clearSessionCookie(res);
    return res.status(200).json({ authenticated: false });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!process.env.TEAM_PASSCODE || !process.env.SESSION_SECRET) {
    return res.status(503).json({ error: "Team access is not configured yet." });
  }
  const passcode = req.body?.passcode;
  const reviewer = String(req.body?.reviewer || "").trim();
  if (!reviewer) return res.status(400).json({ error: "Add your reviewer name." });
  if (!equalSecret(passcode, process.env.TEAM_PASSCODE)) {
    return res.status(401).json({ error: "The team passcode is incorrect." });
  }
  setSessionCookie(res, reviewer);
  return res.status(200).json({ authenticated: true, reviewer });
};
