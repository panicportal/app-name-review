const { requireSession } = require("./_lib/auth");
const { getOrCreateState } = require("./_lib/state");
const {
  candidateId,
  CATEGORIES,
  coverage,
  enrichedCandidates,
  getOrCreateIconicState,
  traitCounts,
  validateCandidate,
  writeIconicState,
} = require("./_lib/iconic");

const WIKIMEDIA_AGENT = "PanicNameStudio/1.0 (https://panic-name-studio.vercel.app)";
const CONCEPTS = {
  "Everyday villager": ["village character", "villager", "rural heroine"],
  "Common villager": ["village character", "villager", "rural hero"],
  "Polished suit": ["suited character", "menswear icon", "famous suit"],
  "Sharp suit": ["woman in suit character", "women tailoring icon", "businesswoman character"],
  "Simple swimsuit": ["female swimmer", "female aquatic character", "swimsuit icon"],
  "Dark swim trunks": ["male swimmer", "male aquatic character", "swimming champion"],
  "Warm sweatshirt": ["sweatshirt character", "hoodie character", "training sweatshirt"],
  "Vintage sweatshirt": ["vintage sweatshirt", "retro sportswear woman", "sweatshirt fashion icon"],
  "Caramel cowgirl": ["female cowboy", "cowgirl", "woman Wild West outlaw"],
  "Brownie cowboy": ["cowboy", "Western gunslinger", "Wild West outlaw"],
  "Grasping devil": ["male devil character", "demon character", "devil folklore"],
  "Observer angel": ["female angel character", "guardian angel", "angel mythology"],
  "Wandering painter": ["female painter", "woman artist", "famous female painter"],
  "Drifting painter": ["male painter", "famous painter", "artist character"],
  "Wabi sabi kimono": ["male kimono character", "wabi sabi", "Japanese traditional dress man"],
  "Kawaii kimono": ["female kimono character", "kawaii kimono", "Japanese traditional dress woman"],
  "Watchful cat": ["female cat character", "famous cat character", "cat folklore"],
  "Builder bull": ["bull character", "famous bull", "builder character"],
  "Starry night clown": ["male clown character", "famous clown", "clown archetype"],
  "Ham sandwich clown": ["female clown character", "famous female clown", "food clown"],
  "Aware frog": ["female frog character", "famous frog", "frog folklore"],
  "Restless ape": ["male ape character", "famous gorilla character", "ape character"],
  "Love disciple": ["male love deity", "famous romantic character", "love mythology"],
  "Mysterious disciple": ["female mystery character", "sorceress character", "mystery archetype"],
  "Rogue pirate captain": ["female pirate captain", "woman pirate", "female pirate character"],
  "Defiant pirate captain": ["male pirate captain", "famous pirate", "pirate character"],
  "Shiba dog": ["famous Shiba Inu", "Shiba Inu character", "Shiba meme"],
  "King penguin": ["female penguin character", "famous penguin", "penguin character"],
  "Blood crowned saint": ["female martyr saint", "woman saint", "martyred saint"],
  "Divine saint": ["male saint", "famous saint", "saint legend"],
  "Golden angel": ["male angel character", "archangel", "angel mythology"],
  "Spicy devil": ["female devil character", "female demon", "hot pepper nickname"],
  "Star queen": ["star queen character", "celestial queen", "queen constellation"],
  "Star king": ["star king character", "celestial king", "king constellation"],
};

const REJECT_TITLE = /^(list of|category:|index of|outline of|history of|battle of)|\b(in culture|film|album|episode|season|franchise|soundtrack|novel)$|disambiguation/i;
const DIRECT_WORDS = /character|fictional|actor|actress|artist|painter|swimmer|outlaw|gunfighter|cowboy|cowgirl|pirate|saint|angel|demon|devil|frog|cat|bull|ape|gorilla|penguin|shiba|queen|king|clown|kimono/i;
const GROUP_TITLE = /\b(frogs|cats|bulls|apes|gorillas|penguins|cowboys|cowgirls|pirates|angels|devils|demons|saints|clowns|painters|swimmers|characters)\b/i;
const GENERIC_ROUTE_WORDS = new Set([
  "female", "male", "woman", "women", "man", "iconic", "famous", "fictional",
  "character", "characters", "mythology", "folklore", "terminology", "person",
]);

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function displayNameFromTitle(title) {
  const cleaned = String(title || "")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/\s+the\s+(frog|cat|bull|ape|gorilla|penguin|angel|devil|clown)$/i, "")
    .trim();
  if (!/^[A-Za-z][A-Za-z' -]{1,23}$/.test(cleaned) || GROUP_TITLE.test(cleaned)) return "";
  return cleaned;
}

function categoryFor(query, text) {
  if (/myth|folklore|deity|archangel|constellation/i.test(query)) return "Mythology / Folklore";
  if (/saint|outlaw|gunfighter|painter|artist|swimmer|champion/i.test(query) && !/character|fictional/i.test(text)) {
    return "Historical / Real Person";
  }
  return "Iconic Character";
}

function evidenceCandidate(result, clothing, gender, query, concept) {
  const title = stripHtml(result.title);
  const snippet = stripHtml(result.snippet);
  const combined = `${title} ${snippet}`;
  if (!title || REJECT_TITLE.test(title) || !DIRECT_WORDS.test(combined)) return null;
  const description = stripHtml(result.entity_description);
  const conceptWords = concept.toLowerCase().split(/\s+/)
    .map((word) => word.replace(/[^a-z]/g, ""))
    .filter((word) => word.length >= 3 && !GENERIC_ROUTE_WORDS.has(word));
  const semanticText = `${title} ${description}`.toLowerCase();
  const directMatches = conceptWords.filter((word) => semanticText.includes(word)).length;
  if (!directMatches) return null;
  const name = displayNameFromTitle(title);
  if (!name) return null;
  const expectedGenderId = gender === "Female" ? "Q6581072" : "Q6581097";
  if (result.gender_id && result.gender_id !== expectedGenderId) return null;
  const titleDirect = conceptWords.some((word) => title.toLowerCase().includes(word));
  if (!description && !titleDirect) return null;
  const confidence = Math.min(
    96,
    68 + directMatches * 5 + (titleDirect ? 8 : 0) + (result.gender_id === expectedGenderId ? 9 : 0)
  );
  const genderEvidence = result.gender_id === expectedGenderId
    ? ` Wikidata's stored gender matches the ${gender} route.`
    : ` No conflicting Wikidata gender claim was found; confirm gender during review.`;
  return {
    name,
    clothing,
    gender,
    category: categoryFor(query, combined),
    reference: title,
    source_url: `https://en.wikipedia.org/?curid=${result.pageid}`,
    reason: `Wikimedia evidence connects “${title}” with the ${concept} route.${genderEvidence} Entity description: ${description.slice(0, 130) || "title carries the direct trait term"}. Search excerpt: ${snippet.slice(0, 90)}`,
    confidence,
    status: "proposed",
    source_kind: "wikipedia_search",
  };
}

async function wikipediaSearch(query) {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    format: "json",
    utf8: "1",
    srlimit: "8",
    srnamespace: "0",
    srsearch: query,
  });
  const response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: {
      "Api-User-Agent": WIKIMEDIA_AGENT,
      Accept: "application/json",
    },
  });
  if (response.status === 429) throw new Error("Wikimedia asked Name Studio to slow down. Wait a minute, then run research once more.");
  if (!response.ok) throw new Error(`Wikipedia search returned HTTP ${response.status}.`);
  const payload = await response.json();
  return payload.query?.search || [];
}

async function enrichResults(results) {
  const pageIds = results.map((result) => result.pageid).filter(Boolean);
  if (!pageIds.length) return results;
  const pageParams = new URLSearchParams({
    action: "query",
    prop: "pageprops",
    pageids: pageIds.join("|"),
    format: "json",
  });
  const pageResponse = await fetch(`https://en.wikipedia.org/w/api.php?${pageParams}`, {
    headers: { "Api-User-Agent": WIKIMEDIA_AGENT, Accept: "application/json" },
  });
  if (!pageResponse.ok) return results;
  const pagePayload = await pageResponse.json();
  const itemByPage = Object.fromEntries(
    Object.values(pagePayload.query?.pages || {}).map((page) => [page.pageid, page.pageprops?.wikibase_item || ""])
  );
  const itemIds = [...new Set(Object.values(itemByPage).filter(Boolean))];
  if (!itemIds.length) return results;
  const entityParams = new URLSearchParams({
    action: "wbgetentities",
    ids: itemIds.join("|"),
    props: "claims|descriptions",
    languages: "en",
    format: "json",
  });
  const entityResponse = await fetch(`https://www.wikidata.org/w/api.php?${entityParams}`, {
    headers: { "Api-User-Agent": WIKIMEDIA_AGENT, Accept: "application/json" },
  });
  if (!entityResponse.ok) return results;
  const entityPayload = await entityResponse.json();
  return results.map((result) => {
    const entity = entityPayload.entities?.[itemByPage[result.pageid]];
    const genderId = entity?.claims?.P21?.[0]?.mainsnak?.datavalue?.value?.id || "";
    return {
      ...result,
      wikidata_id: itemByPage[result.pageid] || "",
      gender_id: genderId,
      entity_description: entity?.descriptions?.en?.value || "",
    };
  });
}

async function discover(clothing, gender) {
  const concepts = CONCEPTS[clothing] || [clothing];
  const pronoun = gender === "Female" ? "female" : "male";
  const genderedPrimary = /\b(female|male|woman|man)\b/i.test(concepts[0])
    ? concepts[0]
    : `${pronoun} ${concepts[0]}`;
  const routeWords = concepts[0].toLowerCase().split(/\s+/)
    .map((word) => word.replace(/[^a-z]/g, ""))
    .filter((word) => word.length >= 3 && !GENERIC_ROUTE_WORDS.has(word));
  const routeNoun = routeWords.at(-1) || concepts[0];
  const queries = [
    `intitle:${routeNoun} "fictional character"`,
    `"${routeNoun} character" ${pronoun}`,
    `famous ${concepts[1] || genderedPrimary}`,
  ];
  const batches = [];
  for (const query of queries) {
    batches.push(await wikipediaSearch(query));
  }
  const enriched = await enrichResults(batches.flat());
  const byPageId = new Map(enriched.map((result) => [result.pageid, result]));
  const seen = new Set();
  const rows = [];
  batches.forEach((results, queryIndex) => {
    for (const rawResult of results) {
      const result = byPageId.get(rawResult.pageid) || rawResult;
      const row = evidenceCandidate(result, clothing, gender, queries[queryIndex], concepts[queryIndex % concepts.length]);
      if (!row) continue;
      const key = row.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  });
  return { queries, rows: rows.sort((a, b) => b.confidence - a.confidence) };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const [iconicState, liveState] = await Promise.all([
      getOrCreateIconicState(),
      getOrCreateState(),
    ]);
    if (req.method === "GET") {
      return res.status(200).json({
        schema_version: iconicState.schema_version,
        revision: iconicState.revision,
        updated_at: iconicState.updated_at,
        updated_by: iconicState.updated_by,
        categories: CATEGORIES,
        coverage: coverage(iconicState, liveState),
        candidates: enrichedCandidates(iconicState, liveState),
        discovery_runs: iconicState.discovery_runs || [],
        policy: {
          independent_source: true,
          normal_banks_unchanged: true,
          japanese_bank_unchanged: true,
          discovery_requires_human_approval: true,
          ranking: "Directness, recognizability, memorability, collectibility, gender correctness, uniqueness, evidence strength",
        },
      });
    }
    if (!["POST", "PUT", "DELETE"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST, PUT, DELETE");
      return res.status(405).json({ error: "Method not allowed." });
    }
    if (Number(req.body?.base_revision || 0) !== Number(iconicState.revision || 0)) {
      return res.status(409).json({ error: "The Iconic bank changed on another device. Reload before saving." });
    }
    const traits = new Set(Object.keys(traitCounts()));
    const now = new Date().toISOString();
    let next = {
      ...iconicState,
      candidates: { ...(iconicState.candidates || {}) },
      revision: Number(iconicState.revision || 0) + 1,
      updated_at: now,
      updated_by: session.name,
    };
    if (req.method === "POST" && req.body?.action === "discover") {
      const clothing = String(req.body.clothing || "");
      const gender = String(req.body.gender || "");
      if (!traits.has(clothing) || !["Male", "Female"].includes(gender)) {
        return res.status(400).json({ error: "Choose a valid Clothing trait and gender." });
      }
      const result = await discover(clothing, gender);
      const rejectedKeys = new Set(
        Object.values(next.candidates)
          .filter((candidate) => candidate.status === "rejected")
          .map((candidate) => `${candidate.clothing}|${candidate.gender}|${candidate.name}`.toLowerCase())
      );
      let added = 0;
      for (const candidate of result.rows) {
        const rejectKey = `${clothing}|${gender}|${candidate.name}`.toLowerCase();
        if (rejectedKeys.has(rejectKey)) continue;
        const existing = Object.values(next.candidates).find((item) =>
          !item.deleted_at &&
          item.clothing === clothing &&
          item.gender === gender &&
          item.name.toLowerCase() === candidate.name.toLowerCase()
        );
        if (existing) continue;
        const id = candidateId(clothing, gender, candidate.name, candidate.reference);
        next.candidates[id] = {
          ...candidate,
          id,
          created_at: now,
          updated_at: now,
          updated_by: session.name,
        };
        added += 1;
      }
      next.discovery_runs = [
        ...(next.discovery_runs || []),
        { at: now, by: session.name, clothing, gender, queries: result.queries, found: result.rows.length, added },
      ].slice(-100);
      await writeIconicState(next);
      return res.status(200).json({ revision: next.revision, added, found: result.rows.length, queries: result.queries });
    }
    if (req.method === "PUT") {
      const input = validateCandidate(req.body?.candidate || {}, traits);
      const existingId = String(req.body?.candidate?.id || "");
      const id = existingId && next.candidates[existingId]
        ? existingId
        : candidateId(input.clothing, input.gender, input.name, input.reference);
      next.candidates[id] = {
        ...(next.candidates[id] || {}),
        ...input,
        id,
        created_at: next.candidates[id]?.created_at || now,
        updated_at: now,
        updated_by: session.name,
        deleted_at: null,
      };
      await writeIconicState(next);
      return res.status(200).json({ revision: next.revision, candidate: next.candidates[id] });
    }
    const id = String(req.body?.id || "");
    if (!next.candidates[id]) return res.status(404).json({ error: "Candidate not found." });
    next.candidates[id] = {
      ...next.candidates[id],
      deleted_at: now,
      updated_at: now,
      updated_by: session.name,
    };
    await writeIconicState(next);
    return res.status(200).json({ revision: next.revision, deleted: id });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Could not update Iconic / Fun bank." });
  }
};

module.exports._test = { discover, displayNameFromTitle, evidenceCandidate };
