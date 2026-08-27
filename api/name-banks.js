const { requireSession } = require("./_lib/auth");
const { getNameBanks, saveNameBank } = require("./_lib/name-banks");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  try {
    if (req.method === "GET") return res.status(200).json(await getNameBanks());
    if (req.method === "POST") return res.status(201).json(await saveNameBank(req.body || {}, session.name));
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || "Could not save name bank." });
  }
};
