const { command } = require("./_lib/store");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const pong = await command(["PING"]);
    return res.status(200).json({
      ok: pong === "PONG",
      storage: pong === "PONG" ? "connected" : "unexpected response",
      version: "12.0.0",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      storage: "disconnected",
      error: error.message,
      version: "12.0.0",
    });
  }
};
