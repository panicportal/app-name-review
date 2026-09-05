const { splitSource, validateStructuredSurname } = require("./name-model");
const { liveSurname } = require("./surname-repair");
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
  if (currentSurname !== validation.surname_display) {
    return { applied: false, reason: "visible_surname_would_change" };
  }
  validation.components.forEach((component, index) => {
    const key = index === 0 ? "surname_part_1" : "surname_part_2";
    const current = record.parts?.[key] || {};
    record.parts[key] = {
      ...current,
      decision: current.decision || null,
      scope: current.scope || null,
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

module.exports = { applyConfirmedRepair };
