const fs = require("node:fs");
const path = require("node:path");

const [input, output = path.join(process.cwd(), "reports", "surname_component_repair_audit.csv")] = process.argv.slice(2);
if (!input) throw new Error("Usage: node scripts/build-surname-repair-audit.js <curation.json> [output.csv]");
const payload = JSON.parse(fs.readFileSync(input, "utf8"));
const rows = [];
for (const record of payload.records || []) {
  const part1 = record.parts?.surname_part_1 || {};
  const part2 = record.parts?.surname_part_2 || {};
  const collapsed = part1.selected_replacement &&
    /manual team edit|direct full-name edit/i.test(part1.replacement_source || "") &&
    part2.disabled;
  if (!collapsed) continue;
  rows.push({
    character_id: record.id,
    visible_full_name: record.preview_full_name || "",
    visible_surname_preserved: part1.selected_replacement,
    stored_part_1_route: part1.replacement_trait_source || "",
    legacy_part_2_route: part2.source || "",
    evidence_status: "unresolved",
    repair_action: "Confirm two exact non-Body/non-Clothing trait routes and two component words in Name Studio; do not infer from spelling.",
  });
}
const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const headers = Object.keys(rows[0] || {});
const csv = [headers.map(quote).join(","), ...rows.map((row) => headers.map((key) => quote(row[key])).join(","))].join("\n") + "\n";
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, csv);
console.log(JSON.stringify({ input, output, collapsed_records: rows.length }));
