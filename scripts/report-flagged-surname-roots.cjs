const fs = require("node:fs");
const path = require("node:path");
const review = require("../review_data.json");
const catalog = require("../cloud_suggestion_catalog.json");
const repair = require("../api/_lib/surname-repair");

const auditDir = fs.readdirSync(path.resolve("audits"), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith("studio-health-"))
  .map(entry => path.resolve("audits", entry.name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!auditDir) throw new Error("Run audit-live-repairs.cjs first.");
const state = JSON.parse(fs.readFileSync(path.join(auditDir, "live-before.json"), "utf8"));
const requestedIds = new Set(process.argv.slice(2));
const flagged = JSON.parse(fs.readFileSync(path.join(auditDir, "repair-audit.json"), "utf8"))
  .filter(row => !requestedIds.size || requestedIds.has(String(row.id)));
const characters = new Map(review.characters.map(character => [String(character.id), character]));
const greenlitRoots = new Map();
const greenlitPairs = new Map();

for (const [id, record] of Object.entries(state.curation.records || {})) {
  const character = characters.get(id);
  if (!character || repair.shouldOfferRepair(character, record, state)) continue;
  const first = record.parts?.surname_part_1;
  const second = record.parts?.surname_part_2;
  const components = record.normalized_name?.surname_components;
  if (first?.decision !== "approve" || second?.decision !== "approve" || !Array.isArray(components) || components.length !== 2) continue;
  for (const component of components) {
    const source = component.source_raw;
    const text = component.text;
    if (!source || !text) continue;
    if (!greenlitRoots.has(source)) greenlitRoots.set(source, new Map());
    const values = greenlitRoots.get(source);
    values.set(text, (values.get(text) || 0) + 1);
  }
  const pairKey = components.map(component => component.source_raw).sort().join(" | ");
  greenlitPairs.set(pairKey, (greenlitPairs.get(pairKey) || 0) + 1);
}

function rootsFor(source) {
  const approved = [...(greenlitRoots.get(source) || new Map()).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([text, count]) => `${text} (${count} greenlit)`);
  const curated = (catalog.surname?.[source]?.western || [])
    .slice(0, 12)
    .map(item => item.value);
  return { approved, curated };
}

for (const row of flagged) {
  const character = characters.get(String(row.id));
  console.log(`\n#${row.id} ${row.first} ${row.surname} — ${row.clothing}`);
  for (const trait of character.traits.filter(item => !["Body", "Clothing"].includes(item.type))) {
    const source = `${trait.type}:${trait.value}`;
    const roots = rootsFor(source);
    console.log(`  ${source}`);
    console.log(`    greenlit: ${roots.approved.join(", ") || "—"}`);
    console.log(`    curated:  ${roots.curated.join(", ") || "—"}`);
  }
}
