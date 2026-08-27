const review = require("../review_data.json");
const { requireSession } = require("./_lib/auth");
const { getOrCreateState } = require("./_lib/state");
const { repairCandidates, shouldOfferRepair } = require("./_lib/surname-repair");

const characters = new Map(review.characters.map((character) => [String(character.id), character]));

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });
  try {
    const state = await getOrCreateState();
    if (String(req.query.all || "") === "1") {
      const repairs = {};
      let unresolved = 0;
      for (const character of review.characters) {
        const record = state.curation?.records?.[String(character.id)];
        if (!shouldOfferRepair(character, record, state)) continue;
        const proposals = repairCandidates(character, record, state);
        if (proposals.length) repairs[String(character.id)] = proposals[0];
        else unresolved++;
      }
      return res.status(200).json({ repairs, detected: Object.keys(repairs).length, unresolved });
    }
    const id = String(req.query.id || "");
    const character = characters.get(id);
    if (!character) return res.status(400).json({ error: "Unknown character." });
    const record = state.curation?.records?.[id] || {};
    const proposals = repairCandidates(character, record, state, String(req.query.surname || ""));
    return res.status(200).json({ character_id: id, proposals, needs_repair: shouldOfferRepair(character, record, state) });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not detect surname components." });
  }
};
