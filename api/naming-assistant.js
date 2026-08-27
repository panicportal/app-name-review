const fs = require("node:fs");
const path = require("node:path");
const review = require("../review_data.json");
const { requireSession } = require("./_lib/auth");
const { getOrCreateState } = require("./_lib/state");
const { getNameBanks } = require("./_lib/name-banks");
const { characterTraitSources } = require("./_lib/name-model");

const characters = new Map(review.characters.map((character) => [String(character.id), character]));

function liveFirstName(character, state) {
  return state.curation?.records?.[String(character.id)]?.parts?.first?.replacement_value || character.first;
}

function usedFirstNames(state, exceptId) {
  return new Set(review.characters
    .filter((character) => String(character.id) !== String(exceptId))
    .map((character) => liveFirstName(character, state).toLowerCase()));
}

function selectedBankCandidates(banks, character, state) {
  const used = usedFirstNames(state, character.id);
  return banks
    .filter((bank) => bank.active && bank.clothing === character.clothing && bank.gender === character.gender_from_body)
    .flatMap((bank) => bank.entries.map((entry) => ({ ...entry, bank_filename: bank.filename, bank_version: bank.version })))
    .filter((entry) => !used.has(String(entry.name).toLowerCase()))
    .slice(0, 80);
}

function imageData(character) {
  const filename = path.join(process.cwd(), "pfps_webp", `${character.id}.webp`);
  if (!fs.existsSync(filename)) return null;
  return `data:image/webp;base64,${fs.readFileSync(filename).toString("base64")}`;
}

function instructions() {
  return `You are the structured naming workshop inside ?an!c Name Studio.
Return only data matching the supplied JSON schema. Never modify app data.

FIRST NAMES
- Return 10-15 globally unused one-word first names when a compatible Clothing bank is supplied.
- First names must fit Clothing directly, respect Body-derived gender, and never infer race, nationality, or gender from the name or image.
- Prefer strongest bank tiers and direct iconic or historical connection. Do not create aliases or multi-word first names.

WESTERN SURNAMES
- Every surname uses exactly two DIFFERENT eligible character traits: Background, Back, Front, Hair, Eyes, Eyebrows, or Mouth.
- Never use Body or Clothing in the surname.
- Each component must be one English word. The collector-visible surname is one word, with the second component lowercased at the join.
- Use exact or lightly transformed recognizable trait roots. Examples: Hungry Red -> Red, Passion Scarlet -> Passion or Scarlet, Romantic Purple -> Romantic or Purple, Outlook Sky Blue -> Sky or Blue, Sun -> Ray, Hamburger -> Bun, Baguette -> Crust, Grimace -> Wince, Soccer ball -> Kick/Goal/Shot.
- Avoid generic word soup and overused Whorl, Coil, or Trance. Reward short, readable, collectible compounds with clear trait evidence.
- Provide 30-50 genuinely good surname choices grouped across varied trait pairs, not padded weak variants.
- The image may help rank legal traits, but the JSON trait list is the only legal source vocabulary.

FULL NAMES
- Rank 4-6 best combinations. A full name may only use a returned first name and returned surname.
- Explain each choice briefly and include readability and collectability scores out of 10.`;
}

const componentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "trait_category", "trait_value", "source_raw"],
  properties: {
    text: { type: "string" },
    trait_category: { type: "string" },
    trait_value: { type: "string" },
    source_raw: { type: "string" },
  },
};

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "first_names", "surnames", "full_names"],
  properties: {
    summary: { type: "string" },
    first_names: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "source", "tier", "reason", "score"],
        properties: {
          name: { type: "string" }, source: { type: "string" }, tier: { type: "string" },
          reason: { type: "string" }, score: { type: "number" },
        },
      },
    },
    surnames: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["surname", "component_1", "component_2", "reason", "readability", "collectability"],
        properties: {
          surname: { type: "string" }, component_1: componentSchema, component_2: componentSchema,
          reason: { type: "string" }, readability: { type: "number" }, collectability: { type: "number" },
        },
      },
    },
    full_names: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["first_name", "surname", "reason", "readability", "collectability"],
        properties: {
          first_name: { type: "string" }, surname: { type: "string" }, reason: { type: "string" },
          readability: { type: "number" }, collectability: { type: "number" },
        },
      },
    },
  },
};

function outputText(payload) {
  if (payload.output_text) return payload.output_text;
  return (payload.output || []).flatMap((item) => item.content || [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text).join("");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  const configured = Boolean(process.env.OPENAI_API_KEY);
  if (req.method === "GET") {
    return res.status(200).json({ configured, model: configured ? (process.env.OPENAI_NAMING_MODEL || "gpt-5-mini") : null });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!configured) return res.status(503).json({
    error: "AI workshop is not configured. Add OPENAI_API_KEY to the Vercel project; ChatGPT subscriptions and API billing are separate.",
    setup_required: true,
  });
  try {
    const id = String(req.body?.character_id || "");
    const character = characters.get(id);
    if (!character) return res.status(400).json({ error: "Unknown character." });
    const [state, bankState] = await Promise.all([getOrCreateState(), getNameBanks()]);
    const record = state.curation?.records?.[id] || {};
    const traits = character.traits.map((trait) => `${trait.type}:${trait.value}`);
    const candidates = selectedBankCandidates(bankState.banks, character, state);
    const feedback = String(req.body?.feedback || "").slice(0, 300);
    const context = {
      character_id: id,
      current_full_name: `${liveFirstName(character, state)} ${character.surname}`,
      clothing: character.clothing,
      gender_from_body: character.gender_from_body,
      exact_traits: traits,
      eligible_surname_sources: characterTraitSources(character),
      locked: {
        first: record.parts?.first?.decision === "approve",
        surname_part_1: record.parts?.surname_part_1?.decision === "approve",
        surname_part_2: record.parts?.surname_part_2?.decision === "approve",
      },
      clothing_bank_candidates: candidates,
      feedback: feedback || null,
    };
    const content = [{ type: "input_text", text: `Create a naming workshop for this exact record:\n${JSON.stringify(context)}` }];
    const image = imageData(character);
    if (image) content.push({ type: "input_image", image_url: image, detail: "low" });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_NAMING_MODEL || "gpt-5-mini",
        instructions: instructions(),
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: "panic_naming_workshop", strict: true, schema: responseSchema } },
        max_output_tokens: 9000,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `OpenAI returned HTTP ${response.status}.`);
    const result = JSON.parse(outputText(payload));
    return res.status(200).json({
      response_id: payload.id,
      result,
      bank: candidates.length ? { filename: candidates[0].bank_filename, candidates_sent: candidates.length } : null,
      exact_eligible_sources: characterTraitSources(character),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "The naming workshop could not finish." });
  }
};
