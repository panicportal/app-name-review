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
  // Keep original assignments reserved as well as live replacements. This
  // prevents an undo on one character from creating a duplicate elsewhere.
  const used = new Set(
    review.characters
      .filter((character) => String(character.id) !== exceptId)
      .map((character) => String(character.first || "").toLowerCase())
      .filter(Boolean)
  );
  for (const character of review.characters) {
    const id = String(character.id);
    if (id === exceptId) continue;
    const rawRecord = state.curation?.records?.[id];
    const record = rawRecord?.deleted_at ? null : rawRecord;
    const firstPart = record?.parts?.first;
    const replacement =
      !firstPart?.deleted_at && firstPart?.replacement_value;
    if (replacement) used.add(String(replacement).toLowerCase());
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
    const id = String(character.id);
    if (id === exceptId) continue;
    const rawRecord = state.curation?.records?.[id];
    const record = rawRecord?.deleted_at ? null : rawRecord;
    const part1 = record?.parts?.surname_part_1;
    const part2 = record?.parts?.surname_part_2;
    if (!part1?.disabled) {
      add(
        (!part1?.deleted_at && part1?.replacement_value) ||
        character.surname_component_1
      );
    }
    if (!part2?.disabled) {
      add(
        (!part2?.deleted_at && part2?.replacement_value) ||
        character.surname_component_2
      );
    }
  }
  return counts;
}

function candidatesFor(character, part, language, sourceOverride = "") {
  if (part === "first") {
    const bank = catalog.first[character.clothing] || {};
    const matchesBodyGender = (candidate) =>
      !candidate.gender_route ||
      candidate.gender_route === character.gender_from_body;
    const unique = (values) => {
      const seen = new Set();
      return values.filter((candidate) => {
        const key = String(candidate.value || "").toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const originalSource = `Clothing:${character.clothing}`;
    const selectedSource = sourceOverride || originalSource;
    const routed = catalog.first_by_trait?.[selectedSource] || {};
    const japanese = selectedSource === originalSource
      ? unique(bank.japanese || []).filter(matchesBodyGender)
      : unique([
          ...(routed[character.gender_from_body] || []),
          ...(routed.Any || []),
        ]).filter(matchesBodyGender);
    if (language === "any") {
      return unique([...(bank.western || []), ...japanese]).filter(matchesBodyGender);
    }
    if (language === "japanese") return japanese;
    return (bank[language] || []).filter(matchesBodyGender);
  }
  const source = sourceOverride || (
    part === "surname_part_1"
      ? character.surname_source_1
      : character.surname_source_2
  );
  const bank = catalog.surname[source] || {};
  if (language === "any") {
    return [...(bank.western || []), ...(bank.japanese || [])];
  }
  return bank[language] || [];
}

function availableFirstTraitSources(character) {
  const originalSource = `Clothing:${character.clothing}`;
  return (character.traits || [])
    .map((trait) => {
      const source = `${trait.type}:${trait.value}`;
      const routed = catalog.first_by_trait?.[source] || {};
      const count = source === originalSource
        ? (catalog.first?.[character.clothing]?.japanese || []).filter(
            (candidate) => safe(candidate.value)
          ).length
        : [
            ...(routed[character.gender_from_body] || []),
            ...(routed.Any || []),
          ].filter((candidate) => safe(candidate.value)).length;
      return {
        source,
        label: `${trait.type} · ${trait.value}`,
        western_count: 0,
        japanese_count: count,
        primary: source === originalSource,
      };
    })
    .filter((item) => item.japanese_count);
}

function availableTraitSources(character) {
  return (character.traits || [])
    .map((trait) => {
      const source = `${trait.type}:${trait.value}`;
      const bank = catalog.surname[source] || {};
      return {
        source,
        label: `${trait.type} · ${trait.value}`,
        western_count: (bank.western || []).filter((candidate) => safe(candidate.value)).length,
        japanese_count: (bank.japanese || []).filter((candidate) => safe(candidate.value)).length,
      };
    })
    .filter((item) => item.western_count || item.japanese_count);
}

function roundScore(value) {
  return Math.round(Math.max(1, Math.min(10, value)) * 10) / 10;
}

function capitalize(value) {
  const text = String(value || "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function canFlip(firstPart, secondPart) {
  return Boolean(firstPart && secondPart);
}

function joinSurname(character, firstPart, secondPart, order = "12", joinStyle = "camel") {
  if (!firstPart) return capitalize(secondPart) || character.surname || "";
  if (!secondPart) return capitalize(firstPart) || character.surname || "";
  const left = order === "21" ? secondPart : firstPart;
  const right = order === "21" ? firstPart : secondPart;
  const rightText = joinStyle === "lower_second"
    ? String(right || "").trim().toLowerCase()
    : capitalize(right);
  return `${capitalize(left)}${rightText}`;
}

function scorePreview({ first, surname, firstPart, secondPart, usageCount = 0, rank = 0, fitType = "" }) {
  const fullName = `${first} ${surname}`.trim();
  const surnameLength = surname.length;
  const fullLength = fullName.length;
  const boundaryRepeat = Boolean(
    firstPart &&
    secondPart &&
    firstPart.slice(-1).toLowerCase() === secondPart.slice(0, 1).toLowerCase()
  );
  const hardCluster = /[^aeiouy\s'-]{4,}/i.test(surname);
  let readability = 9.7;
  readability -= Math.max(0, surnameLength - 13) * 0.22;
  readability -= Math.max(0, fullLength - 27) * 0.12;
  if (boundaryRepeat) readability -= 0.6;
  if (hardCluster) readability -= 0.7;
  if (surnameLength <= 11) readability += 0.2;

  let collectability = 8.2;
  if (/literal|exact|direct/i.test(fitType)) collectability += 0.6;
  if (surnameLength >= 7 && surnameLength <= 13) collectability += 0.5;
  if (firstPart && secondPart) collectability += 0.35;
  collectability -= Math.min(1.5, usageCount * 0.03);
  collectability -= Math.min(0.8, Number(rank || 0) * 0.025);
  if (boundaryRepeat || hardCluster) collectability -= 0.35;

  const compact = surnameLength <= 12 && fullLength <= 27;
  return {
    readability: roundScore(readability),
    collectability: roundScore(collectability),
    readability_note: compact
      ? "Compact length with a clear speaking rhythm"
      : "Scored from full-name length, rhythm, and compound boundary",
    collectability_note: usageCount
      ? `Trait fit and compactness, with ${usageCount} other fragment use${usageCount === 1 ? "" : "s"}`
      : "Trait fit, compactness, and no other proposed fragment uses",
    compact,
    surname_length: surnameLength,
    full_name_length: fullLength,
  };
}

function previewFor(
  character,
  first,
  firstPart,
  secondPart,
  order,
  candidate,
  usageCount,
  joinStyle = "camel"
) {
  const surname = joinSurname(character, firstPart, secondPart, order, joinStyle);
  const scores = scorePreview({
    first,
    surname,
    firstPart: order === "21" ? secondPart : firstPart,
    secondPart: order === "21" ? firstPart : secondPart,
    usageCount,
    rank: candidate?.rank,
    fitType: candidate?.fit_type,
  });
  return {
    order,
    join_style: joinStyle,
    surname,
    full_name: `${first} ${surname}`.trim(),
    compact: scores.compact,
    scores,
  };
}

function proposedValue(state, id, part, fallback) {
  const saved = state.curation?.records?.[id]?.parts?.[part];
  if (saved?.disabled) return "";
  return saved?.replacement_value || fallback || "";
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
    const record = state.curation?.records?.[id] || {};
    const firstUsed = part === "first" ? usedFirstNames(state, id) : null;
    const usage = part === "first" ? null : componentUsage(state, id);
    const allUsage = componentUsage(state, id);
    const current =
      part === "first"
        ? character.first
        : part === "surname_part_1"
          ? character.surname_component_1
          : character.surname_component_2;
    const originalTraitSource =
      part === "surname_part_1"
        ? character.surname_source_1
        : part === "surname_part_2"
          ? character.surname_source_2
          : `Clothing:${character.clothing}`;
    const traitSources = part === "first"
      ? language === "japanese" ? availableFirstTraitSources(character) : []
      : availableTraitSources(character);
    // Some serverless/dev query parsers preserve URLSearchParams' "+" for
    // spaces. Normalize it so exact trait keys such as "Lovely Pink" survive.
    const requestedSource = String(req.query.source || "").replace(/\+/g, " ");
    const eligibleTraitSources = traitSources.filter((item) =>
      language === "japanese" ? item.japanese_count > 0 : item.western_count > 0
    );
    const defaultTraitSource = eligibleTraitSources.some(
      (item) => item.source === originalTraitSource
    )
      ? originalTraitSource
      : eligibleTraitSources[0]?.source || originalTraitSource;
    const traitSource = eligibleTraitSources.some((item) => item.source === requestedSource)
        ? requestedSource
        : defaultTraitSource;
    const currentFirst = proposedValue(state, id, "first", character.first);
    const currentPart1 = proposedValue(
      state,
      id,
      "surname_part_1",
      character.surname_component_1 || character.surname
    );
    const currentPart2 = proposedValue(
      state,
      id,
      "surname_part_2",
      character.surname_component_2
    );
    const currentOrder = canFlip(currentPart1, currentPart2) && record.surname_order === "21"
      ? "21"
      : "12";
    const currentJoinStyle =
      record.surname_join_style === "lower_second" ? "lower_second" : "camel";
    const currentUsage =
      (allUsage.get(String(currentPart1).toLowerCase()) || 0) +
      (allUsage.get(String(currentPart2).toLowerCase()) || 0);
    const canPreviewFlip =
      part !== "first" && canFlip(currentPart1, currentPart2);
    const currentOrders = canPreviewFlip ? ["12", "21"] : [currentOrder];
    const currentFormatPreviews = Object.fromEntries(
      ["camel", "lower_second"].map((joinStyle) => [
        joinStyle,
        Object.fromEntries(
          currentOrders.map((order) => [
            order,
            previewFor(
              character,
              currentFirst,
              currentPart1,
              currentPart2,
              order,
              { rank: 0, fit_type: "current" },
              currentUsage,
              joinStyle
            ),
          ])
        ),
      ])
    );
    const currentOrderPreviews = currentFormatPreviews[currentJoinStyle];
    const currentPreview = {
      ...currentOrderPreviews[currentOrder],
      can_flip: canPreviewFlip,
      order_previews: currentOrderPreviews,
      format_previews: currentFormatPreviews,
      can_use_single: part !== "first" && Boolean(
        part === "surname_part_1" ? currentPart1 : currentPart2
      ),
    };

    const evaluated = candidatesFor(character, part, language, traitSource)
      .filter((candidate) => safe(candidate.value))
      .filter((candidate) => candidate.value.toLowerCase() !== String(current).toLowerCase())
      .filter((candidate) => !firstUsed || !firstUsed.has(candidate.value.toLowerCase()))
      .map((candidate) => {
        const candidateFirst = part === "first" ? candidate.value : currentFirst;
        const candidatePart1 = part === "surname_part_1" ? candidate.value : currentPart1;
        const candidatePart2 = part === "surname_part_2" ? candidate.value : currentPart2;
        const usageCount = part === "first"
          ? 0
          : usage?.get(candidate.value.toLowerCase()) || 0;
        const scoreUsageCount =
          part === "first"
            ? currentUsage
            : usageCount + (
              part === "surname_part_1"
                ? allUsage.get(String(currentPart2).toLowerCase()) || 0
                : allUsage.get(String(currentPart1).toLowerCase()) || 0
            );
        const orders =
          part !== "first" && canFlip(candidatePart1, candidatePart2)
            ? ["12", "21"]
            : [currentOrder];
        const formatPreviews = Object.fromEntries(
          ["camel", "lower_second"].map((joinStyle) => [
            joinStyle,
            Object.fromEntries(
              orders.map((order) => [
                order,
                previewFor(
                  character,
                  candidateFirst,
                  candidatePart1,
                  candidatePart2,
                  order,
                  candidate,
                  scoreUsageCount,
                  joinStyle
                ),
              ])
            ),
          ])
        );
        const orderPreviews = formatPreviews[currentJoinStyle];
        const singleFirstPart = part === "surname_part_1" ? candidate.value : currentPart1;
        const singleSecondPart = part === "surname_part_2" ? candidate.value : currentPart2;
        const singlePreview = part === "first"
          ? null
          : previewFor(
              character,
              candidateFirst,
              part === "surname_part_1" ? singleFirstPart : "",
              part === "surname_part_2" ? singleSecondPart : "",
              "12",
              candidate,
              usageCount,
              "camel"
            );
        const recommendedOrder = orders.sort((left, right) => {
          const leftScores = orderPreviews[left].scores;
          const rightScores = orderPreviews[right].scores;
          return (
            rightScores.readability + rightScores.collectability -
            leftScores.readability - leftScores.collectability
          );
        })[0];
        const recommended = orderPreviews[recommendedOrder];
        return {
          ...candidate,
          usage_count: usageCount,
          score_usage_count: scoreUsageCount,
          uniqueness:
            part === "first"
              ? "Unused across all 3,333 current and proposed first names"
              : `${usageCount} other current/proposed uses`,
          recommended_order: recommendedOrder,
          order_previews: orderPreviews,
          format_previews: formatPreviews,
          single_preview: singlePreview,
          preview_surname: recommended.surname,
          preview_full_name: recommended.full_name,
          scores: recommended.scores,
          length_check: recommended.compact ? "Compact length" : "Longer form",
        };
      })
      .filter((candidate) => {
        const previews = Object.values(candidate.order_previews);
        return previews.some((preview) =>
          part === "first"
            ? candidate.value.length <= 20 && preview.full_name.length <= 34
            : preview.surname.length <= 22 && preview.full_name.length <= 36
        );
      });
    const balanced = [...evaluated].sort((left, right) =>
      (
        right.scores.readability + right.scores.collectability
      ) - (
        left.scores.readability + left.scores.collectability
      ) ||
      left.usage_count - right.usage_count ||
      Number(left.rank || 0) - Number(right.rank || 0)
    );
    const shortest = [...evaluated].sort((left, right) =>
      left.preview_surname.length - right.preview_surname.length ||
      left.preview_full_name.length - right.preview_full_name.length
    );
    const leastUsed = [...evaluated].sort((left, right) =>
      left.usage_count - right.usage_count ||
      stableScore(id, left.value) - stableScore(id, right.value)
    );
    const suggestions = [];
    const seen = new Set();
    for (const candidate of [
      ...balanced.slice(0, 18),
      ...shortest.slice(0, 14),
      ...leastUsed.slice(0, 10),
    ]) {
      const key = candidate.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(candidate);
      if (suggestions.length >= 36) break;
    }
    return res.status(200).json({
      character_id: id,
      part,
      language,
      gender_route: character.gender_from_body,
      clothing: character.clothing,
      trait_source:
        traitSource,
      original_trait_source: originalTraitSource,
      available_trait_sources: traitSources,
      policy: catalog.policy,
      japanese_coverage: part === "first" && language === "japanese"
        ? {
            exact_artist_bank_options_before_uniqueness: candidatesFor(
              character,
              part,
              language,
              traitSource
            ).filter((candidate) => safe(candidate.value)).length,
            unused_exact_options: evaluated.length,
            route: "Selected visible trait bank, Body-gender only",
          }
        : null,
      current_preview: currentPreview,
      suggestions,
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message || "Could not load suggestions." });
  }
};
