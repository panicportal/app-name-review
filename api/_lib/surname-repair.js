const catalog = require("../../cloud_suggestion_catalog.json");
const { characterTraitSources, cleanComponent, composeSurname } = require("./name-model");

// Recovery-only aliases observed in the team's pasted ChatGPT compounds. They
// are mapped to exact collection traits and are never used as name provenance
// without that exact trait being present on the character.
const RECOVERY_ALIASES = {
  "Background:Hungry Red": ["Red"],
  "Background:Lovely Pink": ["Pink"],
  "Background:Romantic Purple": ["Violet"],
  "Background:Silent Violet": ["Night"],
  "Eyebrows:Relax": ["Chill"],
  "Eyebrows:Scared": ["Scare"],
  "Eyes:3D glasses": ["Depth"],
  "Eyes:Glare": ["Gaze"],
  "Eyes:Hanging sanpaku": ["Gaze"],
  "Eyes:Happy": ["Merry", "Light"],
  "Hair:Dandelion rough buns": ["Dandel"],
  "Hair:Jet loose": ["Noir"],
  "Hair:Moon candy": ["Luna", "Pop"],
  "Hair:Banana flattop": ["Golden", "Yellow"],
  "Hair:Biscotti rough": ["Rough"],
  "Hair:Tar shower": ["Fall", "Ink"],
  "Mouth:Grimace": ["Icky"],
  "Mouth:Mad": ["Grump"],
  "Mouth:Proud": ["Pride"],
  "Mouth:Laughing": ["Merry"],
  "Mouth:Smile": ["Smiles", "Grin"],
  "Back:Fire": ["Ember"],
  "Back:Fuzzy swirl": ["Swirly", "Twist"],
  "Back:Overgrown wasteland": ["Grown"],
  "Back:Sun": ["Sun"],
  "Back:Swamp swirl": ["Swirly", "Swamp"],
  "Back:Treasures": ["Gem"],
  "Back:Waning crescent moon": ["Crescent", "Moon"],
  "Back:White cloud": ["Wisp", "Cloud", "Puff"],
  "Front:Baseball": ["Pitch", "Wood"],
  "Front:Baguette": ["Loaf"],
  "Front:Cigarette": ["Puff"],
  "Front:Glass of beer": ["Stout"],
  "Front:Hamburger": ["Ham", "Patty", "Bite"],
  "Front:Skateboard": ["Ride"],
  "Front:Red rose": ["Rose"],
  "Front:Soft serve ice cream": ["Soft", "Whip", "Cone"],
  "Front:Soccer ball": ["Strike", "Shot"],
  "Front:White flat brush": ["Brush"],
  "Front:Taco": ["Taco"],
  "Front:Tuna sushi": ["Fin", "Maki"],
};

function partValue(record, key, fallback = "") {
  const part = record?.parts?.[key];
  if (part?.disabled) return "";
  return cleanComponent(part?.replacement_value || fallback);
}

function liveSurname(character, record) {
  if (record?.normalized_name?.surname_display) return cleanComponent(record.normalized_name.surname_display);
  const first = partValue(record, "surname_part_1", character.surname_component_1 || character.surname);
  const second = partValue(record, "surname_part_2", character.surname_component_2);
  return composeSurname([{ order: 1, text: first }, { order: 2, text: second }], record?.surname_order, record?.surname_join_style);
}

function sourceCandidates(character, state) {
  const bySource = new Map();
  for (const source of characterTraitSources(character)) {
    const candidates = [];
    for (const item of catalog.surname?.[source]?.western || []) {
      const text = cleanComponent(item.value);
      if (text) candidates.push({ text, source_raw: source, rank: Number(item.rank || 0), evidence: "reviewed_trait_bank" });
    }
    for (const alias of RECOVERY_ALIASES[source] || []) {
      const text = cleanComponent(alias);
      if (text) candidates.push({ text, source_raw: source, rank: 12, evidence: "team_recovery_alias" });
    }
    bySource.set(source, candidates);
  }
  // Reuse team-authored atomic fragments only when their exact stored route is
  // one of this character's real eligible traits. This makes custom wordplay
  // discoverable without treating spelling as provenance.
  for (const record of Object.values(state?.curation?.records || {})) {
    for (const key of ["surname_part_1", "surname_part_2"]) {
      const part = record?.parts?.[key];
      const source = part?.replacement_trait_source;
      if (!bySource.has(source) || part?.disabled) continue;
      const text = cleanComponent(part.replacement_value);
      if (!text || text.length > 16) continue;
      bySource.get(source).push({ text, source_raw: source, rank: 20, evidence: "stored_team_fragment" });
    }
  }
  for (const [source, values] of bySource) {
    const unique = new Map();
    values.forEach((candidate) => {
      const key = candidate.text.toLowerCase();
      if (!unique.has(key) || candidate.rank < unique.get(key).rank) unique.set(key, candidate);
    });
    bySource.set(source, [...unique.values()]);
  }
  return bySource;
}

function exactSplits(target, character, state) {
  const normalizedTarget = cleanComponent(target).toLowerCase();
  if (!normalizedTarget) return [];
  const bySource = sourceCandidates(character, state);
  const sources = [...bySource.keys()];
  const proposals = [];
  for (const source1 of sources) {
    for (const source2 of sources) {
      if (source1 === source2) continue;
      for (const left of bySource.get(source1)) {
        for (const right of bySource.get(source2)) {
          const joined = `${left.text}${right.text}`.toLowerCase();
          const overlaps = left.text.slice(-1).toLowerCase() === right.text.slice(0, 1).toLowerCase();
          const overlapJoined = overlaps ? `${left.text}${right.text.slice(1)}`.toLowerCase() : "";
          if (joined !== normalizedTarget && overlapJoined !== normalizedTarget) continue;
          const joinStyle = overlapJoined === normalizedTarget ? "overlap_one" : "lower_second";
          const display = joinStyle === "overlap_one"
            ? `${left.text}${right.text.slice(1).toLowerCase()}`
            : `${left.text}${right.text.charAt(0).toLowerCase()}${right.text.slice(1)}`;
          proposals.push({
            surname_display: display,
            surname_components: [
              { order: 1, text: left.text, source_raw: source1 },
              { order: 2, text: right.text, source_raw: source2 },
            ],
            confidence: "very_high",
            join_style: joinStyle,
            confidence_score: Math.max(90, 100 - left.rank - right.rank),
            evidence: `${left.evidence} + ${right.evidence}`,
          });
        }
      }
    }
  }
  const unique = new Map();
  proposals.forEach((proposal) => {
    const key = proposal.surname_components.map((part) => `${part.text}|${part.source_raw}`).join("+");
    if (!unique.has(key) || proposal.confidence_score > unique.get(key).confidence_score) unique.set(key, proposal);
  });
  return [...unique.values()].sort((a, b) => b.confidence_score - a.confidence_score);
}

function isGreenlit(record) {
  return ["surname_part_1", "surname_part_2"].some((key) => record?.parts?.[key]?.decision === "approve");
}

function hasValidStructuredSurname(record) {
  const normalized = record?.normalized_name;
  if (Number(normalized?.surname_format_version || 0) < 3 || !Array.isArray(normalized.surname_components) || normalized.surname_components.length !== 2) return false;
  return normalized.surname_components.every((part) => cleanComponent(part.text) && part.source_raw);
}

function repairCandidates(character, record, state, requestedSurname = "") {
  const storedPart1 = cleanComponent(record?.parts?.surname_part_1?.replacement_value);
  const current = liveSurname(character, record);
  const requested = cleanComponent(requestedSurname);
  const inputs = [];
  const addInput = (value, origin, priority) => {
    if (!value || inputs.some((item) => item.value.toLowerCase() === value.toLowerCase())) return;
    inputs.push({ value, origin, priority });
  };
  addInput(requested, "pasted_full_surname", 1200);
  // A full compound stored inside part 1 is the strongest recovery evidence
  // for records damaged by the old direct full-name editor.
  addInput(storedPart1, "stored_manual_whole_surname", 1100);
  addInput(current, "current_visible_surname", 900);
  addInput(cleanComponent(record?.normalized_name?.surname_display), "normalized_display", 850);
  const results = [];
  for (const input of inputs) {
    for (const proposal of exactSplits(input.value, character, state)) {
      results.push({
        ...proposal,
        detected_from: input.value,
        detected_from_origin: input.origin,
        score: input.priority + proposal.confidence_score,
        corrects_current_display: Boolean(current && proposal.surname_display.toLowerCase() !== current.toLowerCase()),
        current_display: current,
      });
    }
  }
  const unique = new Map();
  results.forEach((proposal) => {
    const key = proposal.surname_components.map((part) => `${part.text}|${part.source_raw}`).join("+");
    if (!unique.has(key) || proposal.score > unique.get(key).score) unique.set(key, proposal);
  });
  return [...unique.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

function shouldOfferRepair(character, record, state) {
  if (!record || !isGreenlit(record)) return false;
  const part1 = record.parts?.surname_part_1;
  const part2 = record.parts?.surname_part_2;
  const explicitLanguages = [part1, part2]
    .filter((part) => part && !part.disabled && part.replacement_language)
    .map((part) => part.replacement_language);
  const western = explicitLanguages.includes("western") ||
    (!explicitLanguages.includes("japanese") && character.surname_language === "western");
  if (!western) return false;
  const collapsed = Boolean(
    part1?.replacement_value &&
    (!part2 || part2.disabled || part2.deleted_at || !part2.replacement_value)
  );
  if (collapsed) return true;
  // Detect the v20 failure where a complete compound was saved as one of two
  // components and a third fragment was appended.
  const derivation = String(record?.normalized_name?.derivation_method || "");
  if (!derivation.startsWith("manual_")) return false;
  return exactSplits(part1?.replacement_value, character, state).length > 0 ||
    exactSplits(part2?.replacement_value, character, state).length > 0;
}

module.exports = {
  exactSplits,
  hasValidStructuredSurname,
  isGreenlit,
  liveSurname,
  repairCandidates,
  shouldOfferRepair,
};
