const { requireSession } = require("./_lib/auth");
const {
  getOrCreateState,
  mergeCuration,
  summarizeChanges,
  writeState,
} = require("./_lib/state");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const stored = await getOrCreateState();
    if (req.method === "GET") {
      return res.status(200).json(stored);
    }
    if (req.method !== "PUT") {
      res.setHeader("Allow", "GET, PUT");
      return res.status(405).json({ error: "Method not allowed." });
    }
    const incoming = req.body?.curation;
    const mergedCuration = mergeCuration(stored.curation, incoming);
    const events = summarizeChanges(stored.curation, mergedCuration, session.name);
    const next = {
      ...stored,
      revision: Number(stored.revision || 0) + 1,
      updated_at: new Date().toISOString(),
      updated_by: session.name,
      curation: mergedCuration,
      history: [...(stored.history || []), ...events].slice(-250),
    };
    await writeState(next);
    return res.status(200).json(next);
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message || "Could not sync curation." });
  }
};
