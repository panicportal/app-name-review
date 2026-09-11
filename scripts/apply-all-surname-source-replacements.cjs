const crypto = require("node:crypto");
process.loadEnvFile(".env.local");
const review = require("../review_data.json");
const { readState, compareAndSwapState } = require("../api/_lib/store");
const { splitSource, validateStructuredSurname } = require("../api/_lib/name-model");
const { liveSurname, shouldOfferRepair } = require("../api/_lib/surname-repair");

const EXPECTED_REVISION = 4918;
const REVIEWER = "Codex · greenlit surname source migration";
const replacements = [
  ["294", "Softswirl", "Sandcone", "Sand", "Hair:Tan loose wave", "Cone", "Front:Soft serve ice cream"],
  ["349", "Turmericclo", "Velvetspice", "Velvet", "Background:Romantic Purple", "Spice", "Hair:Turmeric fluffy"],
  ["475", "Sunnydash", "Sunstache", "Sun", "Back:Sun", "Stache", "Mouth:Mustache happy"],
  ["546", "Blackrain", "Dollfall", "Doll", "Eyes:Blue doll", "Fall", "Hair:Tar shower"],
  ["1068", "Phantom", "Loafstache", "Loaf", "Front:Baguette", "Stache", "Mouth:Mustache happy"],
  ["1077", "Appetite", "Moonstout", "Moon", "Back:Waning crescent moon", "Stout", "Front:Glass of beer"],
  ["1181", "Frost", "Berryfrost", "Berry", "Front:Berry cake", "Frost", "Hair:Snow natural"],
  ["1268", "Octoragebeam", "Pitchgaze", "Pitch", "Front:Baseball", "Gaze", "Eyes:Hanging sanpaku"],
  ["1374", "Heartmelt", "Lunamelt", "Luna", "Hair:Moon candy", "Melt", "Back:Melt into heart sunrise"],
  ["1499", "Starryflow", "Goggleloaf", "Goggle", "Eyes:Googly", "Loaf", "Front:Baguette"],
  ["1843", "Roughlet", "Roughshell", "Rough", "Hair:Biscotti rough", "Shell", "Front:Taco"],
  ["1859", "Chillpatty", "Bunfury", "Bun", "Front:Hamburger", "Fury", "Eyebrows:Angry"],
  ["1879", "Brandy", "Brandybeam", "Brandy", "Hair:Brandy wild braids", "Beam", "Mouth:Beaming"],
  ["2229", "Octorage", "Octopitch", "Octo", "Hair:Octopus hot frizz", "Pitch", "Front:Baseball"],
  ["2375", "Cravered", "Cravefall", "Crave", "Background:Hungry Red", "Fall", "Hair:Tar shower"],
  ["2448", "Rosemerry", "Rosestache", "Rose", "Background:Lovely Pink", "Stache", "Mouth:Mustache happy"],
  ["2449", "Restkin", "Suncone", "Sun", "Back:Sun", "Cone", "Front:Soft serve ice cream"],
  ["2720", "Basket", "Sandhoop", "Sand", "Hair:Tan loose wave", "Hoop", "Front:Basketball"],
  ["2791", "Lunarcresce", "Gingermoon", "Ginger", "Hair:Ginger dreads bun", "Moon", "Back:Waning crescent moon"],
  ["2833", "Wasteland", "Wastegrin", "Waste", "Back:Overgrown wasteland", "Grin", "Mouth:Smile"],
  ["2856", "Fluffycrest", "Fluffyshell", "Fluffy", "Hair:Turmeric fluffy", "Shell", "Front:Taco"],
  ["2892", "Thornfield", "Tartbeard", "Tart", "Eyes:Sour", "Beard", "Mouth:Long beard surprise"],
  ["2914", "Ballpark", "Pitchfear", "Pitch", "Front:Baseball", "Fear", "Eyebrows:Scared"],
  ["2957", "Flatbrush", "Jetbrush", "Jet", "Hair:Jet loose", "Brush", "Front:White flat brush"],
  ["3145", "Burgerstack", "Gogglebun", "Goggle", "Eyes:Googly", "Bun", "Front:Hamburger"],
  ["3216", "Darkbolt", "Tidecrust", "Tide", "Background:Uncontrollable Ocean Blue", "Crust", "Front:Baguette"],
  ["3279", "Smileykin", "Smileybun", "Smiley", "Mouth:Big smile", "Bun", "Front:Hamburger"],
].map(([id, currentSurname, surnameDisplay, left, leftSource, right, rightSource]) => ({
  id,
  currentSurname,
  surnameDisplay,
  components: [
    { order: 1, text: left, source_raw: leftSource },
    { order: 2, text: right, source_raw: rightSource },
  ],
}));

const characters = new Map(review.characters.map(character => [String(character.id), character]));

function effectiveFirst(character, record) {
  const part = record.parts?.first;
  return String(part?.replacement_value || character.first || "").trim();
}

function effectiveFullName(character, record) {
  return `${effectiveFirst(character, record)} ${liveSurname(character, record)}`.trim().toLowerCase();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const state = await readState();
  if (Number(state.revision) !== EXPECTED_REVISION) {
    throw new Error(`Expected live revision ${EXPECTED_REVISION}, found ${state.revision}. Re-audit before applying.`);
  }
  const flagged = review.characters.filter(character =>
    shouldOfferRepair(character, state.curation.records?.[String(character.id)], state)
  );
  const flaggedIds = new Set(flagged.map(character => String(character.id)));
  const plannedIds = new Set(replacements.map(item => item.id));
  const missing = [...flaggedIds].filter(id => !plannedIds.has(id));
  const extra = [...plannedIds].filter(id => !flaggedIds.has(id));
  if (missing.length || extra.length) throw new Error(`Plan/live mismatch. Missing: ${missing.join(",") || "none"}; extra: ${extra.join(",") || "none"}.`);

  const existingNames = new Map();
  for (const character of review.characters) {
    const id = String(character.id);
    if (plannedIds.has(id)) continue;
    existingNames.set(effectiveFullName(character, state.curation.records?.[id] || {}), id);
  }
  const proposedNames = new Set();
  const validated = [];
  for (const item of replacements) {
    const character = characters.get(item.id);
    const record = state.curation.records[item.id];
    const currentSurname = liveSurname(character, record);
    if (currentSurname.toLowerCase() !== item.currentSurname.toLowerCase()) {
      throw new Error(`#${item.id} changed since audit: expected ${item.currentSurname}, found ${currentSurname}.`);
    }
    const validation = validateStructuredSurname({
      character,
      components: item.components,
      order: "12",
      join_style: "lower_second",
      surname_display: item.surnameDisplay,
    });
    if (!validation.valid) throw new Error(`#${item.id} invalid: ${validation.errors.join(" ")}`);
    const fullName = `${effectiveFirst(character, record)} ${validation.surname_display}`.trim();
    const key = fullName.toLowerCase();
    if (existingNames.has(key)) throw new Error(`#${item.id} duplicates #${existingNames.get(key)}: ${fullName}.`);
    if (proposedNames.has(key)) throw new Error(`Plan contains duplicate full name: ${fullName}.`);
    proposedNames.add(key);
    validated.push({ item, character, record, validation, fullName });
  }

  console.log(JSON.stringify({
    dry_run: !apply,
    revision: state.revision,
    replacements: validated.map(({ item, fullName }) => ({ id: item.id, from: item.currentSurname, to: fullName, components: item.components })),
  }, null, 2));
  if (!apply) return;

  const next = structuredClone(state);
  const timestamp = new Date().toISOString();
  for (const { item, character, validation } of validated) {
    const record = next.curation.records[item.id];
    const oldFirst = structuredClone(record.parts?.first || null);
    const previousSurnameDecision = record.parts?.surname_part_1?.decision || null;
    const previousSurnameScope = record.parts?.surname_part_1?.scope || null;
    validation.components.forEach((component, index) => {
      const key = index === 0 ? "surname_part_1" : "surname_part_2";
      const current = record.parts?.[key] || {};
      record.parts[key] = {
        ...current,
        decision: current.decision || previousSurnameDecision,
        scope: current.scope || previousSurnameScope,
        disabled: false,
        replacement_value: component.text,
        replacement_source: "Greenlit style-guided structured surname migration",
        replacement_trait_source: component.source_raw,
        replacement_language: "western",
        replacement_rationale: `Replaced unsupported surname “${item.currentSurname}” with ${validation.surname_display}, using two distinct exact character routes and component wording established by current greenlit names.`,
        replacement_scores: null,
        updated_at: timestamp,
        reviewer: REVIEWER,
        deleted_at: null,
      };
    });
    record.surname_order = "12";
    record.surname_order_updated_at = timestamp;
    record.surname_join_style = "lower_second";
    record.surname_join_style_updated_at = timestamp;
    record.surname_format_version = 3;
    record.normalized_name = {
      first_name: effectiveFirst(character, record),
      surname_display: validation.surname_display,
      surname_components: validation.components.map(component => ({ ...component, ...splitSource(component.source_raw), confidence: "confirmed" })),
      surname_join_style: "lower_second",
      surname_format_version: 3,
      derivation_method: "greenlit_style_guided_two_trait_replacement",
      needs_surname_component_repair: false,
      recovery_evidence: "Two distinct exact character traits; roots verified against current greenlit structured surnames",
      recovery_confidence_score: 100,
    };
    record.normalized_name_updated_at = timestamp;
    record.naming_assistant_history = [
      ...(record.naming_assistant_history || []),
      { at: timestamp, by: REVIEWER, action: "Replaced unsupported surname with a validated two-trait compound", full_name: `${record.normalized_name.first_name} ${validation.surname_display}`, source: "Current greenlit surname component patterns" },
    ].slice(-20);
    record.updated_at = timestamp;
    if (JSON.stringify(record.parts?.first || null) !== JSON.stringify(oldFirst)) throw new Error(`#${item.id} first-name record changed during migration.`);
  }
  next.revision = Number(state.revision) + 1;
  next.updated_at = timestamp;
  next.updated_by = REVIEWER;
  next.curation.updated_at = timestamp;
  next.history = [
    ...(state.history || []),
    ...validated.map(({ item, fullName }) => ({ at: timestamp, by: REVIEWER, character_id: item.id, part: "surname_structure", action: `Replaced unsupported surname with ${fullName.split(" ").slice(1).join(" ")}` })),
  ].slice(-250);
  const committed = await compareAndSwapState(EXPECTED_REVISION, next);
  if (!committed) throw new Error("Live revision changed during validation. No replacements were applied.");
  console.log(JSON.stringify({ applied: validated.length, previous_revision: EXPECTED_REVISION, resulting_revision: next.revision, plan_sha256: crypto.createHash("sha256").update(JSON.stringify(replacements)).digest("hex") }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
