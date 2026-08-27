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
  const filename = "panic_brownie_cowboy_male_name_bank_2026-08-17.md";
  const file = path.join(process.cwd(), "name_banks", filename);
  if (!fs.existsSync(file)) return [];
  const raw_markdown = fs.readFileSync(file, "utf8");
  const parsed = parseMarkdownNameBank(raw_markdown, { clothing: "Brownie cowboy", gender: "Male", version: "2026-08-17" });
  return [{
    id: idFor(parsed.clothing, parsed.gender, filename),
    filename,
    ...parsed,
    raw_markdown,
    active: true,
    source_kind: "bundled_artist_bank",
    uploaded_at: "2026-08-17T00:00:00.000Z",
  }];
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
