const crypto = require("node:crypto");
const catalog = require("../cloud_suggestion_catalog.json");
const review = require("../review_data.json");
const { requireSession } = require("./_lib/auth");
const { getOrCreateState } = require("./_lib/state");

const characters = new Map(
  review.characters.map((character) => [String(character.id), character])
);

const blocked = [
  /pounder/i,
  /diddy/i,
  /ureña/i,
  /cig/i,
  /slur/i,
  /^isis$/i,
];

function safe(value) {
  return (
    /^[A-Za-z][A-Za-z'-]{1,19}$/.test(value) &&
    !blocked.some((pattern) => pattern.test(value))
  );
}

function stableScore(id, value) {
  return parseInt(
    crypto.createHash("sha256").update(`${id}:${value}`).digest("hex").slice(0, 8),
    16
  );
}

function usedFirstNames(state, exceptId) {
  const used = new Set(
    review.characters
      .filter((character) => String(character.id) !== exceptId)
      .map((character) => String(character.first || "").toLowerCase())
  );
  for (const [id, record] of Object.entries(state.curation?.records || {})) {
    if (id === exceptId || record.deleted_at) continue;
    const proposed = record.parts?.first?.replacement_value;
    if (proposed) used.add(String(proposed).toLowerCase());
  }
  return used;
}

function componentUsage(state, exceptId) {
  const counts = new Map();
  const add = (value) => {
    const key = String(value || "").toLowerCase();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const character of review.characters) {
    if (String(character.id) === exceptId) continue;
    add(character.surname_component_1);
    add(character.surname_component_2);
  }
  for (const [id, record] of Object.entries(state.curation?.records || {})) {
    if (id === exceptId || record.deleted_at) continue;
    add(record.parts?.surname_part_1?.replacement_value);
    add(record.parts?.surname_part_2?.replacement_value);
  }
  return counts;
}

function candidatesFor(character, part, language) {
  if (part === "first") {
    const bank = catalog.first[character.clothing] || {};
    if (language === "any") {
      return [...(bank.western || []), ...(bank.japanese || [])];
    }
    return bank[language] || [];
  }
  const source =
    part === "surname_part_1"
      ? character.surname_source_1
      : character.surname_source_2;
  const bank = catalog.surname[source] || {};
  if (language === "any") {
    return [...(bank.western || []), ...(bank.japanese || [])];
  }
  return bank[language] || [];
}

function previewSurname(character, part, value) {
  const original =
    part === "surname_part_1"
      ? character.surname_component_1 || character.surname
      : character.surname_component_2;
  if (!original) return value;
  const escaped = String(original).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "i");
  return pattern.test(character.surname)
    ? character.surname.replace(pattern, value)
    : value;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  try {
    const id = String(req.query.id || "");
    const part = String(req.query.part || "");
    const character = characters.get(id);
    if (!character || !["first", "surname_part_1", "surname_part_2"].includes(part)) {
      return res.status(400).json({ error: "Unknown character or name part." });
    }
    const requestedLanguage = String(req.query.language || "");
    const language =
      requestedLanguage === "western" || requestedLanguage === "japanese"
        ? requestedLanguage
        : part === "first"
          ? character.first_name_language
          : character.surname_language;
    const state = await getOrCreateState();
    const firstUsed = part === "first" ? usedFirstNames(state, id) : null;
    const usage = part === "first" ? null : componentUsage(state, id);
    const current =
      part === "first"
        ? character.first
        : part === "surname_part_1"
          ? character.surname_component_1
          : character.surname_component_2;
    const suggestions = candidatesFor(character, part, language)
      .filter((candidate) => safe(candidate.value))
      .filter((candidate) => candidate.value.toLowerCase() !== String(current).toLowerCase())
      .filter((candidate) => !firstUsed || !firstUsed.has(candidate.value.toLowerCase()))
      .map((candidate) => ({
        ...candidate,
        usage_count: usage?.get(candidate.value.toLowerCase()) || 0,
        preview_surname:
          part === "first" ? character.surname : previewSurname(character, part, candidate.value),
        uniqueness:
          part === "first"
            ? "Unused across all 3,333 current and proposed first names"
            : `${usage?.get(candidate.value.toLowerCase()) || 0} other current/proposed uses`,
      }))
      .map((candidate) => ({
        ...candidate,
        preview_full_name:
          part === "first"
            ? `${candidate.value} ${character.surname}`
            : `${character.first} ${candidate.preview_surname}`,
        length_check:
          (part === "first" ? candidate.value.length : candidate.preview_surname.length) <= 20
            ? "Compact length"
            : "Long form",
      }))
      .filter((candidate) =>
        part === "first"
          ? candidate.value.length <= 20
          : candidate.preview_surname.length <= 20 && candidate.preview_full_name.length <= 34
      )
      .sort(
        (left, right) =>
          left.usage_count - right.usage_count ||
          Number(left.rank || 0) - Number(right.rank || 0) ||
          stableScore(id, left.value) - stableScore(id, right.value)
      )
      .slice(0, 18);
    return res.status(200).json({
      character_id: id,
      part,
      language,
      gender_route: character.gender_from_body,
      clothing: character.clothing,
      trait_source:
        part === "surname_part_1"
          ? character.surname_source_1
          : part === "surname_part_2"
            ? character.surname_source_2
            : `Clothing:${character.clothing}`,
      policy: catalog.policy,
      suggestions,
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message || "Could not load suggestions." });
  }
};
