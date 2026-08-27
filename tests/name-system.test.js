const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseMarkdownNameBank } = require("../api/_lib/name-bank-parser");
const { composeSurname, validateStructuredSurname } = require("../api/_lib/name-model");

const character = {
  traits: [
    { type: "Body", value: "Male tea" },
    { type: "Clothing", value: "Brownie cowboy" },
    { type: "Background", value: "Hungry Red" },
    { type: "Front", value: "Baguette" },
    { type: "Mouth", value: "Mad" },
  ],
};

test("bundled cowboy Markdown bank parses 278 unique one-word names", () => {
  const markdown = fs.readFileSync(path.join(__dirname, "..", "name_banks", "panic_brownie_cowboy_male_name_bank_2026-08-17.md"), "utf8");
  const parsed = parseMarkdownNameBank(markdown, { clothing: "Brownie cowboy", gender: "Male" });
  assert.equal(parsed.entries.length, 278);
  assert.equal(new Set(parsed.entries.map((entry) => entry.name.toLowerCase())).size, 278);
  assert.ok(parsed.entries.every((entry) => /^[A-Za-z][A-Za-z'-]{1,23}$/.test(entry.name)));
});

test("lower-second compound renders one collector-visible surname", () => {
  assert.equal(composeSurname([{ order: 1, text: "Red" }, { order: 2, text: "Crust" }]), "Redcrust");
  assert.equal(composeSurname([{ order: 1, text: "Red" }, { order: 2, text: "Crust" }], "21"), "Crustred");
});

test("structured Western surname accepts two exact eligible traits", () => {
  const validation = validateStructuredSurname({
    character,
    components: [
      { text: "Red", source_raw: "Background:Hungry Red" },
      { text: "Crust", source_raw: "Front:Baguette" },
    ],
    surname_display: "Redcrust",
  });
  assert.equal(validation.valid, true);
});

test("structured surname rejects Body, Clothing, duplicate routes, and display drift", () => {
  const validation = validateStructuredSurname({
    character,
    components: [
      { text: "Tea", source_raw: "Body:Male tea" },
      { text: "Tea", source_raw: "Body:Male tea" },
    ],
    surname_display: "Teacrust",
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("cannot use Body")));
  assert.ok(validation.errors.some((error) => error.includes("different")));
  assert.ok(validation.errors.some((error) => error.includes("visible surname")));
});

test("UI contains the copy toolbar, repair editor, assistant, and bank upload controls", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  for (const id of ["copyTraitsButton", "copyImageButton", "copyPacketButton", "askAiButton", "surnameRepairBanner", "fullNameEditSource1", "fullNameEditSource2", "namingAssistantDialog", "nameBankFile"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});
