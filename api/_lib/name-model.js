const ELIGIBLE_SURNAME_TRAITS = new Set([
  "Background",
  "Back",
  "Front",
  "Hair",
  "Eyes",
  "Eyebrows",
  "Mouth",
]);

function splitSource(source) {
  const text = String(source || "").trim();
  const divider = text.indexOf(":");
  if (divider < 1) return { trait_category: "", trait_value: "" };
  return {
    trait_category: text.slice(0, divider).trim(),
    trait_value: text.slice(divider + 1).trim(),
  };
}

function cleanComponent(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z]{2,24}$/.test(text)
    ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
    : "";
}

function composeSurname(components, order = "12", joinStyle = "lower_second") {
  const indexed = Object.fromEntries(
    (components || []).map((component) => [String(component.order), cleanComponent(component.text)])
  );
  const values = order === "21" ? [indexed[2], indexed[1]] : [indexed[1], indexed[2]];
  const active = values.filter(Boolean);
  if (active.length < 2) return active[0] || "";
  if (
    joinStyle === "overlap_one" &&
    active[0].slice(-1).toLowerCase() === active[1].slice(0, 1).toLowerCase()
  ) {
    return `${active[0]}${active[1].slice(1).toLowerCase()}`;
  }
  return joinStyle === "camel"
    ? active.join("")
    : `${active[0]}${active[1].charAt(0).toLowerCase()}${active[1].slice(1)}`;
}

function characterTraitSources(character) {
  return (character?.traits || [])
    .filter((trait) => ELIGIBLE_SURNAME_TRAITS.has(trait.type) && trait.value)
    .map((trait) => `${trait.type}:${trait.value}`);
}

function validateStructuredSurname({ character, components, order = "12", join_style = "lower_second", surname_display }) {
  const errors = [];
  if (!Array.isArray(components) || components.length !== 2) {
    return { valid: false, errors: ["Western surnames require exactly two semantic components."] };
  }
  const legalSources = new Set(characterTraitSources(character));
  const normalized = components.map((component, index) => {
    const source = component.source_raw || `${component.trait_category || ""}:${component.trait_value || ""}`;
    const parsed = splitSource(source);
    const text = cleanComponent(component.text);
    if (!text) errors.push(`Surname component ${index + 1} must be one word using 2-24 English letters.`);
    if (!ELIGIBLE_SURNAME_TRAITS.has(parsed.trait_category)) {
      errors.push(`Surname component ${index + 1} cannot use Body, Clothing, or an unknown trait category.`);
    }
    if (!legalSources.has(source)) errors.push(`Surname source “${source}” is not an exact trait on this character.`);
    return {
      order: index + 1,
      text,
      trait_category: parsed.trait_category,
      trait_value: parsed.trait_value,
      source_raw: source,
      confidence: component.confidence || "confirmed",
    };
  });
  if (normalized[0]?.source_raw === normalized[1]?.source_raw) {
    errors.push("The two surname components must come from two different character traits.");
  }
  const display = composeSurname(normalized, order, join_style);
  if (surname_display && String(surname_display).toLowerCase() !== display.toLowerCase()) {
    errors.push(`The visible surname must match the two components (${display}).`);
  }
  return { valid: errors.length === 0, errors, components: normalized, surname_display: display };
}

module.exports = {
  ELIGIBLE_SURNAME_TRAITS,
  characterTraitSources,
  cleanComponent,
  composeSurname,
  splitSource,
  validateStructuredSurname,
};
