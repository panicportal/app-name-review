const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJson } = require("./store");
const { parseMarkdownNameBank } = require("./name-bank-parser");

const STORE_KEY = "panic:name-review:v12:uploaded-name-banks";

function idFor(clothing, gender, filename) {
  return crypto.createHash("sha256").update(`${clothing}|${gender}|${filename}`.toLowerCase()).digest("hex").slice(0, 16);
}

function bundledBanks() {
  const definitions = [
    { filename: "panic_brownie_cowboy_male_name_bank_2026-08-17.md", clothing: "Brownie cowboy", gender: "Male", version: "2026-08-17" },
    { filename: "panic_builder_bull_male_stage2_name_bank_2026-09-12.md", clothing: "Builder bull", gender: "Male", version: "2026-09-12" },
    { filename: "panic_builder_bull_male_stage2_followup_2026-09-12.md", clothing: "Builder bull", gender: "Male", version: "2026-09-12" },
    { filename: "panic_common_villager_male_rpg_name_bank_2026-09-12.md", clothing: "Common villager", gender: "Male", version: "2026-09-12" },
    { filename: "panic_dark_swim_trunks_male_stage2_swimmer_surnames_2026-09-12.md", clothing: "Dark swim trunks", gender: "Male", version: "2026-09-12" },
    { filename: "panic_defiant_pirate_captain_male_stage2_2026-09-12.md", clothing: "Defiant pirate captain", gender: "Male", version: "2026-09-12" },
    { filename: "panic_divine_saint_male_stage2_2026-09-12.md", clothing: "Divine saint", gender: "Male", version: "2026-09-12" },
    { filename: "panic_dark_swim_trunks_male_stage2_followup_2026-09-12.md", clothing: "Dark swim trunks", gender: "Male", version: "2026-09-12" },
    { filename: "panic_divine_saint_male_stage2_followup_2026-09-12.md", clothing: "Divine saint", gender: "Male", version: "2026-09-12" },
    { filename: "panic_drifting_painter_male_stage2_2026-09-12.md", clothing: "Drifting painter", gender: "Male", version: "2026-09-12" },
    { filename: "panic_everyday_villager_female_stage2_2026-09-12.md", clothing: "Everyday villager", gender: "Female", version: "2026-09-12" },
    { filename: "panic_golden_angel_male_stage2_2026-09-12.md", clothing: "Golden angel", gender: "Male", version: "2026-09-12" },
    { filename: "panic_everyday_villager_female_stage2_followup_2026-09-12.md", clothing: "Everyday villager", gender: "Female", version: "2026-09-12" },
    { filename: "panic_dark_swim_trunks_male_stage2_followup_2_2026-09-12.md", clothing: "Dark swim trunks", gender: "Male", version: "2026-09-12" },
    { filename: "panic_golden_angel_male_stage2_followup_2026-09-12.md", clothing: "Golden angel", gender: "Male", version: "2026-09-12" },
    { filename: "panic_drifting_painter_male_stage2_followup_2026-09-12.md", clothing: "Drifting painter", gender: "Male", version: "2026-09-12" },
    { filename: "panic_divine_saint_male_stage2_followup_2_2026-09-12.md", clothing: "Divine saint", gender: "Male", version: "2026-09-12" },
    { filename: "panic_grasping_devil_male_stage2_2026-09-12.md", clothing: "Grasping devil", gender: "Male", version: "2026-09-12" },
    { filename: "panic_ham_sandwich_clown_female_stage2_2026-09-12.md", clothing: "Ham sandwich clown", gender: "Female", version: "2026-09-12" },
    { filename: "panic_kawaii_kimono_female_stage2_2026-09-12.md", clothing: "Kawaii kimono", gender: "Female", version: "2026-09-12" },
    { filename: "panic_golden_angel_male_stage2_followup_2_2026-09-12.md", clothing: "Golden angel", gender: "Male", version: "2026-09-12" },
    { filename: "panic_ham_sandwich_clown_female_stage2_followup_2_2026-09-12.md", clothing: "Ham sandwich clown", gender: "Female", version: "2026-09-12" },
    { filename: "panic_grasping_devil_male_stage2_followup_2_2026-09-12.md", clothing: "Grasping devil", gender: "Male", version: "2026-09-12" },
    { filename: "panic_kawaii_kimono_female_stage2_followup_2_2026-09-12.md", clothing: "Kawaii kimono", gender: "Female", version: "2026-09-12" },
    { filename: "panic_love_disciple_male_stage2_2026-09-12.md", clothing: "Love disciple", gender: "Male", version: "2026-09-12" },
    { filename: "panic_mysterious_disciple_female_stage2_2026-09-12.md", clothing: "Mysterious disciple", gender: "Female", version: "2026-09-12" },
    { filename: "panic_observer_angel_female_stage2_2026-09-12.md", clothing: "Observer angel", gender: "Female", version: "2026-09-12" },
    { filename: "panic_ham_sandwich_clown_female_stage2_followup_3_2026-09-12.md", clothing: "Ham sandwich clown", gender: "Female", version: "2026-09-12" },
    { filename: "panic_kawaii_kimono_female_western_stage2_followup_3_2026-09-12.md", clothing: "Kawaii kimono", gender: "Female", version: "2026-09-12" },
    { filename: "panic_observer_angel_female_angelic_stage2_followup_3_2026-09-12.md", clothing: "Observer angel", gender: "Female", version: "2026-09-12" },
    { filename: "panic_polished_suit_male_stage2_2026-09-12.md", clothing: "Polished suit", gender: "Male", version: "2026-09-12" },
    { filename: "panic_restless_ape_male_stage2_2026-09-12.md", clothing: "Restless ape", gender: "Male", version: "2026-09-12" },
    { filename: "panic_rogue_pirate_captain_female_stage2_2026-09-12.md", clothing: "Rogue pirate captain", gender: "Female", version: "2026-09-12" },
    { filename: "panic_polished_suit_male_stage2_followup_2_2026-09-12.md", clothing: "Polished suit", gender: "Male", version: "2026-09-12" },
    { filename: "panic_restless_ape_male_stage2_followup_2_2026-09-12.md", clothing: "Restless ape", gender: "Male", version: "2026-09-12" },
    { filename: "panic_rogue_pirate_captain_female_stage2_followup_2_2026-09-12.md", clothing: "Rogue pirate captain", gender: "Female", version: "2026-09-12" },
    { filename: "panic_observer_angel_female_screen_stage2_followup_4_2026-09-12.md", clothing: "Observer angel", gender: "Female", version: "2026-09-12" },
    { filename: "panic_shiba_dog_male_stage2_2026-09-12.md", clothing: "Shiba dog", gender: "Male", version: "2026-09-12" },
    { filename: "panic_simple_swimsuit_female_stage2_2026-09-12.md", clothing: "Simple swimsuit", gender: "Female", version: "2026-09-12" },
    { filename: "panic_spicy_devil_female_stage2_2026-09-12.md", clothing: "Spicy devil", gender: "Female", version: "2026-09-12" },
    { filename: "panic_starry_night_clown_male_stage2_2026-09-12.md", clothing: "Starry night clown", gender: "Male", version: "2026-09-12" },
    { filename: "panic_vintage_sweatshirt_female_stage2_2026-09-12.md", clothing: "Vintage sweatshirt", gender: "Female", version: "2026-09-12" },
  ];
  return definitions.flatMap(definition => {
    const file = path.join(process.cwd(), "name_banks", definition.filename);
    if (!fs.existsSync(file)) return [];
    const raw_markdown = fs.readFileSync(file, "utf8");
    const parsed = parseMarkdownNameBank(raw_markdown, definition);
    return [{
      id: idFor(parsed.clothing, parsed.gender, definition.filename),
      filename: definition.filename,
      ...parsed,
      raw_markdown,
      active: true,
      source_kind: "bundled_artist_bank",
      uploaded_at: `${definition.version}T00:00:00.000Z`,
    }];
  });
}

async function getNameBanks() {
  const stored = await readJson(STORE_KEY).catch(() => null);
  const uploaded = Array.isArray(stored?.banks) ? stored.banks : [];
  const byId = new Map(bundledBanks().map((bank) => [bank.id, bank]));
  uploaded.forEach((bank) => byId.set(bank.id, bank));
  return { schema_version: "panic-name-banks/v1", banks: [...byId.values()] };
}

async function saveNameBank(input, actor) {
  const raw_markdown = String(input.raw_markdown || "");
  if (!raw_markdown || raw_markdown.length > 1_500_000) throw new Error("The Markdown bank must be between 1 byte and 1.5 MB.");
  const clothing = String(input.clothing || "").trim();
  const gender = String(input.gender || "").trim();
  const filename = String(input.filename || "uploaded-name-bank.md").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!clothing || !["Male", "Female"].includes(gender)) throw new Error("Clothing and Body-gender route are required.");
  const parsed = parseMarkdownNameBank(raw_markdown, { clothing, gender, version: input.version });
  if (!parsed.entries.length) throw new Error("No one-word name entries were found in the Markdown tables.");
  const current = await readJson(STORE_KEY).catch(() => null) || { schema_version: "panic-name-banks/v1", banks: [] };
  const id = idFor(clothing, gender, filename);
  const bank = {
    id,
    filename,
    clothing,
    gender,
    version: String(input.version || parsed.version || new Date().toISOString().slice(0, 10)),
    raw_markdown,
    entries: parsed.entries,
    active: input.active !== false,
    source_kind: "uploaded_team_bank",
    uploaded_at: new Date().toISOString(),
    uploaded_by: actor,
  };
  current.banks = [...(current.banks || []).filter((item) => item.id !== id), bank];
  await writeJson(STORE_KEY, current);
  return bank;
}

module.exports = { getNameBanks, saveNameBank };
