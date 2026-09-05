const review = require("../review_data.json");
const { requireSession } = require("./_lib/auth");
const { getOrCreateState } = require("./_lib/state");
const { compareAndSwapState } = require("./_lib/store");
const { splitSource, validateStructuredSurname } = require("./_lib/name-model");
const {
  liveSurname,
  repairCandidates,
  safeAutomaticRepair,
  shouldOfferRepair,
} = require("./_lib/surname-repair");

const characters = new Map(review.characters.map((character) => [String(character.id), character]));

const { applyConfirmedRepair } = require("./_lib/repair-application");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed." });
  try {
    const state = await getOrCreateState();
    if (req.method === "POST") {
      const expectedRevision = Number(req.body?.expected_revision);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(state.revision || 0)) {
        return res.status(409).json({
          error: "Live revision changed. No repairs were applied.",
          expected_revision: expectedRevision || null,
          live_revision: Number(state.revision || 0),
        });
      }
      const plan = [];
      const skipped = [];
      for (const character of review.characters) {
        const record = state.curation?.records?.[String(character.id)];
        if (!shouldOfferRepair(character, record, state)) continue;
        const safety = safeAutomaticRepair(repairCandidates(character, record, state));
        if (!safety.safe) {
          skipped.push({ character_id: String(character.id), reason: safety.reason });
          continue;
        }
        plan.push({ character, proposal: safety.proposal });
      }
      if (req.body?.mode !== "apply_confirmed") {
        return res.status(200).json({
          dry_run: true,
          revision: Number(state.revision || 0),
          confirmed: plan.length,
          skipped,
          characters: plan.map(({ character, proposal }) => ({
            character_id: String(character.id),
            current_surname: liveSurname(character, state.curation.records[String(character.id)]),
            surname_display: proposal.surname_display,
            surname_components: proposal.surname_components,
            evidence: proposal.evidence,
            confidence_score: proposal.confidence_score,
          })),
        });
      }
      if (!plan.length) return res.status(200).json({ dry_run: false, previous_revision: expectedRevision, resulting_revision: expectedRevision, applied: 0, skipped });
      const next = JSON.parse(JSON.stringify(state));
      const timestamp = new Date().toISOString();
      const applied = [];
      for (const item of plan) {
        const result = applyConfirmedRepair(next, item.character, item.proposal, session.name, timestamp);
        if (!result.applied) {
          return res.status(409).json({
            error: `Repair validation changed for #${item.character.id}. No repairs were applied.`,
            character_id: String(item.character.id),
            reason: result.reason,
          });
        }
        applied.push(String(item.character.id));
      }
      next.revision = Number(state.revision || 0) + 1;
      next.updated_at = timestamp;
      next.updated_by = `${session.name} · automatic surname component recovery`;
      next.curation.updated_at = timestamp;
      next.history = [
        ...(state.history || []),
        ...applied.map((id) => ({
          at: timestamp,
          by: session.name,
          character_id: id,
          part: "surname_structure",
          action: "Recovered two exact surname components without changing the visible name",
        })),
      ].slice(-250);
      const committed = await compareAndSwapState(expectedRevision, next);
      if (!committed) {
        return res.status(409).json({ error: "Live revision changed during validation. No repairs were applied." });
      }
      return res.status(200).json({
        dry_run: false,
        previous_revision: expectedRevision,
        resulting_revision: next.revision,
        applied: applied.length,
        applied_character_ids: applied,
        skipped,
      });
    }
    if (String(req.query.all || "") === "1") {
      const repairs = {};
      const issues = [];
      const clothing = Object.fromEntries([...new Set(review.characters.map(c => c.clothing).filter(Boolean))].sort().map(name => [name, { total: review.characters.filter(c => c.clothing === name).length, needs_review: 0, automatic: 0 }]));
      let unresolved = 0;
      let confirmed = 0;
      for (const character of review.characters) {
        const record = state.curation?.records?.[String(character.id)];
        if (!shouldOfferRepair(character, record, state)) continue;
        const proposals = repairCandidates(character, record, state);
        const safety = safeAutomaticRepair(proposals);
        // Only exact, unchanged, unambiguous proposals may be prefilled.
        if (safety.safe) repairs[String(character.id)] = safety.proposal;
        issues.push({ character_id: String(character.id), clothing: character.clothing, surname: liveSurname(character, record), reason: safety.reason, automatic: safety.safe, stored_source: record?.parts?.surname_part_1?.replacement_trait_source || "" });
        if (clothing[character.clothing]) { clothing[character.clothing].needs_review++; if(safety.safe) clothing[character.clothing].automatic++; }
        if (safety.safe) confirmed++;
        else unresolved++;
      }
      return res.status(200).json({ revision: state.revision, repairs, issues, clothing, detected: issues.length, confirmed, unresolved });
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
