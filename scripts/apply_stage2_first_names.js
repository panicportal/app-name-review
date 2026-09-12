const fs = require("node:fs");
const path = require("node:path");
const review = require("../review_data.json");
const { getNameBanks } = require("../api/_lib/name-banks");
const { compareAndSwapState, readState } = require("../api/_lib/store");

function effectiveFirst(state, character) {
  return state.curation?.records?.[String(character.id)]?.parts?.first?.replacement_value || character.first;
}

function validatePlan(state, plan, bankState) {
  if (!state?.curation?.records) throw new Error("Live curation state is unavailable.");
  if (plan.workflow_stage !== "first_names_stage_2") throw new Error("Unsupported workflow stage.");
  if (!plan.clothing || !Array.isArray(plan.replacements) || !plan.replacements.length) throw new Error("The plan is incomplete.");
  const byId = new Map(review.characters.map(character => [String(character.id), character]));
  const targetIds = new Set();
  const replacementNames = new Set();
  const sourceBank = plan.bank_file
    ? (bankState?.banks || []).find(bank =>
        bank.filename === plan.bank_file &&
        bank.clothing === plan.clothing &&
        bank.gender === plan.gender)
    : null;
  if (plan.bank_file && !sourceBank) throw new Error(`The exact source bank ${plan.bank_file} is not loaded for ${plan.clothing} · ${plan.gender}.`);
  const bankNames = sourceBank ? new Set((sourceBank.entries || []).map(entry => entry.name)) : null;
  const used = new Map();
  for (const character of review.characters) {
    const value = effectiveFirst(state, character).trim().toLowerCase();
    if (!used.has(value)) used.set(value, []);
    used.get(value).push(String(character.id));
  }
  for (const item of plan.replacements) {
    const id = String(item.id);
    const replacementKey = String(item.replacement || "").trim().toLowerCase();
    if (targetIds.has(id)) throw new Error(`Duplicate target #${id}.`);
    if (replacementNames.has(replacementKey)) throw new Error(`Duplicate proposed first name ${item.replacement}.`);
    targetIds.add(id);
    replacementNames.add(replacementKey);
    const character = byId.get(id);
    if (!character) throw new Error(`Unknown character #${id}.`);
    if (character.clothing !== plan.clothing) throw new Error(`#${id} is ${character.clothing}, not ${plan.clothing}.`);
    const current = effectiveFirst(state, character);
    if (current !== item.expected_first) throw new Error(`#${id} changed from expected ${item.expected_first} to ${current}; refresh the plan.`);
    if (replacementKey === current.trim().toLowerCase()) throw new Error(`#${id} must receive a different first name before its red mark can be cleared.`);
    const first = state.curation.records[id]?.parts?.first;
    if (first?.decision !== "replace") throw new Error(`#${id} is no longer red-marked for first-name replacement.`);
    if (!/^[A-Za-z][A-Za-z'-]{1,23}$/.test(item.replacement)) throw new Error(`Invalid first name ${item.replacement}.`);
    if (bankNames && !bankNames.has(item.replacement)) throw new Error(`${item.replacement} is not an exact row in ${plan.bank_file}.`);
    const conflicts = (used.get(replacementKey) || []).filter(otherId => otherId !== id);
    if (conflicts.length) throw new Error(`${item.replacement} is already used by #${conflicts.join(", #")}.`);
    if (!item.reference || !item.fit) throw new Error(`#${id} needs both a reference and fit explanation.`);
  }
  return { byId };
}

async function main() {
  const planPath = path.resolve(process.argv[2] || "");
  const apply = process.argv.includes("--apply");
  if (!fs.existsSync(planPath)) throw new Error("Pass a Stage 2 plan JSON path.");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const [state, bankState] = await Promise.all([readState(), getNameBanks()]);
  const { byId } = validatePlan(state, plan, bankState);
  console.log(`Validated ${plan.replacements.length} ${plan.clothing} replacements against live revision ${state.revision}.`);
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after reviewing the plan.");
    return;
  }
  const timestamp = new Date().toISOString();
  const backupDir = path.resolve(__dirname, "../backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = timestamp.replace(/[-:.]/g, "");
  const backupPath = path.join(backupDir, `stage2-auto-backup-${plan.clothing.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-r${state.revision}-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(state, null, 2));
  const next = structuredClone(state);
  for (const item of plan.replacements) {
    const id = String(item.id);
    const character = byId.get(id);
    const record = next.curation.records[id];
    const previous = record.parts.first;
    record.parts.first = {
      ...previous,
      decision: null,
      scope: null,
      note: "",
      disabled: false,
      replacement_value: item.replacement,
      replacement_source: `First names Stage 2 · ${plan.clothing} · ${plan.bank_file || "curated reference bank"}`,
      replacement_trait_source: `Clothing:${plan.clothing} + Body:${character.gender_from_body}`,
      replacement_language: "western",
      replacement_origin_kind: "stage2_reference",
      replacement_origin_confirmed_by_user: true,
      replacement_rationale: `Stage 2 replacement inspired by ${item.reference}. ${item.fit}`,
      replacement_scores: { relevance: item.score, collectability: item.score, readability: item.score },
      workflow_stage: plan.workflow_stage,
      workflow_stage_clothing: plan.clothing,
      workflow_reference: item.reference,
      workflow_reference_url: item.reference_url || "",
      workflow_source_file: plan.bank_file || "",
      updated_at: timestamp,
      reviewer: plan.reviewer,
      deleted_at: null
    };
    if (record.normalized_name) {
      record.normalized_name = { ...record.normalized_name, first_name: item.replacement };
      record.normalized_name_updated_at = timestamp;
    }
    record.manual_name_edit_history = [...(record.manual_name_edit_history || []), {
      changed_at: timestamp,
      reviewer: plan.reviewer,
      action: "stage2_first_name_replacement",
      previous_first_name: item.expected_first,
      resulting_first_name: item.replacement,
      reference: item.reference,
      source_file: plan.bank_file || "",
      reference_url: item.reference_url || ""
    }].slice(-20);
    record.updated_at = timestamp;
  }
  next.revision = Number(state.revision || 0) + 1;
  next.updated_at = timestamp;
  next.updated_by = plan.reviewer;
  next.curation.updated_at = timestamp;
  next.history = [...(next.history || []), ...plan.replacements.map(item => ({
    at: timestamp,
    by: plan.reviewer,
    character_id: String(item.id),
    part: "first",
    action: `Stage 2: ${item.expected_first} → ${item.replacement} · ${item.reference}`
  }))].slice(-250);
  const saved = await compareAndSwapState(state.revision, next);
  if (!saved) throw new Error("Live revision changed before commit. Nothing was applied; refresh and retry.");
  console.log(`Applied ${plan.replacements.length} replacements atomically at revision ${next.revision}.`);
  console.log(`Backup: ${backupPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
