const crypto = require("node:crypto");
const seed = require("../../iconic_fun_seed");
const review = require("../../review_data.json");
const { readJson, writeJson } = require("./store");

const ICONIC_STORE_KEY = "panic:name-review:v12:iconic-bank";
const CATEGORIES = [
  "Iconic Character",
  "Historical / Real Person",
  "Historical / Real Animal",
  "Mythology / Folklore",
  "Cultural Archetype",
  "Internet Culture",
  "Trait Term",
  "Nickname",
  "Wordplay",
  "Invented",
  "Other",
];
const STATUSES = ["approved", "proposed", "rejected"];

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function candidateId(clothing, gender, name, reference = "") {
  return crypto
    .createHash("sha256")
    .update(`${clothing}|${gender}|${name}|${reference}`.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

function sourceUrl(reference) {
  return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(reference)}`;
}

function expandSeed() {
  const candidates = {};
  for (const [clothing, genders] of Object.entries(seed)) {
    for (const gender of ["Male", "Female"]) {
      for (const tuple of genders[gender] || []) {
        const [name, category, reference, reason, score] = tuple;
        const id = candidateId(clothing, gender, name, reference);
        candidates[id] = {
          id,
          name,
          clothing,
          gender,
          category,
          reference,
          source_url: sourceUrl(reference),
          reason,
          confidence: Number(score),
          status: Number(score) >= 90 ? "approved" : "proposed",
          source_kind: "editorial_seed",
          created_at: "2026-08-13T00:00:00.000Z",
          updated_at: "2026-08-13T00:00:00.000Z",
          updated_by: "Name Studio editorial seed",
        };
      }
    }
  }
  return candidates;
}

function initialIconicState() {
  return {
    schema_version: "panic-iconic-bank/v1",
    revision: 1,
    updated_at: new Date().toISOString(),
    updated_by: "Name Studio editorial seed",
    candidates: expandSeed(),
    discovery_runs: [],
  };
}

async function getOrCreateIconicState() {
  let state = await readJson(ICONIC_STORE_KEY);
  if (!state) {
    state = initialIconicState();
    await writeJson(ICONIC_STORE_KEY, state);
  }
  return state;
}

async function writeIconicState(state) {
  return writeJson(ICONIC_STORE_KEY, state);
}

function capacityTarget(count) {
  const n = Number(count || 0);
  if (n <= 0) return 0;
  if (n < 100) return Math.ceil((40 + n * 0.95) / 5) * 5;
  if (n < 200) return Math.ceil((n * 1.5) / 5) * 5;
  return Math.ceil((n + 100) / 5) * 5;
}

function traitCounts() {
  const counts = {};
  for (const character of review.characters) {
    const clothing = character.clothing;
    if (!clothing) continue;
    counts[clothing] ||= { total: 0, Male: 0, Female: 0, Other: 0 };
    counts[clothing].total += 1;
    const gender = character.gender_from_body;
    if (gender === "Male" || gender === "Female") counts[clothing][gender] += 1;
    else counts[clothing].Other += 1;
  }
  return counts;
}

function assignedFirstNames(state) {
  const values = new Set(
    review.characters.map((character) => String(character.first || "").toLowerCase()).filter(Boolean)
  );
  for (const record of Object.values(state?.curation?.records || {})) {
    const value = record?.parts?.first?.replacement_value;
    if (value) values.add(String(value).toLowerCase());
  }
  return values;
}

function normalFirstNames() {
  const catalog = require("../../cloud_suggestion_catalog.json");
  const values = new Set();
  for (const bank of Object.values(catalog.first || {})) {
    for (const candidate of [...(bank.western || []), ...(bank.japanese || [])]) {
      if (candidate?.value) values.add(String(candidate.value).toLowerCase());
    }
  }
  return values;
}

function enrichedCandidates(iconicState, liveState) {
  const assigned = assignedFirstNames(liveState);
  const normal = normalFirstNames();
  const poolKeys = new Set();
  return Object.values(iconicState.candidates || {})
    .filter((candidate) => !candidate.deleted_at)
    .map((candidate) => {
      const normalized = slug(candidate.name);
      const poolKey = `${candidate.clothing}|${candidate.gender}|${normalized}`;
      const duplicate_in_pool = poolKeys.has(poolKey);
      poolKeys.add(poolKey);
      return {
        ...candidate,
        conflicts: {
          assigned: assigned.has(String(candidate.name).toLowerCase()),
          normal_bank: normal.has(String(candidate.name).toLowerCase()),
          duplicate_in_pool,
        },
      };
    });
}

function coverage(iconicState, liveState) {
  const counts = traitCounts();
  const candidates = enrichedCandidates(iconicState, liveState);
  return Object.entries(counts)
    .map(([clothing, count]) => {
      const rows = candidates.filter((candidate) => candidate.clothing === clothing);
      const summarize = (gender) => {
        const genderRows = rows.filter((candidate) => candidate.gender === gender);
        const approved = genderRows.filter((candidate) => candidate.status === "approved").length;
        const target = capacityTarget(count[gender]);
        return {
          characters: count[gender],
          target,
          approved,
          proposed: genderRows.filter((candidate) => candidate.status === "proposed").length,
          rejected: genderRows.filter((candidate) => candidate.status === "rejected").length,
          needed: Math.max(0, target - approved),
        };
      };
      const Male = summarize("Male");
      const Female = summarize("Female");
      return {
        clothing,
        characters: count.total,
        Male,
        Female,
        target_total: Male.target + Female.target,
        approved_total: Male.approved + Female.approved,
        proposed_total: Male.proposed + Female.proposed,
        rejected_total: Male.rejected + Female.rejected,
        needed_total: Male.needed + Female.needed,
      };
    })
    .sort((left, right) => right.characters - left.characters || left.clothing.localeCompare(right.clothing));
}

function validateCandidate(input, traits) {
  const name = String(input.name || "").trim().replace(/\s+/g, " ");
  const clothing = String(input.clothing || "").trim();
  const gender = String(input.gender || "");
  const category = String(input.category || "Other");
  const status = String(input.status || "proposed");
  if (!/^[A-Za-z][A-Za-z' -]{1,23}$/.test(name)) throw new Error("Use 2–24 letters, spaces, apostrophes, or hyphens.");
  if (!traits.has(clothing)) throw new Error("Unknown Clothing trait.");
  if (!["Male", "Female"].includes(gender)) throw new Error("Gender must be Male or Female.");
  if (!CATEGORIES.includes(category)) throw new Error("Unknown category.");
  if (!STATUSES.includes(status)) throw new Error("Unknown approval status.");
  const reference = String(input.reference || "").trim().slice(0, 160);
  const reason = String(input.reason || "").trim().slice(0, 360);
  if (!reference || !reason) throw new Error("Reference and direct-connection reason are required.");
  const suppliedUrl = String(input.source_url || sourceUrl(reference)).trim().slice(0, 500);
  if (!/^https?:\/\//i.test(suppliedUrl)) throw new Error("Source URL must begin with http:// or https://.");
  return {
    name,
    clothing,
    gender,
    category,
    reference,
    source_url: suppliedUrl,
    reason,
    confidence: Math.max(1, Math.min(100, Number(input.confidence || 50))),
    status,
    source_kind: String(input.source_kind || "manual").slice(0, 60),
  };
}

module.exports = {
  candidateId,
  capacityTarget,
  CATEGORIES,
  coverage,
  enrichedCandidates,
  getOrCreateIconicState,
  ICONIC_STORE_KEY,
  initialIconicState,
  sourceUrl,
  traitCounts,
  validateCandidate,
  writeIconicState,
};
