const catalog = require("../../cloud_suggestion_catalog.json");
const review = require("../../review_data.json");

const characters = new Map(
  review.characters.map((character) => [String(character.id), character])
);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueMatches(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    const key = `${match.origin}|${match.route}|${normalize(match.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchingCandidates(candidates, value, origin, route) {
  const target = normalize(value);
  return (candidates || [])
    .filter((candidate) => normalize(candidate.value) === target)
    .map((candidate) => ({
      origin,
      route,
      value: candidate.value,
      source: candidate.source || route,
      closed_bank: Boolean(candidate.closed_bank),
    }));
}

function bodyGender(character) {
  return character.gender_from_body || "";
}

function traitRoutes(character) {
  return (character.traits || []).map((trait) => `${trait.type}:${trait.value}`);
}

function allJapaneseValues(kind) {
  const result = new Set();
  if (kind === "first") {
    for (const banks of Object.values(catalog.first || {})) {
      for (const candidate of banks.japanese || []) result.add(normalize(candidate.value));
    }
    for (const genders of Object.values(catalog.first_by_trait || {})) {
      for (const candidates of Object.values(genders || {})) {
        for (const candidate of candidates || []) result.add(normalize(candidate.value));
      }
    }
  } else {
    for (const banks of Object.values(catalog.surname || {})) {
      for (const candidate of banks.japanese || []) result.add(normalize(candidate.value));
    }
  }
  return result;
}

const globalJapaneseFirsts = allJapaneseValues("first");
const globalJapaneseSurnames = allJapaneseValues("surname");

function detectFirstOrigin(character, value) {
  const gender = bodyGender(character);
  const clothingRoute = `Clothing:${character.clothing || ""}`;
  const clothingBanks = catalog.first?.[character.clothing] || {};
  const japanese = matchingCandidates(
    (clothingBanks.japanese || []).filter((candidate) => !candidate.gender_route || candidate.gender_route === gender),
    value,
    "japanese",
    clothingRoute
  );
  const western = matchingCandidates(
    (clothingBanks.western || []).filter((candidate) => !candidate.gender_route || candidate.gender_route === gender),
    value,
    "western",
    clothingRoute
  );
  for (const route of traitRoutes(character)) {
    japanese.push(...matchingCandidates(
      catalog.first_by_trait?.[route]?.[gender] || [],
      value,
      "japanese",
      route
    ));
  }
  return originResult("first", value, japanese, western);
}

function detectSurnameOrigin(character, value, source = "") {
  const exactSource = String(source || "").trim();
  const routes = traitRoutes(character).filter((route) => catalog.surname?.[route]);
  const eligibleRoutes = exactSource && routes.includes(exactSource) ? [exactSource] : routes;
  const japanese = [];
  const western = [];
  for (const route of eligibleRoutes) {
    const banks = catalog.surname?.[route] || {};
    japanese.push(...matchingCandidates(banks.japanese, value, "japanese", route));
    western.push(...matchingCandidates(banks.western, value, "western", route));
  }
  return originResult("surname", value, japanese, western);
}

function originResult(kind, value, japaneseMatches, westernMatches) {
  const japanese = uniqueMatches(japaneseMatches);
  const western = uniqueMatches(westernMatches);
  const origin = japanese.length && !western.length
    ? "japanese"
    : western.length && !japanese.length
      ? "western"
      : japanese.length && western.length
        ? "ambiguous"
        : "unknown";
  const preferred = origin === "japanese" ? japanese : origin === "western" ? western : [];
  const globalJapanese = (kind === "first" ? globalJapaneseFirsts : globalJapaneseSurnames)
    .has(normalize(value));
  return {
    kind,
    value: String(value || "").trim(),
    origin,
    best_match: preferred[0] || null,
    japanese_matches: japanese,
    western_matches: western,
    exact_global_japanese_match: globalJapanese,
    route_eligible: japanese.length > 0 || western.length > 0,
    evidence: origin === "japanese"
      ? "exact_authoritative_japanese_bank_route"
      : origin === "western"
        ? "exact_curated_western_bank_route"
        : origin === "ambiguous"
          ? "exact_match_in_both_banks"
          : globalJapanese
            ? "japanese_name_not_eligible_for_character_route"
            : "no_exact_route_match",
  };
}

function activeReplacement(record, key) {
  const part = record?.parts?.[key];
  return part && !part.deleted_at && !part.disabled && part.replacement_value ? part : null;
}

function auditOriginMismatches(state) {
  const corrections = [];
  const ambiguous = [];
  const unknown = [];
  const confirmedCustom = [];
  for (const character of review.characters) {
    const id = String(character.id);
    const record = state.curation?.records?.[id];
    if (!record || record.deleted_at) continue;
    const first = activeReplacement(record, "first");
    if (first) {
      const result = detectFirstOrigin(character, first.replacement_value);
      collectAuditResult({
        corrections, ambiguous, unknown, confirmedCustom, result, id, key: "first", part: first,
        fallback: character.first_name_language || "western",
      });
    }
    for (const key of ["surname_part_1", "surname_part_2"]) {
      const part = activeReplacement(record, key);
      if (!part) continue;
      const result = detectSurnameOrigin(
        character,
        part.replacement_value,
        part.replacement_trait_source
      );
      collectAuditResult({
        corrections, ambiguous, unknown, confirmedCustom, result, id, key, part,
        fallback: character.surname_language || "western",
      });
    }
  }
  return { corrections, ambiguous, unknown, confirmedCustom };
}

function collectAuditResult({ corrections, ambiguous, unknown, confirmedCustom, result, id, key, part, fallback }) {
  const currentOrigin = part.replacement_language || fallback;
  const row = {
    character_id: id,
    part: key,
    value: part.replacement_value,
    current_origin: currentOrigin,
    detected_origin: result.origin,
    exact_source_route: result.best_match?.route || part.replacement_trait_source || "",
    evidence: result.evidence,
  };
  if (part.replacement_origin_kind === "artist_custom" || part.replacement_origin_confirmed_by_user === true) {
    confirmedCustom.push({
      ...row,
      detected_origin: currentOrigin,
      evidence: "explicit_artist_custom_origin",
    });
    return;
  }
  if (["japanese", "western"].includes(result.origin) && result.origin !== currentOrigin) {
    corrections.push(row);
  } else if (result.origin === "ambiguous") {
    ambiguous.push(row);
  } else if (result.origin === "unknown") {
    unknown.push(row);
  }
}

module.exports = {
  auditOriginMismatches,
  characters,
  detectFirstOrigin,
  detectSurnameOrigin,
};
