const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseMarkdownNameBank } = require("../api/_lib/name-bank-parser");
const { composeSurname, validateStructuredSurname } = require("../api/_lib/name-model");
const { repairCandidates, shouldOfferRepair } = require("../api/_lib/surname-repair");

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

test("overlap-one compound keeps one shared seam letter", () => {
  assert.equal(
    composeSurname(
      [{ order: 1, text: "Dandel" }, { order: 2, text: "Light" }],
      "12",
      "overlap_one"
    ),
    "Dandelight"
  );
});

test("collapsed greenlit Gingerwine recovers Ginger and Wine from exact character traits", () => {
  const review = require("../review_data.json");
  const angela = review.characters.find((item) => String(item.id) === "667");
  const record = {
    parts: {
      surname_part_1: {
        decision: "approve",
        replacement_value: "Gingerwine",
        replacement_trait_source: "Hair:Ginger dreads bun",
        replacement_language: "western",
      },
      surname_part_2: { disabled: true },
    },
  };
  const cloud = { curation: { records: { "667": record } } };
  assert.equal(shouldOfferRepair(angela, record, cloud), true);
  const [proposal] = repairCandidates(angela, record, cloud);
  assert.equal(proposal.surname_display, "Gingerwine");
  assert.deepEqual(
    proposal.surname_components.map((part) => [part.text, part.source_raw]),
    [
      ["Ginger", "Hair:Ginger dreads bun"],
      ["Wine", "Front:Red wine"],
    ]
  );
});

test("damaged Gingerwine plus Gleam state is corrected instead of accepting a third fragment", () => {
  const review = require("../review_data.json");
  const angela = review.characters.find((item) => String(item.id) === "667");
  const record = {
    parts: {
      surname_part_1: { decision: "approve", replacement_value: "Gingerwine", replacement_language: "western" },
      surname_part_2: { decision: "replace", replacement_value: "Gleam", replacement_language: "western" },
    },
  };
  const cloud = { curation: { records: { "667": record } } };
  const [proposal] = repairCandidates(angela, record, cloud);
  assert.equal(proposal.current_display, "Gingerwinegleam");
  assert.equal(proposal.surname_display, "Gingerwine");
  assert.equal(proposal.corrects_current_display, true);
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

test("UI contains copy, ChatGPT handoff, repair, assistant, and bank controls", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  for (const id of ["copyTraitsButton", "copyImageButton", "copyPacketButton", "copyNameBankPromptButton", "chatgptShareButton", "chatgptHandoffDialog", "chatgptNativeShare", "chatgptOpenSavedChat", "chatgptPacketPreview", "askAiButton", "surnameRepairBanner", "fullNamePasteInput", "fullNameDetectButton", "fullNameEditSource1", "fullNameEditSource2", "namingAssistantDialog", "nameBankFile"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test("voice and paid AI entry points are paused without deleting their implementation", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "review", "styles.css"), "utf8");
  assert.match(html, /voice-mode-button feature-paused/);
  assert.match(html, /ask-ai-button feature-paused/);
  assert.match(css, /\.feature-paused \{ display: none !important; \}/);
});

test("mobile ChatGPT share is prepared before the user-activation click", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  const start = source.indexOf("async function shareCharacterToChatGpt()");
  const end = source.indexOf("async function copyPacketAndOpenSavedChat()", start);
  const handler = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(handler, /await characterPortraitPngBlob/);
  assert.match(handler, /const shareOperation = navigator\.share/);
  assert.match(handler, /files: \[bundle\.portraitFile\]/);
  assert.match(source, /async function prepareChatGptShareBundle[\s\S]*await characterPortraitPngBlob/);
});

test("saved-chat handoff copies before opening the real conversation URL", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  const start = source.indexOf("async function copyPacketAndOpenSavedChat()");
  const end = source.indexOf("async function copyCharacterImage()", start);
  const handler = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.equal(handler.includes("about:blank"), false);
  assert.ok(handler.indexOf("startClipboardTextWrite") < handler.indexOf("window.open(target"));
  assert.match(handler, /window\.open\(target, "panic-name-studio-chatgpt"\)/);
});

test("ChatGPT handoff rejects shared snapshots and carries a wide rotating workshop", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(source, /\^\\\/\(share\|s\)/);
  assert.match(source, /public Shared conversation link/);
  assert.match(source, /Start with 24–30 ranked one-word first-name choices/);
  assert.match(source, /7 distinct surname family tables with 8–10 options per family \(56–70 total\)/);
  assert.match(source, /SURNAME WORKSHOP ROTATION — PASS/);
  assert.match(source, /nextReviewPacketRotation/);
  assert.match(source, /fetchHandoffFirstNameCandidates/);
  assert.match(source, /LIVE FIRST-NAME SOURCE AUDIT/);
  assert.match(source, /fetchHandoffSurnameRootBanks/);
  assert.match(source, /uploaded Clothing \+ Body MD bank → curated Clothing bank → approved Iconic\/Fun bank/);
  assert.match(source, /LIVE TEAM STYLE REFERENCES — CURRENT SYNCED WEBSITE/);
  assert.match(source, /activeChatGptHandoffPacket\(\)/);
});

test("name-bank research prompt audits Markdown first and produces parseable one-word banks", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(source, /function nameBankGenerationPrompt/);
  assert.match(source, /Audit every matching attached or supplied MD bank before doing online research/);
  assert.match(source, /One word only; letters, apostrophe, or hyphen/);
  assert.match(source, /Do not pad to \$\{target\}/);
  assert.match(source, /\*\*Clothing:\*\* \$\{clothing\}/);
  assert.match(source, /copyNameBankPromptButton\.addEventListener\("click", copyNameBankGenerationPrompt\)/);
});

test("normal replacement suggestions include active team Markdown banks", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "api", "suggestions.js"), "utf8");
  assert.match(source, /getNameBanks/);
  assert.match(source, /uploaded\.active/);
  assert.match(source, /Team Markdown bank/);
  assert.match(source, /unique\(\[\.\.\.uploadedWestern, \.\.\.\(bank\.western \|\| \[\]\)\]\)/);
});
