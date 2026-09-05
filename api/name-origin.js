const { requireSession } = require("./_lib/auth");
const { getOrCreateState } = require("./_lib/state");
const { compareAndSwapState } = require("./_lib/store");
const {
  auditOriginMismatches,
  characters,
  detectFirstOrigin,
  detectSurnameOrigin,
} = require("./_lib/name-origin");

function correctedSource(correction, character) {
  if (correction.detected_origin === "japanese") {
    return {
      replacement_source: "Japanese names surnames.csv · exact authoritative bank match",
      replacement_rationale: correction.part === "first"
        ? `Exact artist Japanese first-name entry for ${correction.exact_source_route} and Body:${character.gender_from_body}. Bank origin corrected without changing the selected name or curation status.`
        : `Exact artist Japanese surname entry for ${correction.exact_source_route}. Bank origin corrected without changing the selected surname or curation status.`,
    };
  }
  return {
    replacement_source: "Curated Western bank · exact route match",
    replacement_rationale: `Exact curated Western-bank entry for ${correction.exact_source_route}. Bank origin corrected without changing the selected value or curation status.`,
  };
}

function stateDecisionSignature(state) {
  const signature = {};
  for (const [id, record] of Object.entries(state.curation?.records || {})) {
    signature[id] = {};
    for (const key of ["first", "surname_part_1", "surname_part_2"]) {
      const part = record.parts?.[key] || {};
      signature[id][key] = {
        decision: part.decision || null,
        scope: part.scope || null,
        value: part.replacement_value || null,
        disabled: Boolean(part.disabled),
      };
    }
  }
  return JSON.stringify(signature);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  try {
    const state = await getOrCreateState();
    if (req.method === "GET" && String(req.query.all || "") !== "1") {
      const id = String(req.query.id || "");
      const part = String(req.query.part || "");
      const character = characters.get(id);
      if (!character || !["first", "surname", "surname_atomic", "surname_part_1", "surname_part_2"].includes(part)) {
        return res.status(400).json({ error: "Unknown character or name component." });
      }
      const value = String(req.query.value || "").trim();
      const result = part === "first"
        ? detectFirstOrigin(character, value)
        : detectSurnameOrigin(character, value, String(req.query.source || ""));
      return res.status(200).json({ character_id: id, part, ...result });
    }
    const audit = auditOriginMismatches(state);
    if (req.method === "GET" || req.body?.mode !== "apply_confirmed") {
      return res.status(200).json({
        dry_run: true,
        revision: Number(state.revision || 0),
        confirmed: audit.corrections.length,
        protected_artist_custom: audit.confirmedCustom.length,
        ambiguous: audit.ambiguous.length,
        unknown: audit.unknown.length,
        corrections: audit.corrections,
        ambiguous_records: audit.ambiguous,
      });
    }
    const expectedRevision = Number(req.body?.expected_revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(state.revision || 0)) {
      return res.status(409).json({
        error: "Live revision changed. No bank-origin corrections were applied.",
        expected_revision: expectedRevision || null,
        live_revision: Number(state.revision || 0),
      });
    }
    const beforeSignature = stateDecisionSignature(state);
    const next = JSON.parse(JSON.stringify(state));
    const timestamp = new Date().toISOString();
    for (const correction of audit.corrections) {
      const character = characters.get(correction.character_id);
      const record = next.curation.records[correction.character_id];
      const part = record.parts[correction.part];
      const source = correctedSource(correction, character);
      record.parts[correction.part] = {
        ...part,
        ...source,
        replacement_language: correction.detected_origin,
        replacement_trait_source: correction.exact_source_route,
        origin_recovery: {
          previous_origin: correction.current_origin,
          recovered_origin: correction.detected_origin,
          evidence: correction.evidence,
          recovered_at: timestamp,
          recovered_by: session.name,
        },
        updated_at: timestamp,
        reviewer: part.reviewer || session.name,
      };
      record.updated_at = timestamp;
    }
    if (stateDecisionSignature(next) !== beforeSignature) {
      return res.status(409).json({ error: "A name, status, scope, or surname structure would change. Nothing was applied." });
    }
    next.revision = Number(state.revision || 0) + 1;
    next.updated_at = timestamp;
    next.updated_by = `${session.name} · exact name-bank origin recovery`;
    next.curation.updated_at = timestamp;
    next.history = [
      ...(state.history || []),
      ...audit.corrections.map((correction) => ({
        at: timestamp,
        by: session.name,
        character_id: correction.character_id,
        part: correction.part,
        action: `Corrected source-bank origin ${correction.current_origin} → ${correction.detected_origin} without changing the name or status`,
      })),
    ].slice(-250);
    const committed = await compareAndSwapState(expectedRevision, next);
    if (!committed) {
      return res.status(409).json({ error: "Live revision changed during validation. Nothing was applied." });
    }
    return res.status(200).json({
      dry_run: false,
      previous_revision: expectedRevision,
      resulting_revision: next.revision,
      applied: audit.corrections.length,
      corrections: audit.corrections,
      preserved: {
        names: true,
        decisions: true,
        scopes: true,
        surname_structure: true,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not detect name-bank origin." });
  }
};
