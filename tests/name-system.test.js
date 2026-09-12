const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseMarkdownNameBank } = require("../api/_lib/name-bank-parser");
const { composeSurname, validateStructuredSurname } = require("../api/_lib/name-model");
const { repairCandidates, safeAutomaticRepair, shouldOfferRepair } = require("../api/_lib/surname-repair");
const { auditOriginMismatches, characters, detectFirstOrigin, detectSurnameOrigin } = require("../api/_lib/name-origin");

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

test("mobile portraits use immutable caching, a loading state, and adjacent preloading", () => {
  const vercel = fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "review", "styles.css"), "utf8");
  assert.match(vercel, /"source": "\/pfps_webp\/\(\.\*\)"/);
  assert.match(vercel, /max-age=31536000, immutable/);
  assert.match(source, /function warmPortrait\(src\)/);
  assert.match(source, /function preloadPortraitNeighbors\(character\)/);
  assert.match(source, /\[-1, 1\]\.forEach/);
  assert.match(source, /dataset\.requestedPortrait/);
  assert.match(styles, /\.portrait-frame\.portrait-loading::after/);
});

test("Stage 2 prepared first names remain included in reviewed progress", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(source, /first\.workflow_stage === "first_names_stage_2"/);
  assert.match(source, /const reviewedParts = decidedParts \+ stage2ReadyParts/);
  assert.match(source, /Stage 2 ready/);
  assert.match(source, /stage2ConfirmedParts/);
  assert.match(source, /els\.statusFilter\.value === "first-stage-2"/);
  assert.match(source, /Stage 2 confirmed/);
});

test("unmarked Stage 2 replacement is limited to the two explicitly authorized clothing traits", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply_stage2_first_names.js"), "utf8");
  assert.match(source, /plan\.include_unmarked_first_names/);
  assert.match(source, /\["Restless ape", "Rogue pirate captain"\]/);
  assert.match(source, /already greenlit and cannot be replaced/);
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

test("surname recovery prefers a literal exact trait over a broad semantic association", () => {
  const literalCharacter = {
    id: "2796",
    surname: "Ickycloud",
    surname_language: "western",
    traits: [
      { type: "Background", value: "Outlook Sky Blue" },
      { type: "Mouth", value: "Grimace" },
      { type: "Back", value: "White cloud" },
    ],
  };
  const record = {
    parts: {
      surname_part_1: { decision: "approve", replacement_value: "Ickycloud", replacement_language: "western" },
      surname_part_2: { decision: "replace", disabled: true },
    },
  };
  const cloud = { curation: { records: { "2796": record } } };
  const proposals = repairCandidates(literalCharacter, record, cloud);
  assert.equal(proposals[0].surname_components[1].source_raw, "Back:White cloud");
  assert.equal(safeAutomaticRepair(proposals).safe, true);
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
  for (const id of ["copyTraitsButton", "copyImageButton", "copyCompactPacketButton", "copyPacketButton", "copyNameBankPromptButton", "chatgptShareButton", "chatgptHandoffDialog", "chatgptNativeShare", "chatgptOpenSavedChat", "chatgptPacketPreview", "askAiButton", "surnameRepairBanner", "fullNamePasteInput", "fullNameDetectButton", "fullNameEditFirstOrigin", "fullNameEditSurnameOrigin", "fullNameEditJapaneseSource", "fullNameEditLockedSurnamePanel", "fullNameEditConfirmLockedSurname", "fullNameEditSource1", "fullNameEditSource2", "namingAssistantDialog", "nameBankFile"]) {
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

test("compact review packet uses 30 bank names and diverse surname roots without browsing", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(html, /id="copyCompactPacketButton"/);
  assert.match(source, /function compactChatGptHandoffText/);
  assert.match(source, /Maximum final response: 1,300 words/);
  assert.match(source, /exactly \$\{surnameFamilyCount\} family tables with exactly 6 options each \(\$\{surnameOptionCount\} total\)/);
  assert.match(source, /INLINE FIRST-NAME BANK RULE/);
  assert.match(source, /Every offered first name must be copied exactly from an EXACT INLINE ROW/);
  assert.match(source, /Curated, Iconic\/Fun, ordinary-name, memory-based, and invented fallbacks are forbidden/);
  assert.match(source, /Never answer “MD BANK UNAVAILABLE” when any EXACT INLINE ROWS appear below/);
  assert.match(source, /FIRST-NAME MD FILE: \$\{uploadedFirstFiles\.join\(", "\)\}/);
  assert.match(source, /Copy the filename exactly so the artist can verify which file was used/);
  assert.match(source, /Never claim an MD filename when Name Studio did not embed one/);
  assert.match(source, /VERIFIED LOCAL BANK FALLBACK EMBEDDED BY NAME STUDIO/);
  assert.match(source, /const candidates = \(mdCandidates\.length \? mdCandidates : allCandidates\)\.slice\(0, 30\)/);
  assert.match(source, /uploaded MD, curated Clothing, or approved Iconic\/Fun/);
  assert.match(source, /Preserve \$\{effectivePartValue\(character, "first"\)/);
  const compactCopyStart = source.indexOf("async function copyCompactReviewPacket");
  const compactCopyEnd = source.indexOf("function bindEvents", compactCopyStart);
  const compactCopyHandler = source.slice(compactCopyStart, compactCopyEnd);
  assert.doesNotMatch(compactCopyHandler, /openNameBanks\(/);
  assert.doesNotMatch(compactCopyHandler, /return;\s*\}/);
  assert.match(compactCopyHandler, /await copyText\(/);
  assert.match(source, /candidate\.origin === "Uploaded MD bank"/);
  assert.match(source, /slice\(0, 30\)/);
  assert.match(source, /slice\(0, 8\)/);
  assert.match(source, /PORTRAIT-FIRST FIT/);
  assert.match(source, /no component root may appear more than \$\{surnamePlanDetails\.rootReuseCap\} times/);
  assert.match(source, /at least 3 different roots from EACH route/);
  assert.match(source, /Never create six variations by holding one word fixed/);
  assert.match(source, /FIRST-NAME ROTATION/);
  assert.match(source, /const characterRotation = rotationPass \+ \(Number\.parseInt\(String\(character\.id\), 10\) \|\| 0\)/);
  assert.match(source, /alternate attack: \$\{item\.secondaryAttack\}/);
  assert.match(source, /BALANCED SURNAME FAMILIES/);
  assert.match(source, /ROUTE-LOAD CHECK — PASSED/);
  assert.match(source, /Use every capacity-checked trait-route pairing listed below exactly once/);
  assert.match(source, /copyCompactPacketButton\.addEventListener\("click", copyCompactReviewPacket\)/);
});

test("name-bank research prompt audits Markdown first and produces parseable one-word banks", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(source, /function nameBankGenerationPrompt/);
  assert.match(source, /NAME STUDIO MD AUDIT — ALREADY COMPLETED/);
  assert.match(source, /do not search the file library again; begin online discovery/);
  assert.match(source, /Never stop after saying that you searched files or name libraries/);
  assert.match(source, /A response that lacks candidate rows is incomplete and must not be sent/);
  assert.match(source, /DOWNLOADABLE FILE — REQUIRED DELIVERABLE/);
  assert.match(source, /Create a real UTF-8 Markdown file named exactly/);
  assert.match(source, /Do not use a rendered Markdown chat message as the primary deliverable/);
  assert.match(source, /reopen or read the saved file and verify that it is non-empty/);
  assert.match(source, /panic_\$\{fileSlug\}_name_bank_\$\{versionDate\}\.md/);
  assert.doesNotMatch(source.slice(source.indexOf("function nameBankGenerationPrompt"), source.indexOf("async function copyNameBankGenerationPrompt")), /toISOString/);
  assert.match(source, /One word only; letters, apostrophe, or hyphen/);
  assert.match(source, /Do not pad to \$\{target\}/);
  assert.match(source, /\*\*Clothing:\*\* \$\{clothing\}/);
  assert.match(source, /copyNameBankPromptButton\.addEventListener\("click", copyNameBankGenerationPrompt\)/);
});

test("collection search indexes live replacements and individual surname components", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(source, /effectiveDisplayName\(character\)/);
  assert.match(source, /effectivePartValue\(character, "surname_part_1"\)/);
  assert.match(source, /effectivePartValue\(character, "surname_part_2"\)/);
  assert.match(source, /function normalizeSearchText/);
  assert.match(source, /tokens\.every\(token => index\.includes\(token\)\)/);
});

test("confirm all force-approves every active part without discarding pasted values", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(html, /id="confirmAllButton"/);
  assert.match(html, /id="mobileConfirmAll"/);
  const start = source.indexOf("function confirmAll()");
  const end = source.indexOf("function approveRemainingAndNext()", start);
  const handler = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /const current = partReview/);
  assert.match(handler, /\.\.\.current/);
  assert.match(handler, /decision: "approve"/);
  assert.match(handler, /scope: null/);
  assert.doesNotMatch(handler, /blankPart\(\)/);
  assert.match(source, /mobileConfirmAll\.addEventListener\("click", confirmAll\)/);

  const records = {
    "667": { parts: {
      first: { decision: "replace", replacement_value: "Angela" },
      surname_part_1: { decision: "replace", replacement_value: "Ginger" },
      surname_part_2: { decision: "replace", replacement_value: "Wine" }
    } },
    "668": { parts: { first: { decision: "replace", replacement_value: "Untouched" } } }
  };
  const selected = { id: "667" };
  const definitions = [
    { key: "first", label: "First name", available: true },
    { key: "surname_part_1", label: "Surname part 1", available: true },
    { key: "surname_part_2", label: "Surname part 2", available: true }
  ];
  const makeConfirmAll = new Function(
    "state", "ensureRecord", "nowIso", "partDefinitions", "partReview",
    "saveCuration", "renderCharacter", "updateProgress", "renderRoster", "showToast",
    `${handler}; return confirmAll;`
  );
  const confirmAll = makeConfirmAll(
    { selected, curation: { reviewer: "Team" } },
    id => records[id],
    () => "2026-08-29T00:00:00.000Z",
    () => definitions,
    (id, key) => records[id].parts[key],
    () => {}, () => {}, () => {}, () => {}, () => {}
  );
  confirmAll();
  assert.deepEqual(
    Object.fromEntries(Object.entries(records["667"].parts).map(([key, part]) => [key, [part.decision, part.replacement_value]])),
    {
      first: ["approve", "Angela"],
      surname_part_1: ["approve", "Ginger"],
      surname_part_2: ["approve", "Wine"]
    }
  );
  assert.equal(records["668"].parts.first.decision, "replace");
});

test("portrait shortcuts decide only the first name through the shared decision path", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(html, /id="quickLockFirstButton"[^>]+data-part="first"[^>]+data-decision="approve"/);
  assert.match(html, /id="quickReplaceFirstButton"[^>]+data-part="first"[^>]+data-decision="replace"/);
  assert.match(html, /aria-label="First name decision shortcuts"/);
  assert.match(html, /app\.js\?v=32-0-stage2-confirmed-progress/);
  assert.match(source, /quickLockFirstButton\.disabled = !firstAvailable \|\| firstDecision === "approve"/);
  assert.match(source, /quickReplaceFirstButton\.disabled = !firstAvailable \|\| firstDecision === "replace"/);
});

test("Stage 2 first-name replacements are filterable, auditable, and sourced from the cowboy bank", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "stage2_plans", "brownie-cowboy-2026-09-12.json"), "utf8"));
  const bank = fs.readFileSync(path.join(__dirname, "..", "name_banks", "panic_brownie_cowboy_male_name_bank_2026-08-17.md"), "utf8");
  assert.match(html, /value="first-stage-2">First names stage 2/);
  assert.match(source, /workflow_stage === "first_names_stage_2"/);
  assert.match(source, /!\["approve", "lock"\]\.includes\(first\.decision\)/);
  assert.match(source, /workflow_reference: review\.workflow_reference/);
  assert.equal(plan.clothing, "Brownie cowboy");
  assert.equal(plan.replacements.length, 17);
  assert.equal(new Set(plan.replacements.map(item => item.id)).size, 17);
  assert.equal(new Set(plan.replacements.map(item => item.replacement.toLowerCase())).size, 17);
  for (const item of plan.replacements) {
    assert.match(bank, new RegExp(`\\| \\*\\*${item.replacement}\\*\\* \\|`));
    assert.ok(item.reference.length > 8);
    assert.ok(item.fit.length > 20);
  }
});

test("Stage 2 bull and RPG-villager plans replace every target from exact bundled banks", () => {
  const cases = [
    ["builder-bull-remaining-2026-09-12.json", "panic_builder_bull_male_stage2_name_bank_2026-09-12.md", 43],
    ["common-villager-2026-09-12.json", "panic_common_villager_male_rpg_name_bank_2026-09-12.md", 39],
    ["drifting-painter-2026-09-12.json", "panic_drifting_painter_male_stage2_2026-09-12.md", 67],
    ["everyday-villager-female-2026-09-12.json", "panic_everyday_villager_female_stage2_2026-09-12.md", 43],
    ["golden-angel-2026-09-12.json", "panic_golden_angel_male_stage2_2026-09-12.md", 3],
    ["drifting-painter-reference-correction-2026-09-12.json", "panic_drifting_painter_male_stage2_2026-09-12.md", 2],
    ["everyday-villager-female-followup-2026-09-12.json", "panic_everyday_villager_female_stage2_followup_2026-09-12.md", 4],
    ["golden-angel-male-followup-2026-09-12.json", "panic_golden_angel_male_stage2_followup_2026-09-12.md", 1],
    ["drifting-painter-male-followup-2026-09-12.json", "panic_drifting_painter_male_stage2_followup_2026-09-12.md", 6],
    ["grasping-devil-male-2026-09-12.json", "panic_grasping_devil_male_stage2_2026-09-12.md", 32],
    ["ham-sandwich-clown-female-2026-09-12.json", "panic_ham_sandwich_clown_female_stage2_2026-09-12.md", 38],
    ["kawaii-kimono-female-2026-09-12.json", "panic_kawaii_kimono_female_stage2_2026-09-12.md", 13],
    ["love-disciple-male-2026-09-12.json", "panic_love_disciple_male_stage2_2026-09-12.md", 15],
    ["mysterious-disciple-female-2026-09-12.json", "panic_mysterious_disciple_female_stage2_2026-09-12.md", 13],
    ["observer-angel-female-2026-09-12.json", "panic_observer_angel_female_stage2_2026-09-12.md", 77],
    ["polished-suit-male-2026-09-12.json", "panic_polished_suit_male_stage2_2026-09-12.md", 54],
    ["restless-ape-male-2026-09-12.json", "panic_restless_ape_male_stage2_2026-09-12.md", 52],
    ["rogue-pirate-captain-female-2026-09-12.json", "panic_rogue_pirate_captain_female_stage2_2026-09-12.md", 35],
  ];
  for (const [planFile, bankFile, expectedCount] of cases) {
    const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "stage2_plans", planFile), "utf8"));
    const markdown = fs.readFileSync(path.join(__dirname, "..", "name_banks", bankFile), "utf8");
    const parsed = parseMarkdownNameBank(markdown, { clothing: plan.clothing, gender: plan.gender });
    const bankNames = new Set(parsed.entries.map(entry => entry.name));
    assert.equal(plan.replacements.length, expectedCount);
    assert.equal(new Set(plan.replacements.map(item => item.id)).size, expectedCount);
    assert.equal(new Set(plan.replacements.map(item => item.replacement.toLowerCase())).size, expectedCount);
    assert.ok(plan.replacements.every(item => item.expected_first.toLowerCase() !== item.replacement.toLowerCase()));
    assert.ok(plan.replacements.every(item => bankNames.has(item.replacement)));
  }
});

test("Stage 2 swimmer, bull follow-up, pirate, and saint plans use exact short source-bank names", () => {
  const cases = [
    ["builder-bull-followup-2026-09-12.json", "panic_builder_bull_male_stage2_followup_2026-09-12.md", 2],
    ["dark-swim-trunks-2026-09-12.json", "panic_dark_swim_trunks_male_stage2_swimmer_surnames_2026-09-12.md", 117],
    ["dark-swim-trunks-male-correction-2026-09-12.json", "panic_dark_swim_trunks_male_stage2_swimmer_surnames_2026-09-12.md", 36],
    ["dark-swim-trunks-followup-2026-09-12.json", "panic_dark_swim_trunks_male_stage2_followup_2026-09-12.md", 9],
    ["defiant-pirate-captain-2026-09-12.json", "panic_defiant_pirate_captain_male_stage2_2026-09-12.md", 1],
    ["divine-saint-2026-09-12.json", "panic_divine_saint_male_stage2_2026-09-12.md", 6],
    ["divine-saint-followup-2026-09-12.json", "panic_divine_saint_male_stage2_followup_2026-09-12.md", 2],
    ["dark-swim-trunks-male-followup-2-2026-09-12.json", "panic_dark_swim_trunks_male_stage2_followup_2_2026-09-12.md", 1],
    ["divine-saint-male-followup-2-2026-09-12.json", "panic_divine_saint_male_stage2_followup_2_2026-09-12.md", 1],
    ["golden-angel-followup-2-2026-09-12.json", "panic_golden_angel_male_stage2_followup_2_2026-09-12.md", 1],
    ["ham-sandwich-clown-followup-2-2026-09-12.json", "panic_ham_sandwich_clown_female_stage2_followup_2_2026-09-12.md", 2],
    ["grasping-devil-followup-2-2026-09-12.json", "panic_grasping_devil_male_stage2_followup_2_2026-09-12.md", 5],
    ["kawaii-kimono-followup-2-2026-09-12.json", "panic_kawaii_kimono_female_stage2_followup_2_2026-09-12.md", 5],
    ["ham-sandwich-clown-followup-3-2026-09-12.json", "panic_ham_sandwich_clown_female_stage2_followup_3_2026-09-12.md", 1],
    ["kawaii-kimono-western-followup-3-2026-09-12.json", "panic_kawaii_kimono_female_western_stage2_followup_3_2026-09-12.md", 5],
    ["observer-angel-angelic-followup-3-2026-09-12.json", "panic_observer_angel_female_angelic_stage2_followup_3_2026-09-12.md", 11],
  ];
  for (const [planFile, bankFile, expectedCount] of cases) {
    const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "stage2_plans", planFile), "utf8"));
    const markdown = fs.readFileSync(path.join(__dirname, "..", "name_banks", bankFile), "utf8");
    const parsed = parseMarkdownNameBank(markdown, { clothing: plan.clothing, gender: plan.gender });
    const bankNames = new Set(parsed.entries.map(entry => entry.name));
    assert.equal(plan.replacements.length, expectedCount);
    assert.equal(new Set(plan.replacements.map(item => item.id)).size, expectedCount);
    assert.equal(new Set(plan.replacements.map(item => item.replacement.toLowerCase())).size, expectedCount);
    assert.ok(plan.replacements.every(item => item.expected_first.toLowerCase() !== item.replacement.toLowerCase()));
    assert.ok(plan.replacements.every(item => item.replacement.length <= 10));
    assert.ok(plan.replacements.every(item => bankNames.has(item.replacement)));
    assert.ok(plan.replacements.every(item => item.reference.length > 8 && item.fit.length > 40));
  }
  const maleSwimmerBank = fs.readFileSync(
    path.join(__dirname, "..", "name_banks", "panic_dark_swim_trunks_male_stage2_swimmer_surnames_2026-09-12.md"),
    "utf8",
  );
  const removedFemaleReferences = ["McKeon", "Titmus", "Fraser", "Campbell", "Sjostrom", "Hosszu", "Pellegrini", "Seebohm", "Rice", "McIntosh", "Huske", "Walsh", "Douglass", "King", "Bacon", "Curzan", "Zhang", "Yang", "Evans", "Thompson", "Torres", "Beard", "Vollmer", "Soni", "Hardy", "Hoff", "Leverenz", "Dirado", "Egerszegi", "Otto", "Ender", "Cunha", "Zorn", "Hess", "Ederle", "Gould"];
  assert.ok(removedFemaleReferences.every(name => !new RegExp(`^\\| ${name} \\|`, "m").test(maleSwimmerBank)));
});

test("an explicit Stage 2 bank correction can replace decided names without opening a no-op path", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply_stage2_first_names.js"), "utf8");
  assert.match(source, /if \(plan\.correct_existing_stage2\)/);
  assert.match(source, /first\?\.workflow_stage !== "first_names_stage_2"/);
  assert.match(source, /if \(!plan\.correction_reason\)/);
  assert.match(source, /replacementKey === current\.trim\(\)\.toLowerCase\(\)/);
});

test("Stage 2 can initialize untouched records for explicitly authorized unmarked batches", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply_stage2_first_names.js"), "utf8");
  assert.match(source, /function ensureRecord\(state, id\)/);
  assert.match(source, /const record = ensureRecord\(next, id\)/);
  assert.match(source, /const previous = record\.parts\.first \|\| \{\}/);
});

test("bank-origin detector uses exact eligible routes instead of name appearance", () => {
  const kotoha = detectFirstOrigin(characters.get("41"), "Kotoha");
  assert.equal(kotoha.origin, "japanese");
  assert.equal(kotoha.best_match.route, "Clothing:Vintage sweatshirt");
  const yui = detectFirstOrigin(characters.get("182"), "Yui");
  assert.equal(yui.origin, "ambiguous");
  const daichi = detectFirstOrigin(characters.get("6"), "Daichi");
  assert.equal(daichi.origin, "unknown");
  assert.equal(daichi.evidence, "japanese_name_not_eligible_for_character_route");

  const fireCharacter = { traits: [{ type: "Back", value: "Fire" }] };
  assert.equal(detectSurnameOrigin(fireCharacter, "Shiranui", "Back:Fire").origin, "japanese");
  assert.equal(detectSurnameOrigin(fireCharacter, "Blaze", "Back:Fire").origin, "western");
});

test("origin audit corrects provenance only for unambiguous replacement-bank mismatches", () => {
  const state = {
    curation: { records: {
      "41": { parts: { first: { decision: "approve", replacement_value: "Kotoha", replacement_language: "western" } } },
      "182": { parts: { first: { decision: "approve", replacement_value: "Yui", replacement_language: "japanese" } } },
    } }
  };
  const audit = auditOriginMismatches(state);
  assert.deepEqual(audit.corrections.map((row) => [row.character_id, row.detected_origin]), [["41", "japanese"]]);
  assert.equal(audit.ambiguous.some((row) => row.character_id === "182"), true);
  assert.equal(state.curation.records["41"].parts.first.decision, "approve");
});

test("origin audit never reverses an explicit artist-custom Japanese origin", () => {
  const state = {
    curation: { records: {
      "182": { parts: { first: {
        decision: "approve",
        replacement_value: "Yui",
        replacement_language: "japanese",
        replacement_origin_kind: "artist_custom",
      } } },
    } },
  };
  const audit = auditOriginMismatches(state);
  assert.equal(audit.corrections.length, 0);
  assert.equal(audit.ambiguous.length, 0);
  assert.deepEqual(
    audit.confirmedCustom.map((row) => [row.character_id, row.value, row.evidence]),
    [["182", "Yui", "explicit_artist_custom_origin"]]
  );
});

test("manual origin selection supports exact and custom Japanese names without resetting", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  const endpoint = fs.readFileSync(path.join(__dirname, "..", "api", "name-origin.js"), "utf8");
  assert.match(html, /value="japanese">Japanese — exact bank or artist custom/);
  assert.match(html, /value="japanese">Japanese — 1 atomic surname/);
  assert.match(html, /app\.js\?v=32-0-stage2-confirmed-progress/);
  assert.match(source, /async function detectManualNameOrigin/);
  assert.match(source, /detectManualNameOrigin\("first", rawFirst\)/);
  assert.match(source, /detectManualNameOrigin\("surname_atomic", rawSurname\)/);
  assert.match(source, /if \(mode === "japanese"\)/);
  assert.match(source, /mode: match \? "japanese_bank" : "japanese_custom"/);
  assert.match(source, /replacement_language: detectedFirstOrigin/);
  assert.match(source, /replacement_language: "japanese"/);
  assert.match(source, /Artist-entered custom Japanese first name · explicit origin/);
  assert.match(source, /Artist-entered custom Japanese surname · explicit origin/);
  assert.match(source, /replacement_origin_kind: japaneseCustom \? "artist_custom" : "authoritative_bank"/);
  assert.match(source, /custom Japanese surname\. It is stored as one atomic surname/);
  assert.match(source, /could not be classified automatically/);
  assert.match(source, /Confirm the replacement in the editor before converting/);
  assert.match(source, /action: "replace_confirmed_surname"/);
  assert.match(source, /selected_trait_source: parsed\.japanese_source \|\| null/);
  assert.match(source, /if \(els\.fullNameEditSurnameOrigin\.value === "auto"\)/);
  assert.doesNotMatch(source, /fullNameEditSurnameOrigin\.value !== "japanese_custom"/);
  assert.match(source, /decision: replacingLockedSurname \? null : current2\.decision/);
  assert.match(source, /if \(state\.cloudAuthenticated\) void pushCloudState\(\)/);
  assert.match(endpoint, /stateDecisionSignature\(next\) !== beforeSignature/);
  assert.match(endpoint, /compareAndSwapState\(expectedRevision, next\)/);
});

test("name evidence bank markers open the matching editable bank selector", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "review", "index.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(html, /class="bank-assignment-button" id="firstLanguage"/);
  assert.match(html, /class="bank-assignment-button" id="surnameLanguage"/);
  assert.match(source, /firstLanguage\.addEventListener\("click", \(\) => openFullNameEditor\(\{ focusOrigin: "first" \}\)\)/);
  assert.match(source, /surnameLanguage\.addEventListener\("click", \(\) => openFullNameEditor\(\{ focusOrigin: "surname" \}\)\)/);
  assert.match(source, /originSelect\.scrollIntoView\(\{ block: "center" \}\)/);
  assert.match(source, /originSelect\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /Current bank: \$\{els\.firstLanguage\.textContent\}/);
});

test("review packet prioritizes rare routes and requires visible literal trait evidence", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "review", "app.js"), "utf8");
  assert.match(source, /RARE TRAITS FIRST/);
  assert.match(source, /LITERAL TRAIT RULE/);
  assert.match(source, /Exact trait wording/);
  assert.match(source, /same component root more than four times/);
  assert.match(source, /LIVE TEAM STYLE REFERENCES — CURRENT SYNCED WEBSITE/);
});

test("automatic repair endpoint uses revision-checked atomic storage", () => {
  const endpoint = fs.readFileSync(path.join(__dirname, "..", "api", "surname-repair.js"), "utf8");
  const store = fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "store.js"), "utf8");
  assert.match(endpoint, /mode !== "apply_confirmed"/);
  assert.match(endpoint, /compareAndSwapState\(expectedRevision, next\)/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "repair-application.js"), "utf8"), /visible_surname_would_change/);
  assert.match(store, /async function compareAndSwapState/);
  assert.match(store, /decoded\.revision/);
});

test("normal replacement suggestions include active team Markdown banks", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "api", "suggestions.js"), "utf8");
  assert.match(source, /getNameBanks/);
  assert.match(source, /uploaded\.active/);
  assert.match(source, /Team Markdown bank/);
  assert.match(source, /unique\(\[\.\.\.uploadedWestern, \.\.\.\(bank\.western \|\| \[\]\)\]\)/);
});
