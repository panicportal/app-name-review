const seed = require("../../cloud_seed_curation.json");
const { readState, writeState } = require("./store");

const SCHEMA_VERSION = "panic-name-curation/v2";

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function seedCuration() {
  const records = {};
  for (const item of seed.records || []) {
    const parts = {};
    for (const [key, part] of Object.entries(item.parts || {})) {
      if (!part?.decision) continue;
      parts[key] = {
        decision: part.decision,
        scope: part.scope || null,
        note: part.note || "",
        replacement_value:
          part.selected_replacement || part.replacement_value || null,
        replacement_source: part.replacement_source || "",
        replacement_trait_source:
          part.replacement_trait_source || part.replacement_source || "",
        replacement_language: part.replacement_language || "",
        replacement_rationale: part.replacement_rationale || "",
        replacement_scores: part.replacement_scores || null,
        disabled: Boolean(part.disabled),
        reviewer: part.reviewer || seed.reviewer || "",
        updated_at: part.updated_at || seed.exported_at || new Date().toISOString(),
      };
    }
    records[String(item.id)] = {
      note: item.character_note || "",
      note_updated_at: item.updated_at || seed.exported_at || null,
      surname_order: item.surname_order === "21" ? "21" : "12",
      surname_order_updated_at: item.surname_order_updated_at || null,
      surname_join_style:
        item.surname_join_style === "lower_second" ? "lower_second" : "camel",
      surname_format_version: Number(item.surname_format_version || 0),
      surname_join_style_updated_at: item.surname_join_style_updated_at || null,
      updated_at: item.updated_at || seed.exported_at || null,
      parts,
    };
  }
  return {
    schema_version: SCHEMA_VERSION,
    reviewer: seed.reviewer || "",
    records,
    updated_at: seed.exported_at || new Date().toISOString(),
  };
}

function initialState() {
  return {
    schema_version: "panic-name-cloud/v1",
    revision: 1,
    updated_at: new Date().toISOString(),
    updated_by: "August 2 curation import",
    curation: seedCuration(),
    assignments: {},
    history: [
      {
        at: new Date().toISOString(),
        by: "System",
        action: "Imported the August 2 curation export",
      },
    ],
  };
}

function newer(left, right) {
  return timestamp(left?.updated_at || left?.deleted_at) >=
    timestamp(right?.updated_at || right?.deleted_at)
    ? left
    : right;
}

function mergeRecord(stored = {}, incoming = {}) {
  if (
    incoming.deleted_at &&
    timestamp(incoming.deleted_at) >= timestamp(stored.updated_at)
  ) {
    return { deleted_at: incoming.deleted_at, updated_at: incoming.deleted_at, parts: {} };
  }
  if (
    stored.deleted_at &&
    timestamp(stored.deleted_at) > timestamp(incoming.updated_at)
  ) {
    return stored;
  }
  const merged = {
    note:
      timestamp(incoming.note_updated_at) >= timestamp(stored.note_updated_at)
        ? incoming.note || ""
        : stored.note || "",
    note_updated_at:
      timestamp(incoming.note_updated_at) >= timestamp(stored.note_updated_at)
        ? incoming.note_updated_at || incoming.updated_at || null
        : stored.note_updated_at || stored.updated_at || null,
    surname_order:
      timestamp(incoming.surname_order_updated_at) >=
      timestamp(stored.surname_order_updated_at)
        ? incoming.surname_order === "21" ? "21" : "12"
        : stored.surname_order === "21" ? "21" : "12",
    surname_order_updated_at:
      timestamp(incoming.surname_order_updated_at) >=
      timestamp(stored.surname_order_updated_at)
        ? incoming.surname_order_updated_at || null
        : stored.surname_order_updated_at || null,
    surname_join_style:
      timestamp(incoming.surname_join_style_updated_at) >=
      timestamp(stored.surname_join_style_updated_at)
        ? incoming.surname_join_style === "lower_second" ? "lower_second" : "camel"
        : stored.surname_join_style === "lower_second" ? "lower_second" : "camel",
    surname_join_style_updated_at:
      timestamp(incoming.surname_join_style_updated_at) >=
      timestamp(stored.surname_join_style_updated_at)
        ? incoming.surname_join_style_updated_at || null
        : stored.surname_join_style_updated_at || null,
    surname_format_version:
      timestamp(incoming.surname_join_style_updated_at) >=
      timestamp(stored.surname_join_style_updated_at)
        ? Number(incoming.surname_format_version || 0)
        : Number(stored.surname_format_version || 0),
    parts: { ...(stored.parts || {}) },
  };
  for (const [key, part] of Object.entries(incoming.parts || {})) {
    merged.parts[key] = newer(part, merged.parts[key] || {});
  }
  merged.updated_at = [
    stored.updated_at,
    incoming.updated_at,
    merged.note_updated_at,
    merged.surname_order_updated_at,
    merged.surname_join_style_updated_at,
    ...Object.values(merged.parts).map((part) => part.updated_at || part.deleted_at),
  ]
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return merged;
}

function summarizeChanges(before, after, actor) {
  const events = [];
  const ids = new Set([
    ...Object.keys(before?.records || {}),
    ...Object.keys(after?.records || {}),
  ]);
  for (const id of ids) {
    const oldRecord = before?.records?.[id] || {};
    const newRecord = after?.records?.[id] || {};
    if (
      oldRecord.surname_order !== newRecord.surname_order &&
      newRecord.surname_order_updated_at
    ) {
      events.push({
        at: newRecord.surname_order_updated_at,
        by: actor,
        character_id: id,
        part: "surname_order",
        action: newRecord.surname_order === "21"
          ? "Flipped surname to trait 2 → trait 1"
          : "Restored surname to trait 1 → trait 2",
      });
    }
    for (const key of ["first", "surname_part_1", "surname_part_2"]) {
      const oldPart = oldRecord.parts?.[key] || {};
      const newPart = newRecord.parts?.[key] || {};
      if (
        oldPart.updated_at !== newPart.updated_at ||
        oldPart.deleted_at !== newPart.deleted_at
      ) {
        const chosen = newPart.replacement_value
          ? ` → ${newPart.replacement_value}`
          : "";
        events.push({
          at: newPart.updated_at || newPart.deleted_at || new Date().toISOString(),
          by: newPart.reviewer || actor,
          character_id: id,
          part: key,
          action: newPart.deleted_at
            ? "Cleared decision"
            : `${newPart.decision || "Updated"}${chosen}`,
        });
      }
    }
  }
  return events.slice(-60);
}

function mergeCuration(stored, incoming) {
  if (!incoming || incoming.schema_version !== SCHEMA_VERSION) return stored;
  const merged = {
    schema_version: SCHEMA_VERSION,
    reviewer: incoming.reviewer || stored?.reviewer || "",
    records: { ...(stored?.records || {}) },
    updated_at: [stored?.updated_at, incoming.updated_at].filter(Boolean).sort().at(-1),
  };
  for (const [id, record] of Object.entries(incoming.records || {})) {
    merged.records[id] = mergeRecord(merged.records[id], record);
  }
  return merged;
}

async function getOrCreateState() {
  let state = await readState();
  if (!state) {
    state = initialState();
    await writeState(state);
  }
  return state;
}

module.exports = {
  getOrCreateState,
  initialState,
  mergeCuration,
  summarizeChanges,
  writeState,
};
