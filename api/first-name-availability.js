const review = require("../review_data.json");
const { requireSession } = require("./_lib/auth");
const { getOrCreateState } = require("./_lib/state");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });
  const value = String(req.query.value || "").trim().toLowerCase();
  const except = String(req.query.except_id || "");
  const state = await getOrCreateState();
  const matches = [];
  for (const character of review.characters) {
    if (String(character.id) === except) continue;
    const saved = state.curation?.records?.[String(character.id)]?.parts?.first;
    const live = saved?.replacement_value || character.first;
    if (String(live || "").toLowerCase() === value) matches.push(String(character.id));
  }
  return res.status(200).json({ value, available: matches.length === 0, conflicts: matches });
};
