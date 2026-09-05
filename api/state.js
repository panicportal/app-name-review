const { requireSession } = require("./_lib/auth");
const { compareAndSwapState } = require("./_lib/store");
const {
  getOrCreateState,
  mergeCuration,
  summarizeChanges,
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
    let baseline = stored;
    for (let attempt = 0; attempt < 4; attempt++) {
      const mergedCuration = mergeCuration(baseline.curation, incoming);
      if (JSON.stringify(mergedCuration) === JSON.stringify(baseline.curation)) return res.status(200).json(baseline);
      const events = summarizeChanges(baseline.curation, mergedCuration, session.name);
      const next = {
        ...baseline,
        revision: Number(baseline.revision || 0) + 1,
        updated_at: new Date().toISOString(),
        updated_by: session.name,
        curation: mergedCuration,
        history: [...(baseline.history || []), ...events].slice(-250),
      };
      if (await compareAndSwapState(baseline.revision, next)) return res.status(200).json(next);
      baseline = await getOrCreateState();
    }
    return res.status(409).json({ error: "Other team edits arrived during this save. Your device will retry safely." });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message || "Could not sync curation." });
  }
};
