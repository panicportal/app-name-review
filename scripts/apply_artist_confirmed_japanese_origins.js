const fs = require("node:fs");
const path = require("node:path");
const { getOrCreateState } = require("../api/_lib/state");
const { compareAndSwapState } = require("../api/_lib/store");
const review = require("../review_data.json");

const CONFIRMED_FIRST_NAMES = [
  ["6", "Daichi"], ["101", "Tsubaki"], ["104", "Ippei"],
  ["107", "Satoko"], ["164", "Masanobu"], ["182", "Yui"],
  ["191", "Shinnosuke"], ["198", "Daiya"], ["218", "Tenshi"],
  ["232", "Pochi"], ["314", "Aiko"], ["362", "Akina"],
  ["448", "Katsumi"], ["453", "Reika"], ["550", "Hiroshi"],
  ["612", "Junko"], ["752", "Kentaro"], ["971", "Keisuke"],
  ["1207", "Kokoro"], ["1548", "Wakako"], ["2131", "Emi"],
  ["2306", "Motoko"], ["2329", "Hajime"], ["2430", "Shiori"],
  ["2457", "Manase"], ["2493", "Kirara"], ["2514", "Tomomi"],
  ["2559", "Keiji"], ["2616", "Isao"], ["2721", "Osaru"],
  ["2841", "Miho"], ["2874", "Kohei"], ["3280", "Takaaki"],
];

function loadEnvironment() {
  const envPath = path.join(__dirname, "..", ".env.local");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1].trim()] = value;
  }
}

function decisionSignature(state) {
  const signature = {};
  for (const [id, record] of Object.entries(state.curation?.records || {})) {
    signature[id] = {};
    for (const key of ["first", "surname_part_1", "surname_part_2"]) {
      const part = record.parts?.[key] || {};
      signature[id][key] = {
        decision: part.decision || null,
        scope: part.scope || null,
        replacement_value: part.replacement_value || null,
        disabled: Boolean(part.disabled),
        deleted_at: part.deleted_at || null,
      };
    }
  }
  return JSON.stringify(signature);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  loadEnvironment();
  const state = await getOrCreateState();
  const expectedRevision = Number(process.argv[2] || 0);
  const apply = process.argv.includes("--apply");
  if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(state.revision || 0)) {
    throw new Error(`Revision drift: expected ${expectedRevision || "a revision argument"}, live is ${state.revision}. Nothing changed.`);
  }
  const characters = new Map(review.characters.map((character) => [String(character.id), character]));
  const rows = [];
  for (const [id, expectedValue] of CONFIRMED_FIRST_NAMES) {
    const character = characters.get(id);
    const part = state.curation?.records?.[id]?.parts?.first;
    if (!character || !part || part.disabled || part.deleted_at) {
      throw new Error(`#${id} has no active first-name replacement. Nothing changed.`);
    }
    if (part.replacement_value !== expectedValue) {
      throw new Error(`#${id} drifted: expected ${expectedValue}, found ${part.replacement_value}. Nothing changed.`);
    }
    if (part.replacement_language !== "western") {
      throw new Error(`#${id} ${expectedValue} is no longer Western (${part.replacement_language || "blank"}). Nothing changed.`);
    }
    rows.push({
      character_id: id,
      clothing: character.clothing,
      body_gender: character.gender_from_body,
      name_component: "first",
      value: expectedValue,
      previous_origin: part.replacement_language,
      resulting_origin: "japanese",
      decision: part.decision || "",
      evidence: "Explicit confirmation from the artist screenshots and message supplied by the collection owner on 2026-09-05.",
    });
  }

  const outputDir = path.join(__dirname, "..", "audits", "japanese-origin-fix-2026-09-05");
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(outputDir, `live-revision-${state.revision}-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  if (!apply) {
    console.log(JSON.stringify({ dry_run: true, revision: state.revision, confirmed: rows.length, backup: backupPath, rows }, null, 2));
    return;
  }

  const beforeSignature = decisionSignature(state);
  const next = JSON.parse(JSON.stringify(state));
  const timestamp = new Date().toISOString();
  for (const row of rows) {
    const record = next.curation.records[row.character_id];
    const part = record.parts.first;
    record.parts.first = {
      ...part,
      replacement_language: "japanese",
      replacement_origin_kind: "artist_custom",
      replacement_source: "Artist-entered custom Japanese first name · explicit origin recovery",
      replacement_trait_source: `Artist custom Japanese first name · Clothing:${row.clothing} + Body:${row.body_gender}`,
      replacement_rationale: `Artist explicitly confirmed “${row.value}” as a custom Japanese first name. Origin corrected without changing the name, decision, scope, or greenlit status. Gender route remains Body:${row.body_gender}.`,
      origin_recovery: {
        previous_origin: "western",
        recovered_origin: "japanese",
        evidence: row.evidence,
        recovered_at: timestamp,
        recovered_by: "Codex · artist-confirmed Japanese origin recovery",
      },
      updated_at: timestamp,
    };
    record.updated_at = timestamp;
  }
  if (decisionSignature(next) !== beforeSignature) {
    throw new Error("A name, status, scope, or active surname structure would change. Nothing changed.");
  }
  next.revision = Number(state.revision) + 1;
  next.updated_at = timestamp;
  next.updated_by = "Codex · artist-confirmed Japanese origin recovery";
  next.curation.updated_at = timestamp;
  next.history = [
    ...(state.history || []),
    ...rows.map((row) => ({
      at: timestamp,
      by: "Codex",
      character_id: row.character_id,
      part: row.name_component,
      action: `Corrected source-bank origin western → japanese for artist-confirmed ${row.value}; name and status preserved`,
    })),
  ].slice(-250);
  const committed = await compareAndSwapState(expectedRevision, next);
  if (!committed) throw new Error("Live revision changed during the transaction. Nothing changed.");

  const resulting = await getOrCreateState();
  if (Number(resulting.revision) !== next.revision) throw new Error("Could not verify the resulting revision.");
  if (decisionSignature(resulting) !== beforeSignature) throw new Error("Post-commit verification found a name or curation-status change.");
  for (const row of rows) {
    const part = resulting.curation.records[row.character_id].parts.first;
    if (part.replacement_value !== row.value || part.replacement_language !== "japanese" || part.replacement_origin_kind !== "artist_custom") {
      throw new Error(`Post-commit verification failed for #${row.character_id}.`);
    }
  }
  const csvPath = path.join(outputDir, `artist-confirmed-origin-corrections-revision-${resulting.revision}.csv`);
  const headers = Object.keys(rows[0]);
  fs.writeFileSync(csvPath, `${headers.join(",")}\n${rows.map(row => headers.map(key => csvCell(row[key])).join(",")).join("\n")}\n`, "utf8");
  const report = {
    applied: rows.length,
    previous_revision: state.revision,
    resulting_revision: resulting.revision,
    names_changed: 0,
    first_name_values_changed: 0,
    surname_values_changed: 0,
    greenlit_or_decision_changes: 0,
    scope_changes: 0,
    character_trait_changes: 0,
    corrected_components: rows,
    backup: backupPath,
    audit_csv: csvPath,
  };
  const reportPath = path.join(outputDir, `application-report-revision-${resulting.revision}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
