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

function effectiveFirstName(character, record) {
  const part = record?.parts?.first;
  if (part?.disabled) return "";
  return String(part?.replacement_value || character.first || "").trim();
}

function applyConfirmedRepair(nextState, character, proposal, reviewer, timestamp) {
  const id = String(character.id);
  const record = nextState.curation.records[id];
  const currentSurname = liveSurname(character, record);
  const validation = validateStructuredSurname({
    character,
    components: proposal.surname_components,
    order: "12",
    join_style: proposal.join_style || "lower_second",
    surname_display: proposal.surname_display,
  });
  if (!validation.valid) return { applied: false, reason: validation.errors.join(" ") };
  if (currentSurname.toLowerCase() !== validation.surname_display.toLowerCase()) {
    return { applied: false, reason: "visible_surname_would_change" };
  }
  const approvedCompound = ["surname_part_1", "surname_part_2"].some(
    (key) => record.parts?.[key]?.decision === "approve"
  );
  validation.components.forEach((component, index) => {
    const key = index === 0 ? "surname_part_1" : "surname_part_2";
    const current = record.parts?.[key] || {};
    record.parts[key] = {
      ...current,
      decision: approvedCompound ? "approve" : (current.decision || "replace"),
      scope: approvedCompound ? null : (current.scope || "this_character"),
      disabled: false,
      replacement_value: component.text,
      replacement_source: "Automatic structured surname repair",
      replacement_trait_source: component.source_raw,
      replacement_language: "western",
      replacement_rationale: `Recovered exact semantic component ${index + 1} from ${component.source_raw}. Collector-visible surname preserved as ${validation.surname_display}. Evidence: ${proposal.evidence}.`,
      replacement_scores: null,
      updated_at: timestamp,
      reviewer,
      deleted_at: null,
    };
  });
  record.surname_order = "12";
  record.surname_order_updated_at = timestamp;
  record.surname_join_style = proposal.join_style || "lower_second";
  record.surname_join_style_updated_at = timestamp;
  record.surname_format_version = 3;
  record.normalized_name = {
    first_name: effectiveFirstName(character, record),
    surname_display: validation.surname_display,
    surname_components: validation.components.map((component) => ({
      ...component,
      ...splitSource(component.source_raw),
      confidence: "confirmed",
    })),
    surname_join_style: proposal.join_style || "lower_second",
    surname_format_version: 3,
    derivation_method: "automatic_exact_component_recovery",
    needs_surname_component_repair: false,
    recovery_evidence: proposal.evidence,
    recovery_confidence_score: proposal.confidence_score,
  };
  record.normalized_name_updated_at = timestamp;
  record.naming_assistant_history = [
    ...(record.naming_assistant_history || []),
    {
      at: timestamp,
      by: reviewer,
      action: "Automatically recovered two exact surname components",
      full_name: `${record.normalized_name.first_name} ${validation.surname_display}`.trim(),
      source: proposal.evidence,
    },
  ].slice(-20);
  record.updated_at = timestamp;
  return { applied: true, surname: validation.surname_display };
}

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
      let unresolved = 0;
      let confirmed = 0;
      for (const character of review.characters) {
        const record = state.curation?.records?.[String(character.id)];
        if (!shouldOfferRepair(character, record, state)) continue;
        const proposals = repairCandidates(character, record, state);
        const safety = safeAutomaticRepair(proposals);
        if (proposals.length) repairs[String(character.id)] = proposals[0];
        if (safety.safe) confirmed++;
        else unresolved++;
      }
      return res.status(200).json({ repairs, detected: Object.keys(repairs).length, confirmed, unresolved });
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
