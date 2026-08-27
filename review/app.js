const STORAGE_KEY = "panic-name-curation-v2-v11";
const LEGACY_STORAGE_KEY = "panic-name-reviews-v1";
const VIEW_MODE_KEY = "panic-name-review-view-mode";
const CLOUD_SYNC_MARKER_KEY = "panic-name-cloud-sync-v12-aug02";
const PRE_CLOUD_BACKUP_KEY = "panic-name-pre-cloud-backup-v12-aug02";
const SCHEMA_VERSION = "panic-name-curation/v2";
const PACKAGED_PROGRESS_URL = "/cloud_seed_curation.json";
const PART_KEYS = ["first", "surname_part_1", "surname_part_2"];
const CLOUD_POLL_MS = 12000;
const SURNAME_FORMAT_VERSION = 3;
const ELIGIBLE_SURNAME_TRAIT_TYPES = new Set([
  "Background", "Back", "Front", "Hair", "Eyes", "Eyebrows", "Mouth"
]);
const VOICE_SETTINGS_KEY = "panic-name-studio-voice-v2";
const CHATGPT_HANDOFF_KEY = "panic-name-studio-chatgpt-handoff-v1";

function emptyCuration() {
  return {
    schema_version: SCHEMA_VERSION,
    reviewer: "",
    records: {},
    updated_at: null
  };
}

function loadCuration() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (parsed?.schema_version === SCHEMA_VERSION && parsed.records) return parsed;
  } catch (_) {
    // A malformed local draft is ignored; imports remain available as backup.
  }
  return emptyCuration();
}

const state = {
  data: null,
  filtered: [],
  selected: null,
  page: 0,
  pageSize: 60,
  traitFilterMode: "clothing",
  viewMode: localStorage.getItem(VIEW_MODE_KEY) === "focus" ? "focus" : "browse",
  curation: loadCuration(),
  saveTimer: null,
  cloudTimer: null,
  cloudPollTimer: null,
  cloudAuthenticated: false,
  cloudMode: "connecting",
  cloudRevision: 0,
  cloudDirty: false,
  cloudSaveVersion: 0,
  cloudHistory: [],
  suggestionPart: null,
  suggestionLanguage: null,
  suggestionNameSource: "iconic",
  suggestionCategory: "all",
  suggestionSearch: "",
  suggestionSource: null,
  suggestionSort: "balanced",
  suggestionPayload: null,
  suggestionPreviewOrder: "12",
  suggestionJoinStyle: "lower_second",
  suggestionRequestVersion: 0,
  namingAssistant: { payload: null, loading: false, configured: null },
  chatGptHandoff: { generation: 0, characterId: null, bundle: null, packet: null, firstNameCandidates: [] },
  surnameRepairIndex: {},
  surnameRepairSummary: { detected: 0, unresolved: 0 },
  surnameDetectTimer: null,
  focusSwipeStart: null,
  voice: {
    recognition: null,
    supported: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    listening: false,
    handsFree: false,
    muted: false,
    pending: null,
    manualStop: false,
    lastSpoken: "",
    lastTranscript: "",
    wakeLock: null,
    settings: { personality: "scout", rate: 0.8, voiceURI: "" }
  }
};

const $ = id => document.getElementById(id);
const els = {};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function nowIso() {
  return new Date().toISOString();
}

function latestValue(values) {
  const sorted = values.filter(Boolean).sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function blankPart() {
  return {
    decision: null,
    scope: null,
    note: "",
    updated_at: null,
    reviewer: "",
    replacement_value: null,
    replacement_source: "",
    replacement_trait_source: "",
    replacement_language: "",
    replacement_rationale: "",
    replacement_scores: null,
    disabled: false,
    deleted_at: null
  };
}

function recordFor(id) {
  return state.curation.records[String(id)] || {
    note: "",
    updated_at: null,
    surname_order: "12",
    surname_order_updated_at: null,
    surname_join_style: "lower_second",
    surname_format_version: SURNAME_FORMAT_VERSION,
    surname_join_style_updated_at: null,
    normalized_name: null,
    normalized_name_updated_at: null,
    naming_assistant_history: [],
    parts: {}
  };
}

function partReview(id, key) {
  return {
    ...blankPart(),
    ...(recordFor(id).parts?.[key] || {})
  };
}

function ensureRecord(id) {
  const key = String(id);
  if (!state.curation.records[key] || state.curation.records[key].deleted_at) {
    state.curation.records[key] = {
      note: "",
      note_updated_at: null,
      updated_at: null,
      surname_order: "12",
      surname_order_updated_at: null,
      surname_join_style: "lower_second",
      surname_format_version: SURNAME_FORMAT_VERSION,
      surname_join_style_updated_at: null,
      normalized_name: null,
      normalized_name_updated_at: null,
      naming_assistant_history: [],
      parts: {}
    };
  }
  if (!state.curation.records[key].parts) {
    state.curation.records[key].parts = {};
  }
  return state.curation.records[key];
}

function isPartTouched(part) {
  return Boolean(part?.decision || part?.note?.trim());
}

function isRecordTouched(record) {
  return Boolean(
    record?.note?.trim() ||
    record?.surname_order_updated_at ||
    record?.surname_join_style_updated_at ||
    record?.normalized_name_updated_at ||
    record?.naming_assistant_history?.length ||
    Object.values(record?.parts || {}).some(isPartTouched)
  );
}

function pruneRecord(id) {
  const key = String(id);
  const record = state.curation.records[key];
  const hasTombstone = Boolean(
    record?.deleted_at ||
    Object.values(record?.parts || {}).some(part => part?.deleted_at)
  );
  if (!isRecordTouched(record) && !hasTombstone) {
    delete state.curation.records[key];
  }
}

function saveCuration() {
  state.curation.updated_at = nowIso();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.curation));
  state.cloudDirty = true;
  state.cloudSaveVersion += 1;
  if (els.saveState) {
    els.saveState.textContent = state.cloudAuthenticated ? "Saving to cloud…" : "Saved on this device";
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      if (!state.cloudAuthenticated) els.saveState.textContent = "Saved on this device";
    }, 220);
  }
  scheduleCloudSave();
}

function setCloudStatus(mode, text) {
  state.cloudMode = mode;
  if (!els.cloudChip) return;
  els.cloudChip.className = `cloud-chip ${mode}`;
  els.cloudChip.querySelector("b").textContent = text;
}

function setViewMode(mode) {
  state.viewMode = mode === "focus" ? "focus" : "browse";
  localStorage.setItem(VIEW_MODE_KEY, state.viewMode);
  els.app.classList.toggle("focus-mode", state.viewMode === "focus");
  els.app.classList.toggle("browse-mode", state.viewMode === "browse");
  els.viewModeSwitch.querySelectorAll("[data-view-mode]").forEach(button => {
    const active = button.dataset.viewMode === state.viewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (state.viewMode === "focus") setMobileRoster(false);
  if (state.viewMode === "focus" && state.selected) renderFocusDeck(state.selected);
}

function setMobileRoster(open) {
  const expanded = Boolean(open);
  els.app.classList.toggle("mobile-roster-open", expanded);
  document.body.classList.toggle("mobile-roster-open", expanded);
  els.mobileFiltersButton?.setAttribute("aria-expanded", String(expanded));
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedJoinStyle(value) {
  return ["lower_second", "camel", "overlap_one"].includes(value)
    ? value
    : "lower_second";
}

function newerPart(left = {}, right = {}) {
  return timestamp(left.updated_at || left.deleted_at) >=
    timestamp(right.updated_at || right.deleted_at) ? left : right;
}

function mergeCurationStates(local, remote) {
  if (!remote?.records) return local;
  const merged = {
    ...emptyCuration(),
    ...local,
    reviewer: local.reviewer || remote.reviewer || "",
    records: { ...(local.records || {}) },
    updated_at: latestValue([local.updated_at, remote.updated_at])
  };
  Object.entries(remote.records || {}).forEach(([id, incoming]) => {
    const current = merged.records[id] || {};
    if (incoming.deleted_at && timestamp(incoming.deleted_at) >= timestamp(current.updated_at)) {
      merged.records[id] = incoming;
      return;
    }
    if (current.deleted_at && timestamp(current.deleted_at) > timestamp(incoming.updated_at)) return;
    const result = {
      note: timestamp(incoming.note_updated_at) >= timestamp(current.note_updated_at)
        ? (incoming.note || "") : (current.note || ""),
      note_updated_at: timestamp(incoming.note_updated_at) >= timestamp(current.note_updated_at)
        ? (incoming.note_updated_at || incoming.updated_at || null)
        : (current.note_updated_at || current.updated_at || null),
      surname_order:
        timestamp(incoming.surname_order_updated_at) >= timestamp(current.surname_order_updated_at)
          ? (incoming.surname_order || "12")
          : (current.surname_order || "12"),
      surname_order_updated_at:
        timestamp(incoming.surname_order_updated_at) >= timestamp(current.surname_order_updated_at)
          ? (incoming.surname_order_updated_at || null)
          : (current.surname_order_updated_at || null),
      surname_join_style:
        timestamp(incoming.surname_join_style_updated_at) >= timestamp(current.surname_join_style_updated_at)
          ? normalizedJoinStyle(incoming.surname_join_style)
          : normalizedJoinStyle(current.surname_join_style),
      surname_join_style_updated_at:
        timestamp(incoming.surname_join_style_updated_at) >= timestamp(current.surname_join_style_updated_at)
          ? (incoming.surname_join_style_updated_at || null)
          : (current.surname_join_style_updated_at || null),
      surname_format_version:
        timestamp(incoming.surname_join_style_updated_at) >= timestamp(current.surname_join_style_updated_at)
          ? Number(incoming.surname_format_version || 0)
          : Number(current.surname_format_version || 0),
      normalized_name:
        timestamp(incoming.normalized_name_updated_at) >= timestamp(current.normalized_name_updated_at)
          ? (incoming.normalized_name || null)
          : (current.normalized_name || null),
      normalized_name_updated_at:
        timestamp(incoming.normalized_name_updated_at) >= timestamp(current.normalized_name_updated_at)
          ? (incoming.normalized_name_updated_at || null)
          : (current.normalized_name_updated_at || null),
      naming_assistant_history:
        timestamp(incoming.updated_at) >= timestamp(current.updated_at)
          ? (incoming.naming_assistant_history || current.naming_assistant_history || []).slice(-20)
          : (current.naming_assistant_history || []).slice(-20),
      parts: { ...(current.parts || {}) }
    };
    Object.entries(incoming.parts || {}).forEach(([key, part]) => {
      result.parts[key] = newerPart(part, result.parts[key]);
    });
    result.updated_at = latestValue([
      current.updated_at,
      incoming.updated_at,
      result.note_updated_at,
      result.surname_order_updated_at,
      result.surname_join_style_updated_at,
      result.normalized_name_updated_at,
      ...Object.values(result.parts).map(part => part.updated_at || part.deleted_at)
    ]);
    merged.records[id] = result;
  });
  return merged;
}

async function pullCloudState({ quiet = false } = {}) {
  if (!state.cloudAuthenticated) return;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.status === 401) {
      state.cloudAuthenticated = false;
      els.loginGate.hidden = false;
      setCloudStatus("offline", "Sign in");
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.cloudRevision = Number(payload.revision || 0);
    state.cloudHistory = payload.history || [];
    const before = JSON.stringify(state.curation);
    const hasSyncedBefore = Boolean(localStorage.getItem(CLOUD_SYNC_MARKER_KEY));
    if (!hasSyncedBefore) {
      localStorage.setItem(PRE_CLOUD_BACKUP_KEY, before);
      state.curation = payload.curation;
    } else {
      state.curation = mergeCurationStates(state.curation, payload.curation);
    }
    localStorage.setItem(
      CLOUD_SYNC_MARKER_KEY,
      JSON.stringify({ revision: payload.revision, synced_at: nowIso() })
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.curation));
    if (JSON.stringify(state.curation) !== before && state.selected) {
      renderCharacter();
      updateProgress();
      applyFilters();
    }
    els.reviewerName.value = state.curation.reviewer || "";
    els.saveState.textContent = `Synced · revision ${state.cloudRevision}`;
    setCloudStatus("online", "Synced");
  } catch (error) {
    setCloudStatus("offline", "Offline");
    els.saveState.textContent = "Offline draft saved on this device";
    if (!quiet) showToast("Cloud is temporarily unavailable. Your draft is safe on this device.", "warning");
  }
}

async function pushCloudState() {
  if (!state.cloudAuthenticated || !state.cloudDirty) return;
  const saveVersion = state.cloudSaveVersion;
  setCloudStatus("saving", "Saving");
  try {
    const response = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: state.cloudRevision,
        curation: state.curation
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.cloudRevision = Number(payload.revision || 0);
    state.cloudHistory = payload.history || [];
    state.curation = mergeCurationStates(state.curation, payload.curation);
    if (state.cloudSaveVersion === saveVersion) state.cloudDirty = false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.curation));
    localStorage.setItem(
      CLOUD_SYNC_MARKER_KEY,
      JSON.stringify({ revision: payload.revision, synced_at: nowIso() })
    );
    els.saveState.textContent = `Synced · revision ${state.cloudRevision}`;
    setCloudStatus("online", "Synced");
  } catch (_) {
    setCloudStatus("offline", "Offline");
    els.saveState.textContent = "Offline draft saved · will retry";
  }
}

function flushCloudState() {
  if (!state.cloudAuthenticated || !state.cloudDirty) return;
  clearTimeout(state.cloudTimer);
  fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision: state.cloudRevision,
      curation: state.curation
    }),
    keepalive: true
  }).catch(() => {
    // The local draft remains authoritative on this device and retries next visit.
  });
}

function scheduleCloudSave() {
  if (!state.cloudAuthenticated) return;
  clearTimeout(state.cloudTimer);
  state.cloudTimer = setTimeout(pushCloudState, 650);
}

function syncCloudTick() {
  if (state.cloudDirty) pushCloudState();
  else pullCloudState({ quiet: true });
}

function languageLabel(value) {
  return value === "japanese" ? "Japanese bank" :
    value === "western" ? "Western bank" : "Special";
}

function splitSource(source = "") {
  const divider = source.indexOf(":");
  return divider === -1
    ? ["Trait", source]
    : [source.slice(0, divider), source.slice(divider + 1)];
}

function partDefinitions(character) {
  const detail = character.surname_detail || {};
  const autoRepair = state.surnameRepairIndex?.[String(character.id)];
  const storedPart2 = state.curation.records?.[String(character.id)]?.parts?.surname_part_2;
  const hasLivePart2 = Boolean(
    storedPart2 && !storedPart2.deleted_at && (
      storedPart2.disabled ||
      storedPart2.decision ||
      storedPart2.replacement_value ||
      storedPart2.replacement_source ||
      storedPart2.replacement_trait_source
    )
  );
  const hasSecondPart = Boolean(autoRepair || detail.source_2 || character.surname_source_2 || hasLivePart2);
  const hasActiveSecondPart = Boolean(autoRepair) || (hasSecondPart && !storedPart2?.disabled);
  return [
    {
      key: "first",
      short: "F",
      label: "First name",
      value: character.first || "",
      source: character.first_name_source || "",
      available: Boolean(character.first)
    },
    {
      key: "surname_part_1",
      short: hasActiveSecondPart ? "S1" : "S",
      label: hasActiveSecondPart ? "Surname part 1" : "Surname",
      value: autoRepair?.surname_components?.[0]?.text || detail.component_1 || character.surname_component_1 || character.surname || "",
      source: autoRepair?.surname_components?.[0]?.source_raw || detail.source_1 || character.surname_source_1 || character.surname_source || "",
      usage_count: Number(detail.component_1_count || 0),
      available: Boolean(character.surname)
    },
    {
      key: "surname_part_2",
      short: "S2",
      label: "Surname part 2",
      value: autoRepair?.surname_components?.[1]?.text || detail.component_2 || character.surname_component_2 || "",
      source: autoRepair?.surname_components?.[1]?.source_raw || detail.source_2 || character.surname_source_2 || "",
      usage_count: Number(detail.component_2_count || 0),
      available: Boolean(character.surname && hasActiveSecondPart)
    }
  ];
}

function effectivePartValue(character, key) {
  const part = partDefinitions(character).find(item => item.key === key);
  const review = partReview(character.id, key);
  const autoRepair = state.surnameRepairIndex?.[String(character.id)];
  if (autoRepair && key === "surname_part_1") return autoRepair.surname_components[0].text;
  if (autoRepair && key === "surname_part_2") return autoRepair.surname_components[1].text;
  if (review.disabled) return "";
  return review.replacement_value || part?.value || "";
}

function effectivePartSource(character, key) {
  const definition = partDefinitions(character).find(item => item.key === key);
  const autoRepair = state.surnameRepairIndex?.[String(character.id)];
  if (autoRepair && key === "surname_part_1") return autoRepair.surname_components[0].source_raw;
  if (autoRepair && key === "surname_part_2") return autoRepair.surname_components[1].source_raw;
  return partReview(character.id, key).replacement_trait_source ||
    partReview(character.id, key).replacement_source ||
    definition?.source ||
    "";
}

function replacementLanguage(review, fallback = "western") {
  if (!review?.replacement_value) return fallback;
  if (review.replacement_language) return review.replacement_language;
  const auditText = [
    review.replacement_source,
    review.replacement_trait_source,
    review.replacement_rationale
  ].filter(Boolean).join(" ");
  if (/Japanese names surnames\.csv|artist Japanese CSV|closed artist/i.test(auditText)) {
    return "japanese";
  }
  if (/Manual team edit|Western|SSA|behindthename|museum|swimmer/i.test(auditText)) {
    return "western";
  }
  return fallback;
}

function effectiveFirstLanguage(character) {
  return replacementLanguage(
    partReview(character.id, "first"),
    character.first_name_language || "western"
  );
}

function effectiveSurnameLanguage(character) {
  const languages = ["surname_part_1", "surname_part_2"]
    .map(key => partReview(character.id, key))
    .filter(review => !review.disabled && review.replacement_value)
    .map(review => replacementLanguage(review, character.surname_language || "western"))
    .filter(Boolean);
  return languages[0] || character.surname_language || "western";
}

function replaceFirstExact(text, search, replacement) {
  if (!search || !replacement) return text;
  const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return pattern.test(text) ? text.replace(pattern, replacement) : text;
}

function canFlipSurname(character) {
  return Boolean(
    effectivePartValue(character, "surname_part_1") &&
    effectivePartValue(character, "surname_part_2")
  );
}

function surnameOrder(character) {
  if (state.surnameRepairIndex?.[String(character.id)]) return "12";
  return canFlipSurname(character) && recordFor(character.id).surname_order === "21"
    ? "21"
    : "12";
}

function compoundComponent(value) {
  const text = String(value || "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function surnameJoinStyle(character) {
  const record = recordFor(character.id);
  const autoRepair = state.surnameRepairIndex?.[String(character.id)];
  if (autoRepair?.join_style === "overlap_one") return "overlap_one";
  if (
    Number(record.surname_format_version || 0) >= SURNAME_FORMAT_VERSION &&
    record.surname_join_style === "overlap_one"
  ) {
    return "overlap_one";
  }
  // v1 stored "camel" as an automatic default, not an editorial decision.
  // Treat all legacy records as the new metadata-clean style. A capitalized
  // second fragment remains available only when explicitly selected in v2.
  if (
    Number(record.surname_format_version || 0) >= SURNAME_FORMAT_VERSION &&
    record.surname_join_style === "camel"
  ) {
    return "camel";
  }
  return "lower_second";
}

function composeSurname(
  character,
  firstPart,
  secondPart,
  order = surnameOrder(character),
  joinStyle = surnameJoinStyle(character)
) {
  if (!firstPart) return compoundComponent(secondPart) || character.surname || "";
  if (!secondPart) return compoundComponent(firstPart) || character.surname || "";
  const left = order === "21" ? secondPart : firstPart;
  const right = order === "21" ? firstPart : secondPart;
  if (joinStyle === "overlap_one" && String(left).slice(-1).toLowerCase() === String(right).slice(0, 1).toLowerCase()) {
    return `${compoundComponent(left)}${String(right).slice(1).toLowerCase()}`;
  }
  const rightText = joinStyle === "lower_second"
    ? String(right || "").trim().toLowerCase()
    : compoundComponent(right);
  return `${compoundComponent(left)}${rightText}`;
}

function effectiveSurname(character) {
  let surname = character.surname || "";
  const detail = character.surname_detail || {};
  const original1 = detail.component_1 || character.surname_component_1 || surname;
  const original2 = detail.component_2 || character.surname_component_2 || "";
  const next1 = effectivePartValue(character, "surname_part_1");
  const next2 = effectivePartValue(character, "surname_part_2");
  if (next1 || next2) {
    return composeSurname(character, next1, next2);
  }
  surname = replaceFirstExact(surname, original1, next1);
  surname = replaceFirstExact(surname, original2, next2);
  if (!original2 && next1 && surname === character.surname) return next1;
  return surname;
}

function effectiveDisplayName(character) {
  return [
    effectivePartValue(character, "first"),
    effectiveSurname(character)
  ].filter(Boolean).join(" ");
}

function eligibleSurnameTraits(character) {
  return (character?.traits || []).filter(trait =>
    ELIGIBLE_SURNAME_TRAIT_TYPES.has(trait.type) && trait.value
  );
}

function cleanSurnameComponent(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z]{2,24}$/.test(text)
    ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
    : "";
}

function normalizedSurnameFor(character) {
  const record = recordFor(character.id);
  const autoRepair = state.surnameRepairIndex?.[String(character.id)];
  if (autoRepair) {
    return {
      first_name: effectivePartValue(character, "first"),
      surname_display: autoRepair.surname_display,
      surname_components: autoRepair.surname_components.map((component) => ({ ...component, confidence: autoRepair.confidence })),
      surname_join_style: autoRepair.join_style || "lower_second",
      surname_format_version: 3,
      derivation_method: "auto_detected_unconfirmed",
      needs_surname_component_repair: true,
      recovery_evidence: autoRepair.evidence,
    };
  }
  const normalized = record.normalized_name;
  if (Number(normalized?.surname_format_version) >= 3 && Array.isArray(normalized.surname_components)) {
    return normalized;
  }
  const firstPart = partReview(character.id, "surname_part_1");
  const secondPart = partReview(character.id, "surname_part_2");
  const value1 = effectivePartValue(character, "surname_part_1");
  const value2 = effectivePartValue(character, "surname_part_2");
  const source1 = effectivePartSource(character, "surname_part_1");
  const source2 = effectivePartSource(character, "surname_part_2");
  const directCollapsed = Boolean(
    firstPart.replacement_value &&
    /manual team edit|direct full-name edit/i.test(firstPart.replacement_source || "") &&
    secondPart.disabled
  );
  if (directCollapsed) {
    return {
      first_name: effectivePartValue(character, "first"),
      surname_display: effectiveSurname(character),
      surname_components: [],
      surname_join_style: surnameJoinStyle(character),
      surname_format_version: 2,
      derivation_method: "unknown",
      needs_surname_component_repair: true
    };
  }
  const components = [
    value1 && source1 ? { order: 1, text: value1, source_raw: source1 } : null,
    value2 && source2 ? { order: 2, text: value2, source_raw: source2 } : null
  ].filter(Boolean);
  return {
    first_name: effectivePartValue(character, "first"),
    surname_display: effectiveSurname(character),
    surname_components: components,
    surname_join_style: surnameJoinStyle(character),
    surname_format_version: components.length === 2 ? 3 : 1,
    derivation_method: components.length === 2 ? "legacy_migrated" : "existing",
    needs_surname_component_repair: effectiveSurnameLanguage(character) === "western" && components.length !== 2
  };
}

function needsSurnameComponentRepair(character) {
  return Boolean(normalizedSurnameFor(character).needs_surname_component_repair);
}

function fullNameAlreadyUsed(first, surname) {
  const target = `${first} ${surname}`.toLowerCase();
  return state.data.characters.some(character =>
    character.id !== state.selected?.id && effectiveDisplayName(character).toLowerCase() === target
  );
}

function surnameFromEditorComponents() {
  const first = cleanSurnameComponent(els.fullNameEditComponent1.value);
  const second = cleanSurnameComponent(els.fullNameEditComponent2.value);
  if (!first || !second) return "";
  const order = els.fullNameEditForm.dataset.order === "21" ? "21" : "12";
  const ordered = order === "21" ? [second, first] : [first, second];
  const joinStyle = normalizedJoinStyle(els.fullNameEditForm.dataset.joinStyle);
  if (
    joinStyle === "overlap_one" &&
    ordered[0].slice(-1).toLowerCase() === ordered[1].slice(0, 1).toLowerCase()
  ) {
    return `${ordered[0]}${ordered[1].slice(1).toLowerCase()}`;
  }
  return `${ordered[0]}${ordered[1].charAt(0).toLowerCase()}${ordered[1].slice(1)}`;
}

function syncSurnameFromComponents() {
  const surname = surnameFromEditorComponents();
  if (surname) {
    els.fullNameEditSurnameInput.value = surname;
    const first = normalizeManualFirstName(els.fullNameEditFirstInput.value);
    if (first) els.fullNamePasteInput.value = `${first} ${surname}`;
  }
  updateFullNameEditPreview();
}

function applySurnameRepairProposal(proposal) {
  if (!proposal?.surname_components?.length || proposal.surname_components.length !== 2) return false;
  const [first, second] = proposal.surname_components;
  els.fullNameEditComponent1.value = first.text || "";
  els.fullNameEditComponent2.value = second.text || "";
  els.fullNameEditSource1.value = first.source_raw || "";
  els.fullNameEditSource2.value = second.source_raw || "";
  els.fullNameEditForm.dataset.order = "12";
  els.fullNameEditForm.dataset.joinStyle = normalizedJoinStyle(proposal.join_style);
  els.fullNameEditForm.dataset.repairingCollapsed = proposal.corrects_current_display ? "true" : "false";
  els.fullNameEditSurnameInput.value = proposal.surname_display || surnameFromEditorComponents();
  const givenName = normalizeManualFirstName(els.fullNameEditFirstInput.value);
  if (givenName) els.fullNamePasteInput.value = `${givenName} ${els.fullNameEditSurnameInput.value}`;
  const route1 = first.source_raw || "unknown route";
  const route2 = second.source_raw || "unknown route";
  els.fullNameDetectStatus.textContent = proposal.corrects_current_display
    ? `Detected ${first.text} + ${second.text}. ${route1} + ${route2}. The broken “${proposal.current_display}” preview will be corrected to “${proposal.surname_display}” only when you press Save.`
    : `Detected ${first.text} + ${second.text}. ${route1} + ${route2}. Review both parts, then press Save to confirm them.`;
  els.fullNameDetectStatus.classList.remove("error");
  els.fullNameDetectStatus.classList.add("success");
  updateFullNameEditPreview();
  return true;
}

function parsePastedFullName({ quiet = false } = {}) {
  const words = String(els.fullNamePasteInput.value || "").trim().split(/\s+/).filter(Boolean);
  if (words.length !== 2) {
    if (!quiet) {
      els.fullNameDetectStatus.textContent = "Paste exactly two words: one first name and one combined surname, for example Angela Gingerwine.";
      els.fullNameDetectStatus.classList.add("error");
      els.fullNameDetectStatus.classList.remove("success");
    }
    return null;
  }
  const first = normalizeManualFirstName(words[0]);
  const surname = cleanSurnameComponent(words[1]);
  if (!first || !surname) {
    if (!quiet) {
      els.fullNameDetectStatus.textContent = "Use one safe first-name word and one combined surname word.";
      els.fullNameDetectStatus.classList.add("error");
      els.fullNameDetectStatus.classList.remove("success");
    }
    return null;
  }
  els.fullNameEditFirstInput.value = first;
  els.fullNameEditSurnameInput.value = surname;
  return { first, surname };
}

async function requestSurnameDetection({ quiet = false, onlyIfRepair = false } = {}) {
  if (!state.selected) return;
  const parsed = parsePastedFullName({ quiet });
  if (!parsed) {
    updateFullNameEditPreview();
    return;
  }
  if (els.fullNameEditForm.dataset.surnameLanguage === "japanese") {
    els.fullNameDetectStatus.textContent = "This is an atomic Japanese surname, so it stays as one surname word.";
    els.fullNameDetectStatus.classList.remove("error", "success");
    updateFullNameEditPreview();
    return;
  }
  if (!state.cloudAuthenticated) {
    const cached = state.surnameRepairIndex?.[String(state.selected.id)];
    if (cached && cached.surname_display?.toLowerCase() === parsed.surname.toLowerCase()) {
      applySurnameRepairProposal(cached);
      return;
    }
    if (onlyIfRepair) {
      updateFullNameEditPreview();
      return;
    }
    els.fullNameDetectStatus.textContent = "Connect to shared sync to auto-detect exact routes. You can still enter both component words and choose their traits manually.";
    els.fullNameDetectStatus.classList.add("error");
    els.fullNameDetectStatus.classList.remove("success");
    updateFullNameEditPreview();
    return;
  }
  els.fullNameDetectStatus.textContent = `Detecting the two trait words inside “${parsed.surname}”…`;
  els.fullNameDetectStatus.classList.remove("error", "success");
  try {
    const response = await fetch(`/api/surname-repair?id=${encodeURIComponent(state.selected.id)}&surname=${encodeURIComponent(parsed.surname)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not detect surname parts.");
    const proposal = payload.proposals?.[0];
    if (proposal && (!onlyIfRepair || payload.needs_repair)) {
      applySurnameRepairProposal(proposal);
      return;
    }
    if (onlyIfRepair) {
      updateFullNameEditPreview();
      return;
    }
    els.fullNameEditComponent1.value = "";
    els.fullNameEditComponent2.value = "";
    els.fullNameEditSource1.value = "";
    els.fullNameEditSource2.value = "";
    els.fullNameDetectStatus.textContent = `“${parsed.surname}” is preserved, but its exact two trait words could not be confirmed automatically. Type the two words and choose both exact routes; nothing will be guessed.`;
    els.fullNameDetectStatus.classList.add("error");
    els.fullNameDetectStatus.classList.remove("success");
    updateFullNameEditPreview();
  } catch (error) {
    els.fullNameDetectStatus.textContent = error.message;
    els.fullNameDetectStatus.classList.add("error");
    els.fullNameDetectStatus.classList.remove("success");
    updateFullNameEditPreview();
  }
}

function scheduleSurnameDetection() {
  clearTimeout(state.surnameDetectTimer);
  state.surnameDetectTimer = setTimeout(() => requestSurnameDetection({ quiet: true }), 450);
}

function beginPastedFullNameDetection() {
  const parsed = parsePastedFullName({ quiet: true });
  if (!parsed) {
    updateFullNameEditPreview();
    return;
  }
  if (els.fullNameEditForm.dataset.surnameLanguage !== "japanese") {
    const existingCompound = surnameFromEditorComponents();
    if (!existingCompound || existingCompound.toLowerCase() !== parsed.surname.toLowerCase()) {
      els.fullNameEditComponent1.value = "";
      els.fullNameEditComponent2.value = "";
      els.fullNameEditSource1.value = "";
      els.fullNameEditSource2.value = "";
      els.fullNameEditForm.dataset.order = "12";
      els.fullNameEditForm.dataset.joinStyle = "lower_second";
      els.fullNameDetectStatus.textContent = `Using “${parsed.first} ${parsed.surname}” as the new full name. Detecting its two surname traits now; the old surname slots will not be appended.`;
      els.fullNameDetectStatus.classList.remove("error", "success");
    }
  }
  updateFullNameEditPreview();
  scheduleSurnameDetection();
}

async function loadSurnameRepairIndex() {
  if (!state.cloudAuthenticated) return;
  try {
    const response = await fetch("/api/surname-repair?all=1", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load surname repair proposals.");
    state.surnameRepairIndex = payload.repairs || {};
    state.surnameRepairSummary = {
      detected: Number(payload.detected || 0),
      unresolved: Number(payload.unresolved || 0)
    };
    const selectedRepair = state.selected && state.surnameRepairIndex[String(state.selected.id)];
    if (selectedRepair && els.fullNameEditDialog?.open) applySurnameRepairProposal(selectedRepair);
    if (state.selected) renderCharacter();
    updateProgress();
    applyFilters();
  } catch (error) {
    console.warn("Surname repair proposals unavailable:", error);
  }
}

async function loadSelectedSurnameRepair(character = state.selected) {
  if (!state.cloudAuthenticated || !character || effectiveSurnameLanguage(character) !== "western") return;
  try {
    const response = await fetch(`/api/surname-repair?id=${encodeURIComponent(character.id)}&surname=${encodeURIComponent(effectiveSurname(character))}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not inspect this surname.");
    if (!payload.needs_repair || !payload.proposals?.[0]) return;
    state.surnameRepairIndex[String(character.id)] = payload.proposals[0];
    state.surnameRepairSummary.detected = Object.keys(state.surnameRepairIndex).length;
    if (state.selected?.id === character.id) {
      renderCharacter();
      if (els.fullNameEditDialog?.open) applySurnameRepairProposal(payload.proposals[0]);
    }
  } catch (error) {
    console.warn(`Surname repair check failed for #${character.id}:`, error);
  }
}

function scheduleFullSurnameRepairScan() {
  setTimeout(() => loadSurnameRepairIndex(), 2500);
}

function fullNameEditorValue() {
  const first = normalizeManualFirstName(els.fullNameEditFirstInput.value);
  const component1 = cleanSurnameComponent(els.fullNameEditComponent1.value);
  const component2 = cleanSurnameComponent(els.fullNameEditComponent2.value);
  const source1 = els.fullNameEditSource1.value;
  const source2 = els.fullNameEditSource2.value;
  const order = els.fullNameEditForm.dataset.order === "21" ? "21" : "12";
  const joinStyle = els.fullNameEditForm.dataset.joinStyle === "overlap_one" ? "overlap_one" : "lower_second";
  const japanese = els.fullNameEditForm.dataset.surnameLanguage === "japanese";
  if (!first) return { error: "First name must use 2–20 safe English letters, apostrophe, or hyphen." };
  if (japanese) {
    const surname = String(els.fullNameEditSurnameInput.value || "").trim();
    if (!/^[A-Za-z]{2,32}$/.test(surname)) return { error: "Japanese surname romanization must be one word using 2–32 English letters." };
    return { first, surname, japanese, order: "12", components: [] };
  }
  const hasAnyStructuredInput = Boolean(component1 || component2 || source1 || source2);
  if (needsSurnameComponentRepair(state.selected) && !hasAnyStructuredInput) {
    return { first, surname: effectiveSurname(state.selected), japanese: false, order, components: [], preserve_unresolved_surname: true };
  }
  if (!component1 || !component2) return { error: "Add two one-word surname components." };
  if (!source1 || !source2) return { error: "Select an exact source trait for both surname components." };
  if (source1 === source2) return { error: "Surname component 1 and 2 must use different traits." };
  const ordered = order === "21" ? [component2, component1] : [component1, component2];
  const surname = joinStyle === "overlap_one" && ordered[0].slice(-1).toLowerCase() === ordered[1].slice(0, 1).toLowerCase()
    ? `${ordered[0]}${ordered[1].slice(1).toLowerCase()}`
    : `${ordered[0]}${ordered[1].charAt(0).toLowerCase()}${ordered[1].slice(1)}`;
  const requestedSurname = cleanSurnameComponent(els.fullNameEditSurnameInput.value);
  if (!requestedSurname) return { error: "Final surname must be one word using 2–24 English letters." };
  if (requestedSurname.toLowerCase() !== surname.toLowerCase()) {
    return { error: `Those two components make “${surname}”, not “${requestedSurname}”. Run auto-detect or adjust the component words.` };
  }
  const traits = new Set(eligibleSurnameTraits(state.selected).map(trait => `${trait.type}:${trait.value}`));
  if (!traits.has(source1) || !traits.has(source2)) return { error: "A selected surname source no longer exists on this character." };
  const component = (text, source, componentOrder) => {
    const divider = source.indexOf(":");
    return {
      order: componentOrder,
      text,
      trait_category: source.slice(0, divider),
      trait_value: source.slice(divider + 1),
      source_raw: source,
      confidence: "confirmed"
    };
  };
  return { first, surname, japanese: false, order, join_style: joinStyle, components: [component(component1, source1, 1), component(component2, source2, 2)] };
}

function updateFullNameEditPreview() {
  const parsed = fullNameEditorValue();
  const currentFirst = effectivePartValue(state.selected, "first");
  const currentSurname = effectiveSurname(state.selected);
  const record = recordFor(state.selected.id);
  const firstLocked = partReview(state.selected.id, "first").decision === "approve";
  const surnameLocked = ["surname_part_1", "surname_part_2"].some(key => partReview(state.selected.id, key).decision === "approve");
  const confirmedRepair = els.fullNameEditForm.dataset.repairingCollapsed === "true";
  const error = parsed.error ||
    (parsed.first.toLowerCase() !== currentFirst.toLowerCase() && manualFirstNameUsage(parsed.first)
      ? `First name “${parsed.first}” is already used by another character.`
      : firstLocked && parsed.first !== currentFirst
        ? "The first name is greenlit. Unlock it before changing it."
        : surnameLocked && parsed.surname !== currentSurname && !confirmedRepair
          ? "A surname component is greenlit. Unlock it before changing the structured surname."
      : fullNameAlreadyUsed(parsed.first, parsed.surname)
        ? "That complete full name is already used by another character."
        : "");
  els.fullNameEditFirstInput.classList.toggle("invalid", Boolean(error));
  els.fullNameEditFirst.textContent = parsed.first || "—";
  els.fullNameEditSurname.textContent = parsed.surname || "—";
  els.fullNameEditSeamLabel.textContent = parsed.japanese
    ? "Atomic Japanese surname"
    : parsed.components?.length === 2
      ? `${parsed.components[parsed.order === "21" ? 1 : 0].source_raw} + ${parsed.components[parsed.order === "21" ? 0 : 1].source_raw}`
      : "Two source traits required";
  els.fullNameEditStatus.textContent = error || (
    parsed.first === currentFirst && parsed.surname === currentSurname && !needsSurnameComponentRepair(state.selected)
      ? "This matches the current live name and its surname sources are structured."
      : needsSurnameComponentRepair(state.selected)
        ? parsed.preserve_unresolved_surname
          ? "The surname remains visibly unchanged and unresolved. You may save a first-name-only edit, or add both confirmed surname sources."
          : "Visible name preserved. Choose the two confirmed source traits and component words to repair the audit record."
        : "Ready to save as one atomic structured name update."
  );
  els.fullNameEditStatus.classList.toggle("error", Boolean(error));
  els.fullNameEditSave.disabled = Boolean(error) ||
    (parsed.first === currentFirst && parsed.surname === currentSurname &&
      (!needsSurnameComponentRepair(state.selected) || parsed.preserve_unresolved_surname));
  return error ? null : parsed;
}

function openFullNameEditor() {
  if (!state.selected) return;
  const character = state.selected;
  const normalized = normalizedSurnameFor(character);
  const japanese = effectiveSurnameLanguage(character) === "japanese";
  const sources = eligibleSurnameTraits(character).map(trait => `${trait.type}:${trait.value}`);
  const options = `<option value="">Choose exact trait…</option>` + sources.map(source => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("");
  els.fullNameEditSource1.innerHTML = options;
  els.fullNameEditSource2.innerHTML = options;
  els.fullNameEditFirstInput.value = effectivePartValue(character, "first");
  els.fullNameEditSurnameInput.value = effectiveSurname(character);
  els.fullNamePasteInput.value = effectiveDisplayName(character);
  els.fullNameEditForm.dataset.surnameLanguage = japanese ? "japanese" : "western";
  els.fullNameEditForm.dataset.order = surnameOrder(character);
  els.fullNameEditForm.dataset.joinStyle = normalized.surname_join_style || "lower_second";
  els.fullNameEditForm.dataset.repairingCollapsed = "false";
  els.fullNameEditForm.classList.toggle("single-surname-mode", japanese);
  const components = normalized.surname_components || [];
  els.fullNameEditComponent1.value = components.find(component => Number(component.order) === 1)?.text || "";
  els.fullNameEditComponent2.value = components.find(component => Number(component.order) === 2)?.text || "";
  els.fullNameEditSource1.value = components.find(component => Number(component.order) === 1)?.source_raw || "";
  els.fullNameEditSource2.value = components.find(component => Number(component.order) === 2)?.source_raw || "";
  els.fullNameEditSurnameInput.readOnly = false;
  const autoRepair = state.surnameRepairIndex?.[String(character.id)];
  els.fullNameDetectStatus.classList.remove("error", "success");
  els.fullNameDetectStatus.textContent = autoRepair
    ? `Auto-detected ${autoRepair.surname_components[0].text} + ${autoRepair.surname_components[1].text} from ${autoRepair.surname_components[0].source_raw} + ${autoRepair.surname_components[1].source_raw}.${autoRepair.corrects_current_display ? ` The broken “${autoRepair.current_display}” preview is corrected to “${autoRepair.surname_display}”.` : " Confirm and save the recovered structure."}`
    : "Paste the complete two-word name from ChatGPT. Name Studio will recover the two surname words and exact traits.";
  updateFullNameEditPreview();
  els.fullNameEditDialog.showModal();
  if (autoRepair) {
    applySurnameRepairProposal(autoRepair);
  } else if (!japanese) {
    requestSurnameDetection({ quiet: true, onlyIfRepair: true });
  }
  requestAnimationFrame(() => {
    els.fullNamePasteInput.focus();
    els.fullNamePasteInput.setSelectionRange(0, els.fullNamePasteInput.value.length);
  });
}

async function saveFullNameEdit(event) {
  event.preventDefault();
  const parsed = updateFullNameEditPreview();
  if (!parsed) return;
  const character = state.selected;
  const currentFirst = effectivePartValue(character, "first");
  const currentSurname = effectiveSurname(character);
  const timestamp = nowIso();
  const record = ensureRecord(character.id);
  if (parsed.first !== currentFirst) {
    if (state.cloudAuthenticated) {
      const response = await fetch(`/api/first-name-availability?value=${encodeURIComponent(parsed.first)}&except_id=${encodeURIComponent(character.id)}`);
      const availability = await response.json();
      if (!response.ok || !availability.available) {
        els.fullNameEditStatus.textContent = availability.error || `First name “${parsed.first}” is already used.`;
        els.fullNameEditStatus.classList.add("error");
        return;
      }
    }
    const current = partReview(character.id, "first");
    record.parts.first = {
      ...current,
      decision: "replace",
      scope: "this_character",
      disabled: false,
      replacement_value: parsed.first,
      replacement_source: "Direct full-name edit · Western clothing theme",
      replacement_trait_source: `Clothing:${character.clothing || "No clothing trait"}`,
      replacement_language: "western",
      replacement_rationale: `Direct team edit of the full-name field for Surv!vor #${character.id}.`,
      replacement_scores: null,
      updated_at: timestamp,
      reviewer: state.curation.reviewer || current.reviewer || "",
      deleted_at: null
    };
  }
  if (parsed.surname !== currentSurname || (needsSurnameComponentRepair(character) && !parsed.preserve_unresolved_surname)) {
    const current1 = partReview(character.id, "surname_part_1");
    const current2 = partReview(character.id, "surname_part_2");
    if (parsed.japanese) {
      record.parts.surname_part_1 = { ...current1, decision: current1.decision || "replace", scope: current1.scope || "this_character", disabled: false, replacement_value: parsed.surname, replacement_source: "Manual team edit · atomic Japanese surname", replacement_trait_source: current1.replacement_trait_source || character.surname_source_1 || "Japanese surname bank", replacement_language: "japanese", replacement_rationale: `Direct team edit of the atomic Japanese surname for Surv!vor #${character.id}.`, replacement_scores: null, updated_at: timestamp, reviewer: state.curation.reviewer || current1.reviewer || "", deleted_at: null };
      record.parts.surname_part_2 = { ...current2, decision: current2.decision || "replace", scope: current2.scope || "this_character", disabled: true, updated_at: timestamp, reviewer: state.curation.reviewer || current2.reviewer || "", deleted_at: null };
    } else {
      const repairingApprovedCompound = (needsSurnameComponentRepair(character) ||
        els.fullNameEditForm.dataset.repairingCollapsed === "true") &&
        [current1, current2].some((part) => part.decision === "approve");
      parsed.components.forEach((component, index) => {
        const key = index === 0 ? "surname_part_1" : "surname_part_2";
        const current = index === 0 ? current1 : current2;
        record.parts[key] = {
          ...current,
          decision: repairingApprovedCompound ? "approve" : (current.decision || "replace"),
          scope: repairingApprovedCompound ? null : (current.scope || "this_character"),
          disabled: false,
          replacement_value: component.text,
          replacement_source: "Manual structured full-name edit",
          replacement_trait_source: component.source_raw,
          replacement_language: "western",
          replacement_rationale: `Confirmed semantic component ${index + 1} for ${component.source_raw}. Collector-visible surname: ${parsed.surname}.`,
          replacement_scores: null, updated_at: timestamp,
          reviewer: state.curation.reviewer || current.reviewer || "", deleted_at: null
        };
      });
    }
    record.surname_order = parsed.order;
    record.surname_order_updated_at = timestamp;
    record.surname_join_style = parsed.join_style || "lower_second";
    record.surname_format_version = SURNAME_FORMAT_VERSION;
    record.surname_join_style_updated_at = timestamp;
    record.normalized_name = {
      first_name: parsed.first,
      surname_display: parsed.surname,
      surname_components: parsed.components,
      surname_join_style: parsed.join_style || "lower_second",
      surname_format_version: SURNAME_FORMAT_VERSION,
      derivation_method: parsed.japanese ? "manual_atomic_japanese" : "manual_structured",
      needs_surname_component_repair: false
    };
    record.normalized_name_updated_at = timestamp;
    delete state.surnameRepairIndex[String(character.id)];
  }
  if (parsed.first !== currentFirst && record.normalized_name) {
    record.normalized_name = { ...record.normalized_name, first_name: parsed.first };
    record.normalized_name_updated_at = timestamp;
  }
  record.updated_at = timestamp;
  saveCuration();
  renderCharacter();
  updateProgress();
  renderRoster();
  els.fullNameEditDialog.close();
  showToast(`Saved edited name ${effectiveDisplayName(character)}.`, "success");
}

function liveSurnameRationale(character) {
  const part1 = effectivePartValue(character, "surname_part_1");
  const part2 = effectivePartValue(character, "surname_part_2");
  const source1 = effectivePartSource(character, "surname_part_1");
  const source2 = effectivePartSource(character, "surname_part_2");
  const surname = effectiveSurname(character);
  if (!part2) {
    return `“${part1 || surname}” is the selected one-word surname from ${source1 || source2 || "the reviewed surname bank"}.`;
  }
  const ordered = surnameOrder(character) === "21"
    ? `“${part2}” first, then “${part1}”`
    : `“${part1}” first, then “${part2}”`;
  const style = surnameJoinStyle(character) === "lower_second"
    ? "with a lowercase second fragment for metadata readability"
    : "with both trait fragments capitalized";
  return `“${part1}” represents ${source1}; “${part2}” represents ${source2}. ` +
    `The live surname is “${surname}”, ordered ${ordered}, ${style}.`;
}

function surnameComponentUsage(part) {
  if (!part?.value || !part.key.startsWith("surname_") || !state.data) {
    return { total: 0, rejected: 0, global: 0 };
  }
  const target = part.value.casefold?.() || part.value.toLowerCase();
  let total = 0;
  let rejected = 0;
  let global = 0;
  state.data.characters.forEach(character => {
    partDefinitions(character)
      .filter(candidate =>
        candidate.available &&
        candidate.key.startsWith("surname_") &&
        effectivePartValue(character, candidate.key).toLowerCase() === target
      )
      .forEach(candidate => {
        total++;
        const review = partReview(character.id, candidate.key);
        if (review.decision === "replace" && !review.replacement_value) {
          rejected++;
          if (review.scope === "all_exact_matches") global++;
        }
      });
  });
  return { total, rejected, global };
}

function firstNameUsage(value) {
  const target = String(value || "").trim().toLowerCase();
  if (!target || !state.data) return { total: 0, characterIds: [] };
  const characterIds = state.data.characters
    .filter(character =>
      effectivePartValue(character, "first").toLowerCase() === target
    )
    .map(character => character.id);
  return { total: characterIds.length, characterIds };
}

function firstNameUsageText(value) {
  const usage = firstNameUsage(value);
  if (!usage.total) return "Not currently used elsewhere";
  if (usage.total === 1) return "Used 1× collection-wide · unique first name";
  return `Duplicate alert · used ${usage.total.toLocaleString()}× on survivors ${usage.characterIds
    .slice(0, 6)
    .map(id => `#${id}`)
    .join(", ")}${usage.characterIds.length > 6 ? "…" : ""}`;
}

function usageText(part) {
  const usage = surnameComponentUsage(part);
  if (!usage.total) return "";
  const reviewText = usage.rejected
    ? ` · red X on ${usage.rejected.toLocaleString()}/${usage.total.toLocaleString()} uses`
    : " · no red X marks";
  const globalText = usage.global
    ? ` · ${usage.global.toLocaleString()} retire-everywhere request${usage.global === 1 ? "" : "s"}`
    : "";
  return `Used ${usage.total.toLocaleString()}× collection-wide${reviewText}${globalText}`;
}

function curationStatus(character) {
  const available = partDefinitions(character).filter(part => part.available);
  const decisions = available.map(part => partReview(character.id, part.key).decision);
  const decided = decisions.filter(Boolean).length;
  const rejected = decisions.filter(value => value === "replace").length;
  if (!decided) {
    return { key: "untouched", label: "Untouched", decided, total: available.length, rejected };
  }
  if (decided < available.length) {
    return {
      key: rejected ? "partial-rejected" : "partial",
      label: rejected ? "Partial · has red X" : "Partially reviewed",
      decided,
      total: available.length,
      rejected
    };
  }
  if (rejected) {
    return {
      key: "complete-rejected",
      label: "Complete · replacement requested",
      decided,
      total: available.length,
      rejected
    };
  }
  return {
    key: "complete-approved",
    label: "Fully locked",
    decided,
    total: available.length,
    rejected
  };
}

function partBadge(part, decision) {
  const stateClass = decision === "approve" ? "approved" :
    decision === "replace" ? "rejected" : "pending";
  const mark = decision === "approve" ? "✓" :
    decision === "replace" ? "×" : "·";
  const title = decision === "approve" ? `${part.label}: locked` :
    decision === "replace" ? `${part.label}: replace` :
    part.available ? `${part.label}: not reviewed` : `${part.label}: not used`;
  return `<span class="decision-chip ${part.available ? stateClass : "na"}" title="${escapeHtml(title)}">
    <b>${escapeHtml(part.short)}</b><i>${part.available ? mark : "—"}</i>
  </span>`;
}

function searchable(character) {
  return [
    character.id,
    character.name,
    character.first,
    character.surname,
    character.v7_first,
    character.first_name_provenance,
    character.clothing,
    character.first_name_source,
    character.surname_source,
    character.surname_source_1,
    character.surname_source_2,
    character.surname_component_1,
    character.surname_component_2,
    ...character.traits.flatMap(trait => [trait.type, trait.value])
  ].join(" ").toLowerCase();
}

function matchesStatus(character, status) {
  if (!status) return true;
  const curation = curationStatus(character);
  if (status === "untouched") return curation.key === "untouched";
  if (status === "partial") return curation.key.startsWith("partial");
  if (status === "complete-approved") return curation.key === "complete-approved";
  if (status === "has-rejection") return curation.rejected > 0;
  if (status === "replacement-picked") {
    return PART_KEYS.some(key => Boolean(partReview(character.id, key).replacement_value));
  }
  if (status === "surname-repair") return needsSurnameComponentRepair(character);
  if (status === "needs-suggestion") {
    return PART_KEYS.some(key => {
      const review = partReview(character.id, key);
      return review.decision === "replace" && !review.replacement_value;
    });
  }
  if (status === "complete-rejected") return curation.key === "complete-rejected";
  if (status === "proposal") return character.surname_changed_from_v8;
  if (status === "first-online") {
    return (
      character.first_name_provenance?.includes("online") ||
      character.first_name_provenance === "ssa_curated_western_theme_mix"
    );
  }
  if (status === "first-theme") {
    return character.first_name_provenance === "artist_csv_theme_route";
  }
  if (status === "required") {
    return character.flags.some(flag => flag.level === "required");
  }
  if (status === "flagged") {
    return character.flags.some(flag => flag.level === "review");
  }
  return true;
}

function applyFilters() {
  const query = els.search.value.trim().toLowerCase();
  const clothing = els.clothingFilter.value;
  const traitType = els.traitTypeFilter.value;
  const traitValue = els.traitValueFilter.value;
  const mix = els.mixFilter.value;
  const firstLanguage = els.firstLanguageFilter.value;
  const surnameLanguage = els.surnameLanguageFilter.value;
  const status = els.statusFilter.value;
  state.filtered = state.data.characters.filter(character => {
    const effectiveFirst = effectiveFirstLanguage(character);
    const effectiveSurname = effectiveSurnameLanguage(character);
    const characterMix = `${effectiveFirst}+${effectiveSurname}`;
    return (
      (!query || searchable(character).includes(query)) &&
      (
        state.traitFilterMode === "clothing"
          ? (!clothing || character.clothing === clothing)
          : (!traitType || character.traits.some(trait =>
              trait.type === traitType && (!traitValue || trait.value === traitValue)
            ))
      ) &&
      (!mix || characterMix === mix) &&
      (!firstLanguage || effectiveFirst === firstLanguage) &&
      (!surnameLanguage || effectiveSurname === surnameLanguage) &&
      matchesStatus(character, status)
    );
  });
  state.page = 0;
  if (
    state.filtered.length &&
    !state.filtered.some(character => character.id === state.selected?.id)
  ) {
    state.selected = state.filtered[0];
    history.replaceState(null, "", `#${state.selected.id}`);
    renderCharacter();
  }
  renderRoster();
}

function renderRoster() {
  const pages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  const start = state.page * state.pageSize;
  const visible = state.filtered.slice(start, start + state.pageSize);
  els.roster.innerHTML = visible.map(character => {
    const active = state.selected?.id === character.id ? " active" : "";
    const status = curationStatus(character);
    const badges = partDefinitions(character)
      .map(part => partBadge(part, partReview(character.id, part.key).decision))
      .join("");
    return `<button class="roster-item status-${status.key}${active}" data-id="${character.id}">
      <img class="roster-thumb" src="/pfps_webp/${character.id}.webp" alt="" loading="lazy">
      <span class="roster-copy">
        <strong>${escapeHtml(effectiveDisplayName(character))}</strong>
        <small>#${character.id} · ${escapeHtml(character.clothing || "Special")}</small>
      </span>
      <span class="roster-decisions" aria-label="${escapeHtml(status.label)}">${badges}</span>
    </button>`;
  }).join("");
  els.resultCount.textContent = `${state.filtered.length.toLocaleString()} results`;
  els.pageCount.textContent = `${state.page + 1} / ${pages}`;
  els.pagePrev.disabled = state.page === 0;
  els.pageNext.disabled = state.page >= pages - 1;
  els.roster.querySelectorAll("[data-id]").forEach(button => {
    button.addEventListener("click", () => selectById(button.dataset.id));
  });
}

function updateProgress() {
  let totalParts = 0;
  let decidedParts = 0;
  let lockedParts = 0;
  let rejectedParts = 0;
  let completeCharacters = 0;
  let partialCharacters = 0;
  state.data.characters.forEach(character => {
    const status = curationStatus(character);
    totalParts += status.total;
    decidedParts += status.decided;
    rejectedParts += status.rejected;
    lockedParts += status.decided - status.rejected;
    if (status.key.startsWith("complete")) completeCharacters++;
    if (status.key.startsWith("partial")) partialCharacters++;
  });
  const percent = totalParts ? Math.round((decidedParts / totalParts) * 100) : 0;
  els.curationPercent.textContent = `${percent}%`;
  els.curationBar.style.width = `${percent}%`;
  els.curationCounts.innerHTML = `
    <span><b>${decidedParts.toLocaleString()}</b> / ${totalParts.toLocaleString()} parts</span>
    <span class="locked"><b>${lockedParts.toLocaleString()}</b> locked</span>
    <span class="rejected"><b>${rejectedParts.toLocaleString()}</b> red X</span>
    <span><b>${completeCharacters.toLocaleString()}</b> complete</span>
    <span><b>${partialCharacters.toLocaleString()}</b> partial</span>`;
}

function selectById(id) {
  const character = state.data.characters.find(item => item.id === String(id));
  if (!character) return;
  if (state.selected?.id !== character.id && els.suggestionDialog?.open) {
    els.suggestionDialog.close();
    state.suggestionPart = null;
    state.suggestionSource = null;
    state.suggestionPayload = null;
  }
  state.selected = character;
  if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  setMobileRoster(false);
  renderCharacter();
  renderRoster();
  if (state.cloudAuthenticated && !state.surnameRepairIndex[String(character.id)]) {
    loadSelectedSurnameRepair(character);
  }
}

function renderDecisionControls(character) {
  partDefinitions(character).forEach(part => {
    const container = document.querySelector(`[data-part-control="${part.key}"]`);
    if (!container) return;
    container.hidden = !part.available;
    const review = partReview(character.id, part.key);
    container.dataset.state = review.decision || "unreviewed";
    container.querySelectorAll("[data-decision]").forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.decision === review.decision
      );
    });
  });
}

function renderReplacementBriefs(character) {
  const rejected = partDefinitions(character).filter(part =>
    part.available && partReview(character.id, part.key).decision === "replace"
  );
  els.replacementBriefs.hidden = rejected.length === 0;
  els.replacementBriefList.innerHTML = rejected.map(part => {
    const review = partReview(character.id, part.key);
    const liveUsage = part.key === "first"
      ? firstNameUsage(part.value)
      : surnameComponentUsage(part);
    const usage = liveUsage.total > 1
      ? ` (${liveUsage.total.toLocaleString()} current uses)`
      : "";
    const usageCopy = part.key === "first"
      ? firstNameUsageText(part.value)
      : usageText(part);
    return `<article class="replacement-brief" data-replacement-part="${part.key}">
      <div class="replacement-value">
        <span>${review.replacement_value ? "Original " : ""}${escapeHtml(part.label)}</span>
        <strong>${escapeHtml(part.value || "—")}</strong>
        <small>${escapeHtml(part.source || "No source")}</small>
        <em class="replacement-usage">${escapeHtml(usageCopy)}</em>
        <div class="replacement-tools">
          <button class="find-replacement-button" data-find-replacement="${part.key}">
            ${review.replacement_value ? "Change selected option" : "Find fitting options"}
          </button>
          ${review.replacement_value || review.disabled ? `<div class="chosen-replacement">
            Selected now: <b>${review.disabled ? "Removed · one-word surname mode" : escapeHtml(review.replacement_value)}</b><br>
            ${escapeHtml(review.replacement_trait_source || review.replacement_source || "Curated bank")}<br>
            Full name: <b>${escapeHtml(effectiveDisplayName(character))}</b>
          </div>` : ""}
        </div>
      </div>
      <fieldset>
        <legend>Replacement scope</legend>
        <label>
          <input type="radio" name="scope-${part.key}" value="this_character"
            ${review.scope !== "all_exact_matches" ? "checked" : ""}>
          <span><b>Only survivor #${character.id}</b><small>Keep this value available for other characters.</small></span>
        </label>
        <label>
          <input type="radio" name="scope-${part.key}" value="all_exact_matches"
            ${review.scope === "all_exact_matches" ? "checked" : ""}>
          <span><b>Retire “${escapeHtml(part.value)}” everywhere${usage}</b><small>Replace every exact use of this value or component.</small></span>
        </label>
      </fieldset>
      <label class="replacement-note">
        <span>Replacement note</span>
        <textarea rows="2" data-replacement-note="${part.key}"
          placeholder="Optional: why it fails, preferred direction, or a suggested replacement…">${escapeHtml(review.note || "")}</textarea>
      </label>
    </article>`;
  }).join("");
  els.replacementBriefList.querySelectorAll('input[type="radio"]').forEach(input => {
    input.addEventListener("change", () => {
      updatePartReview(
        input.name.replace("scope-", ""),
        { scope: input.value },
        false
      );
    });
  });
  els.replacementBriefList.querySelectorAll("[data-replacement-note]").forEach(textarea => {
    textarea.addEventListener("input", () => {
      const key = textarea.dataset.replacementNote;
      const record = ensureRecord(state.selected.id);
      const current = partReview(state.selected.id, key);
      record.parts[key] = {
        ...current,
        note: textarea.value,
        updated_at: nowIso(),
        reviewer: state.curation.reviewer || current.reviewer || ""
      };
      record.updated_at = record.parts[key].updated_at;
      saveCuration();
      updateProgress();
      renderRoster();
    });
  });
  els.replacementBriefList.querySelectorAll("[data-find-replacement]").forEach(button => {
    button.addEventListener("click", () => {
      openSuggestions(button.dataset.findReplacement);
    });
  });
}

function renderCharacterCuration(character) {
  const status = curationStatus(character);
  els.characterDecisionSummary.textContent =
    `${status.decided} of ${status.total} parts decided`;
  els.characterCurationState.textContent = status.label;
  els.characterCurationState.className = status.key;
  els.characterDecisionRail.innerHTML = partDefinitions(character)
    .map(part => partBadge(part, partReview(character.id, part.key).decision))
    .join("");
  els.approveRemainingButton.disabled = status.decided === status.total;
  els.replaceWholeButton.disabled = status.total === 0;
  els.clearCharacterButton.disabled = status.decided === 0 && !recordFor(character.id).note;
  els.reviewNote.value = recordFor(character.id).note || "";
  renderDecisionControls(character);
  renderReplacementBriefs(character);
}

function renderFocusDeck(character) {
  if (!character || !els.focusDeck) return;
  const list = state.filtered.length ? state.filtered : state.data.characters;
  const index = Math.max(0, list.findIndex(item => item.id === character.id));
  const status = curationStatus(character);
  els.focusPosition.textContent =
    `${(index + 1).toLocaleString()} / ${list.length.toLocaleString()}`;
  els.focusStatus.textContent = status.label;
  els.focusStatus.className = status.key;
  els.focusPortrait.src = `/pfps_webp/${character.id}.webp`;
  els.focusPortrait.alt = `Pixel portrait of ${effectiveDisplayName(character)}, survivor ${character.id}`;
  els.focusClothing.textContent = `${character.clothing || "Special"} · Surv!vor #${character.id}`;
  els.focusName.textContent = effectiveDisplayName(character);
  els.focusMix.textContent =
    `${effectiveFirstLanguage(character)} first · ${effectiveSurnameLanguage(character)} surname · ${status.decided}/${status.total} parts decided`;
  els.focusFlipButton.hidden = !canFlipSurname(character);
  if (canFlipSurname(character)) {
    const nextFirst = effectivePartValue(
      character,
      surnameOrder(character) === "12" ? "surname_part_2" : "surname_part_1"
    );
    els.focusFlipButton.textContent =
      `⇄ Put ${nextFirst || "other trait"} first`;
    els.focusFlipButton.setAttribute(
      "aria-label",
      `Save surname order with ${nextFirst || "the other trait"} first`
    );
  }

  els.focusParts.innerHTML = partDefinitions(character)
    .filter(part => part.available)
    .map(part => {
      const review = partReview(character.id, part.key);
      const effective = effectivePartValue(character, part.key);
      const proposed = review.disabled
        ? `<small>Removed · the other surname part stands alone</small>`
        : review.replacement_value
        ? `<small>Selected replacement · ${escapeHtml(review.replacement_source || "curated bank")}</small>`
        : `<small>${escapeHtml(part.source || "No source")}</small>`;
      const liveUsage = part.key === "first"
        ? firstNameUsageText(effective)
        : usageText({ ...part, value: effective });
      return `<article class="focus-part" data-state="${review.decision || "unreviewed"}">
        <div>
          <span class="focus-part-label"><i></i>${escapeHtml(part.label)}</span>
          <strong>${escapeHtml(effective || "—")}</strong>
          ${proposed}
          <small class="${part.key === "first" && firstNameUsage(effective).total > 1 ? "duplicate-usage" : ""}">
            ${escapeHtml(liveUsage)}
          </small>
        </div>
        <div class="focus-part-actions">
          <button class="approve ${review.decision === "approve" ? "active" : ""}"
            data-focus-part="${part.key}" data-focus-decision="approve"
            aria-label="Lock ${escapeHtml(part.label)}">✓ Lock</button>
          <button class="replace ${review.decision === "replace" ? "active" : ""}"
            data-focus-part="${part.key}" data-focus-decision="replace"
            aria-label="Replace ${escapeHtml(part.label)}">× Replace</button>
          <button class="suggest" data-focus-suggest="${part.key}"
            aria-label="Find fitting options for ${escapeHtml(part.label)}">Ideas</button>
        </div>
      </article>`;
    })
    .join("");

  els.focusParts.querySelectorAll("[data-focus-decision]").forEach(button => {
    button.addEventListener("click", () => {
      const key = button.dataset.focusPart;
      const decision = button.dataset.focusDecision;
      const current = partReview(state.selected.id, key).decision;
      setPartDecision(key, current === decision ? "clear" : decision);
    });
  });
  els.focusParts.querySelectorAll("[data-focus-suggest]").forEach(button => {
    button.addEventListener("click", () => {
      const key = button.dataset.focusSuggest;
      if (partReview(state.selected.id, key).decision !== "replace") {
        updatePartReview(key, {
          decision: "replace",
          scope: "this_character"
        });
      }
      openSuggestions(key);
    });
  });
}

function renderCharacter() {
  const c = state.selected;
  const liveFirstReview = partReview(c.id, "first");
  els.tokenId.textContent = `Surv!vor #${c.id}`;
  els.languageMix.textContent =
    `${effectiveFirstLanguage(c)} first / ${effectiveSurnameLanguage(c)} surname`;
  els.portrait.src = `/pfps_webp/${c.id}.webp`;
  els.portrait.alt = `Pixel portrait of ${c.display_name}, survivor ${c.id}`;
  els.portraitError.hidden = true;
  els.clothingEyebrow.textContent = c.clothing || "Official one-of-one";
  const previewName = effectiveDisplayName(c);
  els.characterName.textContent = previewName;
  els.characterName.title = previewName !== c.display_name
    ? `Original: ${c.display_name}` : "";
  const repairNeeded = needsSurnameComponentRepair(c);
  els.surnameRepairBanner.hidden = !repairNeeded;
  els.firstName.textContent = effectivePartValue(c, "first") || "—";
  els.surname.textContent = effectiveSurname(c) || "—";
  els.surnameFlipButton.hidden = !canFlipSurname(c);
  if (canFlipSurname(c)) {
    const nextFirst = effectivePartValue(
      c,
      surnameOrder(c) === "12" ? "surname_part_2" : "surname_part_1"
    );
    els.surnameFlipButton.textContent =
      `⇄ Put ${nextFirst || "other trait"} first`;
    els.surnameFlipButton.setAttribute(
      "aria-label",
      `Save surname order with ${nextFirst || "the other trait"} first`
    );
  }
  els.firstLanguage.textContent =
    liveFirstReview.replacement_value
      ? languageLabel(effectiveFirstLanguage(c))
      : c.first_name_provenance === "sensitivity_review_replacement" ? "Sensitivity-reviewed theme" :
        c.first_name_provenance === "iconic_animal_reference" ? "Animal character reference" :
        c.first_name_provenance === "curated_animal_theme" ? "Western animal theme" :
        c.first_name_provenance === "museum_artist_reference" ? "Museum artist reference" :
        c.first_name_provenance === "swimmer_champion_reference" ? "Champion swimmer reference" :
        c.first_name_provenance === "curated_aquatic_theme" ? "Aquatic clothing theme" :
        c.first_name_provenance === "ssa_curated_western_theme_mix" ? "Western theme + SSA" :
        c.first_name_provenance === "online_theme_replacement" ? "Online theme + SSA" :
        c.first_name_provenance?.startsWith("ssa_online") ? "SSA verified" :
        c.first_name_language === "japanese" ? "Artist Japanese CSV" :
        languageLabel(c.first_name_language);
  els.surnameLanguage.textContent = languageLabel(effectiveSurnameLanguage(c));
  els.firstRationale.textContent =
    liveFirstReview.replacement_rationale || c.first_rationale;
  els.surnameRationale.textContent = liveSurnameRationale(c);
  els.firstTheme.textContent = c.clothing || "Hand-authored special";
  els.firstGenderRoute.textContent = c.gender_from_body || "Special";
  els.firstEvidence.textContent =
    liveFirstReview.replacement_value
      ? `Live replacement · ${liveFirstReview.replacement_trait_source || `Clothing:${c.clothing}`}`
      : c.first_name_provenance === "sensitivity_review_replacement" ? "Collection-wide language and context safety review" :
        c.first_name_provenance === "iconic_animal_reference" ? "Official character reference layer" :
        c.first_name_provenance === "curated_animal_theme" ? "Direct animal, habitat, or behavior imagery" :
        c.first_name_provenance === "museum_artist_reference" ? "Official museum artist index" :
        c.first_name_provenance === "swimmer_champion_reference" ? "Swimming Hall of Fame reference layer" :
        c.first_name_provenance === "curated_aquatic_theme" ? "Direct swimming, water, coast, or pool imagery" :
        c.first_name_provenance === "ssa_curated_western_theme_mix" ? "Curated Western theme + SSA record" :
        c.first_name_provenance === "online_theme_replacement" ? "Curated online theme source" :
        c.first_name_provenance?.startsWith("ssa_online") ? "SSA-recorded name" :
        c.first_name_language === "japanese" ? "Exact artist CSV entry" :
        c.first_name_language === "western" ? "Curated clothing bank entry" :
        "Awaiting hand-authored name";
  els.firstSource.textContent = liveFirstReview.replacement_value
    ? [
        liveFirstReview.replacement_source,
        liveFirstReview.replacement_trait_source
      ].filter(Boolean).join(" · ")
    : [c.first_name_source, c.first_name_source_detail]
        .filter(Boolean).join(" · ");
  const liveFirst = effectivePartValue(c, "first");
  const liveFirstUsage = firstNameUsage(liveFirst);
  els.firstNameUsage.textContent = firstNameUsageText(liveFirst);
  els.firstNameUsage.classList.toggle("duplicate", liveFirstUsage.total > 1);

  const detail = c.surname_detail || {};
  const source1 = effectivePartSource(c, "surname_part_1");
  const source2 = effectivePartSource(c, "surname_part_2");
  const livePart1 = effectivePartValue(c, "surname_part_1");
  const livePart2 = effectivePartValue(c, "surname_part_2");
  const review1 = partReview(c.id, "surname_part_1");
  const review2 = partReview(c.id, "surname_part_2");
  const [type1, trait1] = splitSource(source1);
  const [type2, trait2] = splitSource(source2);
  els.surnameType1.textContent = type1;
  els.surnameTrait1.textContent = trait1 || "—";
  els.surnameComponent1.textContent = livePart1 || "—";
  els.surnameComponentNote1.textContent = review1.replacement_value
    ? `Selected replacement${review1.replacement_trait_source && review1.replacement_trait_source !== (detail.source_1 || c.surname_source_1) ? " from another character trait" : ""}`
    : detail.component_1_note || "";
  const surnameParts = Object.fromEntries(
    partDefinitions(c).map(part => [part.key, part])
  );
  const liveUsagePart1 = { ...surnameParts.surname_part_1, value: livePart1 };
  const usage1 = surnameComponentUsage(liveUsagePart1);
  els.surnameComponentCount1.textContent = usageText(liveUsagePart1);
  els.surnameComponentCount1.classList.toggle("has-rejections", usage1.rejected > 0);
  els.surnameType2.textContent = type2;
  els.surnameTrait2.textContent = trait2 || "—";
  els.surnameComponent2.textContent = livePart2 || "—";
  els.surnameComponentNote2.textContent = review2.replacement_value
    ? `Selected replacement${review2.replacement_trait_source && review2.replacement_trait_source !== (detail.source_2 || c.surname_source_2) ? " from another character trait" : ""}`
    : detail.component_2_note || "";
  const liveUsagePart2 = { ...surnameParts.surname_part_2, value: livePart2 };
  const usage2 = surnameComponentUsage(liveUsagePart2);
  els.surnameComponentCount2.textContent = usageText(liveUsagePart2);
  els.surnameComponentCount2.classList.toggle("has-rejections", usage2.rejected > 0);
  const secondDefinition = partDefinitions(c).find(part => part.key === "surname_part_2");
  const hasSecondSurnamePart = Boolean(secondDefinition?.available && !review2.disabled && livePart2);
  els.surnameFusionOperator.hidden = !hasSecondSurnamePart;
  els.surnameFusionPart2.hidden = !hasSecondSurnamePart;
  els.surnameRecipe.classList.toggle("single-surname", !hasSecondSurnamePart);
  els.surnameRestoreButton.hidden = hasSecondSurnamePart || !c.surname;
  if (!els.surnameRestoreButton.hidden) {
    els.surnameRestoreButton.textContent = review2.disabled || secondDefinition?.value
      ? "+ Restore two-part surname"
      : "+ Build two-part surname";
  }
  const scoredReviews = [review1, review2]
    .filter(review => review.replacement_scores)
    .sort((left, right) => timestamp(right.updated_at) - timestamp(left.updated_at));
  const selectedScores = scoredReviews[0]?.replacement_scores;
  const score = selectedScores
    ? (Number(selectedScores.readability || 0) + Number(selectedScores.collectability || 0)) / 2
    : Number(detail.score || 0);
  els.surnameRecipe.hidden = !detail.source_1;
  els.surnameScoring.hidden = !score;
  els.surnameScoreLabel.textContent = selectedScores
    ? "Selected preview · readability / collectability"
    : "Original internal surname score";
  els.surnameScore.textContent = selectedScores
    ? `${Number(selectedScores.readability).toFixed(1)} / ${Number(selectedScores.collectability).toFixed(1)}`
    : score ? `${score.toFixed(2)} / 10` : "—";
  els.surnameScoreBar.style.width = `${Math.max(0, Math.min(100, score * 10))}%`;
  els.surnameSource.textContent = source2
    ? `${surnameOrder(c) === "21" ? "trait 2 placed first" : "trait 1 placed first"} · live sources: ${source1} + ${source2}`
    : `live source: ${source1 || c.surname_source || "Hand-authored special"}`;

  els.traits.innerHTML = c.traits.map(trait =>
    `<div class="trait"><span>${escapeHtml(trait.type)}</span><strong>${escapeHtml(trait.value)}</strong></div>`
  ).join("");
  els.flags.innerHTML = c.flags.length ? c.flags.map(flag =>
    `<div class="flag ${flag.level}">${escapeHtml(flag.text)}</div>`
  ).join("") : `<div class="flag">No automated issues. Review the portrait and name together.</div>`;

  els.firstProposal.hidden = !c.first_changed_from_v7;
  if (c.first_changed_from_v7) {
    els.firstProposalOld.textContent = c.v7_first;
    els.firstProposalNew.textContent = c.first;
    els.firstProposalReason.textContent =
      `${c.first_name_fit_type || "curatorial"} fit · ${c.first_name_source_detail || c.first_name_source}`;
  }
  els.proposal.hidden = !c.surname_changed_from_v8;
  if (c.surname_changed_from_v8) {
    els.proposalOld.textContent = c.v8_surname;
    els.proposalNew.textContent = effectiveSurname(c);
    els.proposalReason.textContent = liveSurnameRationale(c);
  }

  renderCharacterCuration(c);
  renderFocusDeck(c);
  updateVoiceWorkspace();
}

function moveSelection(direction) {
  const list = state.filtered.length ? state.filtered : state.data.characters;
  let index = list.findIndex(item => item.id === state.selected.id);
  index = (index + direction + list.length) % list.length;
  selectById(list[index].id);
  state.page = Math.floor(index / state.pageSize);
  renderRoster();
}

function nextUndecided() {
  const preferred = state.filtered.length ? state.filtered : state.data.characters;
  const orderedLists = [preferred];
  if (preferred !== state.data.characters) orderedLists.push(state.data.characters);
  for (const list of orderedLists) {
    const current = Math.max(0, list.findIndex(item => item.id === state.selected?.id));
    for (let offset = 1; offset <= list.length; offset++) {
      const character = list[(current + offset) % list.length];
      const status = curationStatus(character);
      if (status.decided < status.total) {
        selectById(character.id);
        state.page = Math.floor(list.indexOf(character) / state.pageSize);
        renderRoster();
        return;
      }
    }
  }
  showToast("Every available part in this view is decided.", "success");
}

function updatePartReview(key, patch, rerender = true) {
  const record = ensureRecord(state.selected.id);
  const current = partReview(state.selected.id, key);
  const next = {
    ...current,
    ...patch,
    updated_at: nowIso(),
    reviewer: state.curation.reviewer || current.reviewer || "",
    deleted_at: null
  };
  record.parts[key] = next;
  record.updated_at = next.updated_at;
  saveCuration();
  if (rerender) renderCharacter();
  else renderCharacterCuration(state.selected);
  updateProgress();
  renderRoster();
}

function setSurnameOrder(order, { rerender = true, announce = true } = {}) {
  if (!canFlipSurname(state.selected)) return;
  const record = ensureRecord(state.selected.id);
  const timestamp = nowIso();
  record.surname_order = order === "21" ? "21" : "12";
  record.surname_order_updated_at = timestamp;
  record.updated_at = timestamp;
  saveCuration();
  if (rerender) renderCharacter();
  updateProgress();
  renderRoster();
  if (announce) {
    showToast(
      `Surname order changed to ${effectiveSurname(state.selected)}. The two trait sources remain unchanged.`,
      "success"
    );
  }
}

function toggleSurnameOrder(options) {
  setSurnameOrder(surnameOrder(state.selected) === "12" ? "21" : "12", options);
}

function setSurnameJoinStyle(style, { rerender = true, announce = true } = {}) {
  const record = ensureRecord(state.selected.id);
  const timestamp = nowIso();
  record.surname_join_style = style === "lower_second" ? "lower_second" : "camel";
  record.surname_format_version = SURNAME_FORMAT_VERSION;
  record.surname_join_style_updated_at = timestamp;
  record.updated_at = timestamp;
  saveCuration();
  if (rerender) renderCharacter();
  updateProgress();
  renderRoster();
  if (announce) {
    showToast(
      record.surname_join_style === "lower_second"
        ? `Using metadata-clean lowercase joining: ${effectiveSurname(state.selected)}.`
        : `Using capitalized trait joining: ${effectiveSurname(state.selected)}.`,
      "success"
    );
  }
}

function keepOnlySurnamePart(keepKey, { replacement = null, closeDialog = true } = {}) {
  const otherKey = keepKey === "surname_part_1" ? "surname_part_2" : "surname_part_1";
  const record = ensureRecord(state.selected.id);
  const timestamp = nowIso();
  const other = partReview(state.selected.id, otherKey);
  record.parts[otherKey] = {
    ...other,
    decision: "replace",
    scope: "this_character",
    disabled: true,
    note: other.note || "Removed to use a single-word surname.",
    replacement_rationale:
      `Disabled for Surv!vor #${state.selected.id} so the other exact surname selection stands alone.`,
    updated_at: timestamp,
    reviewer: state.curation.reviewer || other.reviewer || "",
    deleted_at: null
  };
  if (replacement) {
    const current = partReview(state.selected.id, keepKey);
    record.parts[keepKey] = {
      ...current,
      decision: "replace",
      scope: current.scope || "this_character",
      disabled: false,
      ...replacement,
      updated_at: timestamp,
      reviewer: state.curation.reviewer || current.reviewer || "",
      deleted_at: null
    };
  } else {
    const kept = partReview(state.selected.id, keepKey);
    record.parts[keepKey] = {
      ...kept,
      disabled: false,
      updated_at: timestamp,
      reviewer: state.curation.reviewer || kept.reviewer || "",
      deleted_at: null
    };
  }
  record.updated_at = timestamp;
  saveCuration();
  renderCharacter();
  updateProgress();
  renderRoster();
  if (closeDialog) els.suggestionDialog.close();
  showToast(`Saved one-word surname ${effectiveSurname(state.selected)}.`, "success");
}

function restoreTwoPartSurname() {
  const character = state.selected;
  if (!character?.surname) return;
  const record = ensureRecord(character.id);
  const timestamp = nowIso();
  const definitions = partDefinitions(character);
  const disabledKey = ["surname_part_1", "surname_part_2"]
    .find(key => partReview(character.id, key).disabled);
  const restoreKey = disabledKey || "surname_part_2";
  const current = partReview(character.id, restoreKey);
  record.parts[restoreKey] = {
    ...current,
    decision: current.replacement_value ? "replace" : current.decision || "replace",
    scope: current.scope || "this_character",
    disabled: false,
    note: current.note === "Removed to use a single-word surname." ? "" : current.note,
    replacement_rationale: current.replacement_value
      ? current.replacement_rationale
      : `Restored as an active second surname component for Surv!vor #${character.id}.`,
    updated_at: timestamp,
    reviewer: state.curation.reviewer || current.reviewer || "",
    deleted_at: null
  };
  record.updated_at = timestamp;
  saveCuration();
  renderCharacter();
  updateProgress();
  renderRoster();
  const restoredValue = effectivePartValue(character, restoreKey);
  if (restoredValue) {
    showToast(`Restored two-part surname ${effectiveSurname(character)}.`, "success");
    return;
  }
  const definition = definitions.find(part => part.key === restoreKey);
  openSuggestions(restoreKey, "western", current.replacement_trait_source || definition?.source || null);
  showToast("Choose a Western trait fragment to complete the two-part surname.", "success");
}

function setPartDecision(key, decision) {
  if (decision === "clear") {
    const record = ensureRecord(state.selected.id);
    const timestamp = nowIso();
    record.parts[key] = {
      ...blankPart(),
      updated_at: timestamp,
      deleted_at: timestamp,
      reviewer: state.curation.reviewer || ""
    };
    record.updated_at = timestamp;
    pruneRecord(state.selected.id);
    saveCuration();
    renderCharacter();
    updateProgress();
    renderRoster();
    return;
  }
  updatePartReview(key, {
    decision,
    scope: decision === "replace" ? (partReview(state.selected.id, key).scope || "this_character") : null
  });
}

function approveRemaining() {
  const record = ensureRecord(state.selected.id);
  const timestamp = nowIso();
  partDefinitions(state.selected)
    .filter(part => part.available && !partReview(state.selected.id, part.key).decision)
    .forEach(part => {
      record.parts[part.key] = {
        ...blankPart(),
        decision: "approve",
        updated_at: timestamp,
        reviewer: state.curation.reviewer || ""
      };
    });
  record.updated_at = timestamp;
  saveCuration();
  renderCharacter();
  updateProgress();
  renderRoster();
}

function approveRemainingAndNext() {
  approveRemaining();
  moveSelection(1);
}

function replaceWholeName() {
  const record = ensureRecord(state.selected.id);
  const timestamp = nowIso();
  partDefinitions(state.selected)
    .filter(part => part.available)
    .forEach(part => {
      const current = partReview(state.selected.id, part.key);
      record.parts[part.key] = {
        ...current,
        decision: "replace",
        scope: current.scope || "this_character",
        updated_at: timestamp,
        reviewer: state.curation.reviewer || current.reviewer || ""
      };
    });
  record.updated_at = timestamp;
  saveCuration();
  renderCharacter();
  updateProgress();
  renderRoster();
}

function clearCharacter() {
  if (!isRecordTouched(recordFor(state.selected.id))) return;
  if (!window.confirm(`Clear all saved decisions and notes for survivor #${state.selected.id}?`)) return;
  const timestamp = nowIso();
  state.curation.records[state.selected.id] = {
    note: "",
    note_updated_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp,
    parts: {}
  };
  saveCuration();
  renderCharacter();
  updateProgress();
  renderRoster();
}

function requestedAction(part, review) {
  if (review.decision === "approve") return "lock_exact_current_value";
  if (review.decision === "replace" && review.scope === "all_exact_matches") {
    return "replace_all_exact_matches";
  }
  if (review.decision === "replace") return "replace_for_this_character_only";
  return "leave_unchanged";
}

function exportRecord(character) {
  const record = recordFor(character.id);
  const parts = {};
  partDefinitions(character).forEach(part => {
    const review = partReview(character.id, part.key);
    parts[part.key] = {
      label: part.label,
      available: part.available,
      current_value: part.value,
      source: part.source,
      usage_count: part.usage_count || null,
      decision: review.decision,
      requested_action: requestedAction(part, review),
      scope: review.decision === "replace" ? (review.scope || "this_character") : null,
      note: review.note || "",
      selected_replacement: review.replacement_value || null,
      replacement_source: review.replacement_source || "",
      replacement_trait_source: review.replacement_trait_source || "",
      replacement_language: review.replacement_language || "",
      replacement_rationale: review.replacement_rationale || "",
      replacement_scores: review.replacement_scores || null,
      disabled: Boolean(review.disabled),
      reviewer: review.reviewer || "",
      updated_at: review.updated_at
    };
  });
  const status = curationStatus(character);
  return {
    id: character.id,
    current_full_name: character.name,
    preview_full_name: effectiveDisplayName(character),
    clothing: character.clothing,
    character_note: record.note || "",
    surname_order: record.surname_order || "12",
    surname_order_updated_at: record.surname_order_updated_at || null,
    surname_join_style: surnameJoinStyle(character),
    surname_format_version: SURNAME_FORMAT_VERSION,
    surname_join_style_updated_at: record.surname_join_style_updated_at || null,
    normalized_name: record.normalized_name || normalizedSurnameFor(character),
    normalized_name_updated_at: record.normalized_name_updated_at || null,
    naming_assistant_history: record.naming_assistant_history || [],
    curation_status: status.key,
    decided_parts: status.decided,
    available_parts: status.total,
    parts
  };
}

function buildExportPayload() {
  const touchedCharacters = state.data.characters.filter(character =>
    isRecordTouched(recordFor(character.id))
  );
  let approved = 0;
  let replace = 0;
  let unmarkedInTouched = 0;
  touchedCharacters.forEach(character => {
    partDefinitions(character).filter(part => part.available).forEach(part => {
      const decision = partReview(character.id, part.key).decision;
      if (decision === "approve") approved++;
      else if (decision === "replace") replace++;
      else unmarkedInTouched++;
    });
  });
  return {
    schema_version: SCHEMA_VERSION,
    exported_at: nowIso(),
    reviewer: state.curation.reviewer || "",
    source_names_file: state.data.audit.source_names_file,
    collection_rows: state.data.audit.rows,
    policy: {
      unexported_characters: "leave_unchanged",
      unmarked_parts: "leave_unchanged",
      approved_parts: "lock_exact_current_value",
      replace_this_character: "change_only_the_listed_character",
      replace_all_exact_matches: "retire_the_exact_listed_value_everywhere"
    },
    summary: {
      touched_characters: touchedCharacters.length,
      untouched_characters: state.data.characters.length - touchedCharacters.length,
      approved_parts: approved,
      replacement_requests: replace,
      unmarked_parts_inside_touched_characters: unmarkedInTouched
    },
    records: touchedCharacters.map(exportRecord)
  };
}

function downloadExportFile(file, filename) {
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(file);
  link.href = objectUrl;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }, 1500);
}

async function exportReviews() {
  const payload = buildExportPayload();
  const contents = JSON.stringify(payload, null, 2);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `name_curation_${stamp}.json`;
  const file = new File([contents], filename, {
    type: "application/json"
  });
  const isTouchDevice = window.matchMedia?.("(pointer: coarse)")?.matches;
  if (isTouchDevice && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "Panic Name Studio backup",
        text: `${payload.summary.touched_characters} curated characters`
      });
      showToast(
        `Shared ${payload.summary.touched_characters.toLocaleString()} touched characters. Unmarked parts remain unchanged.`,
        "success"
      );
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        showToast("Export cancelled. No decisions were changed.", "warning");
        return;
      }
      // Fall through to a normal download if native sharing is unavailable.
    }
  }
  downloadExportFile(file, filename);
  showToast(
    `Exported ${payload.summary.touched_characters.toLocaleString()} touched characters. Unmarked parts remain unchanged.`,
    "success"
  );
}

function mergeImportedPayload(payload) {
  if (payload?.schema_version !== SCHEMA_VERSION || !Array.isArray(payload.records)) {
    throw new Error("This is not a supported name-curation v2 export.");
  }
  let imported = 0;
  let conflicts = 0;
  let stale = 0;
  payload.records.forEach(importedRecord => {
    const character = state.data.characters.find(item => item.id === String(importedRecord.id));
    if (!character) {
      stale++;
      return;
    }
    const definitions = Object.fromEntries(
      partDefinitions(character).map(part => [part.key, part])
    );
    const local = ensureRecord(character.id);
    if (!local.note && importedRecord.character_note) {
      local.note = importedRecord.character_note;
      imported++;
    }
    if (
      importedRecord.surname_order_updated_at &&
      timestamp(importedRecord.surname_order_updated_at) >= timestamp(local.surname_order_updated_at)
    ) {
      local.surname_order = importedRecord.surname_order === "21" ? "21" : "12";
      local.surname_order_updated_at = importedRecord.surname_order_updated_at;
      imported++;
    }
    if (
      importedRecord.normalized_name &&
      timestamp(importedRecord.normalized_name_updated_at || importedRecord.updated_at) >=
        timestamp(local.normalized_name_updated_at)
    ) {
      local.normalized_name = importedRecord.normalized_name;
      local.normalized_name_updated_at = importedRecord.normalized_name_updated_at || importedRecord.updated_at || payload.exported_at || nowIso();
      imported++;
    }
    if (Array.isArray(importedRecord.naming_assistant_history)) {
      local.naming_assistant_history = importedRecord.naming_assistant_history.slice(-20);
    }
    if (
      importedRecord.surname_join_style_updated_at &&
      timestamp(importedRecord.surname_join_style_updated_at) >=
        timestamp(local.surname_join_style_updated_at)
    ) {
      local.surname_join_style =
        normalizedJoinStyle(importedRecord.surname_join_style);
      local.surname_format_version = Number(
        importedRecord.surname_format_version || SURNAME_FORMAT_VERSION
      );
      local.surname_join_style_updated_at = importedRecord.surname_join_style_updated_at;
      imported++;
    }
    PART_KEYS.forEach(key => {
      const incoming = importedRecord.parts?.[key];
      if (!incoming?.decision) return;
      if (!definitions[key]?.available || incoming.current_value !== definitions[key].value) {
        stale++;
        return;
      }
      const existing = partReview(character.id, key);
      if (existing.decision && (
        existing.decision !== incoming.decision ||
        existing.scope !== incoming.scope ||
        (existing.note || "") !== (incoming.note || "")
      )) {
        conflicts++;
        return;
      }
      local.parts[key] = {
        decision: incoming.decision,
        scope: incoming.decision === "replace"
          ? (incoming.scope || "this_character")
          : null,
        note: incoming.note || "",
        replacement_value: incoming.selected_replacement || incoming.replacement_value || null,
        replacement_source: incoming.replacement_source || "",
        replacement_trait_source: incoming.replacement_trait_source || incoming.replacement_source || "",
        replacement_language: incoming.replacement_language || "",
        replacement_rationale: incoming.replacement_rationale || "",
        replacement_scores: incoming.replacement_scores || null,
        disabled: Boolean(incoming.disabled),
        reviewer: incoming.reviewer || payload.reviewer || "",
        updated_at: incoming.updated_at || payload.exported_at || nowIso()
      };
      imported++;
    });
    local.updated_at = nowIso();
    pruneRecord(character.id);
  });
  if (!state.curation.reviewer && payload.reviewer) {
    state.curation.reviewer = payload.reviewer;
    els.reviewerName.value = payload.reviewer;
  }
  saveCuration();
  renderCharacter();
  updateProgress();
  applyFilters();
  showToast(
    `Imported ${imported} decisions/notes${conflicts ? ` · ${conflicts} conflicts kept local` : ""}${stale ? ` · ${stale} stale values skipped` : ""}.`,
    conflicts || stale ? "warning" : "success"
  );
}

async function importReviews(file) {
  const text = await file.text();
  mergeImportedPayload(JSON.parse(text));
}

async function loadPackagedProgress() {
  if (Object.keys(state.curation.records).length) return;
  try {
    const response = await fetch(PACKAGED_PROGRESS_URL, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload?.schema_version !== SCHEMA_VERSION || !Array.isArray(payload.records)) {
      return;
    }
    payload.records.forEach(importedRecord => {
      const character = state.data.characters.find(
        item => item.id === String(importedRecord.id)
      );
      if (!character) return;
      const definitions = Object.fromEntries(
        partDefinitions(character).map(part => [part.key, part])
      );
      const record = ensureRecord(character.id);
      record.note = importedRecord.character_note || "";
      if (importedRecord.surname_order_updated_at) {
        record.surname_order = importedRecord.surname_order === "21" ? "21" : "12";
        record.surname_order_updated_at = importedRecord.surname_order_updated_at;
      }
      PART_KEYS.forEach(key => {
        const incoming = importedRecord.parts?.[key];
        if (
          !incoming?.decision ||
          !definitions[key]?.available ||
          incoming.current_value !== definitions[key].value
        ) return;
        record.parts[key] = {
          decision: incoming.decision,
          scope: incoming.decision === "replace"
            ? (incoming.scope || "this_character") : null,
          note: incoming.note || "",
          replacement_value: incoming.selected_replacement || null,
          replacement_source: incoming.replacement_source || "",
          replacement_trait_source: incoming.replacement_trait_source || incoming.replacement_source || "",
          replacement_language: incoming.replacement_language || "",
          replacement_rationale: incoming.replacement_rationale || "",
          replacement_scores: incoming.replacement_scores || null,
          reviewer: incoming.reviewer || payload.reviewer || "",
          updated_at: incoming.updated_at || payload.exported_at || nowIso()
        };
      });
      record.updated_at = payload.exported_at || nowIso();
      pruneRecord(character.id);
    });
    state.curation.reviewer = payload.reviewer || "";
    saveCuration();
  } catch (_) {
    // The app remains usable with an empty draft if the optional seed is absent.
  }
}

function migrateLegacyReviews() {
  if (Object.keys(state.curation.records).length) return;
  let legacy;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
  } catch (_) {
    return;
  }
  if (!legacy || typeof legacy !== "object") return;
  let migrated = 0;
  Object.entries(legacy).forEach(([id, oldReview]) => {
    const character = state.data.characters.find(item => item.id === String(id));
    if (!character) return;
    const record = ensureRecord(id);
    record.note = oldReview.note || "";
    if (oldReview.status === "approved") {
      partDefinitions(character).filter(part => part.available).forEach(part => {
        record.parts[part.key] = {
          ...blankPart(),
          decision: "approve",
          updated_at: nowIso(),
          reviewer: "Legacy full-name approval"
        };
      });
    }
    if (oldReview.status === "review" && !record.note) {
      record.note = "Legacy review flag; individual parts are intentionally unmarked.";
    }
    record.updated_at = nowIso();
    pruneRecord(id);
    migrated++;
  });
  if (migrated) {
    saveCuration();
    showToast(`Migrated ${migrated} earlier review records into component decisions.`, "success");
  }
}

function showToast(message, tone = "") {
  let toast = document.querySelector(".app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "app-toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.className = `app-toast ${tone}`;
  toast.textContent = message;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 4200);
}

function suggestionLanguageFor(character, part) {
  if (part === "first") return effectiveFirstLanguage(character);
  const live = partReview(character.id, part).replacement_language;
  return live || effectiveSurnameLanguage(character);
}

function suggestionScoreMarkup(scores = {}) {
  return `
    <div class="preview-score" title="${escapeHtml(scores.readability_note || "Length, rhythm, and word-boundary clarity")}">
      <span>Readability</span><b>${Number(scores.readability || 0).toFixed(1)}</b>
    </div>
    <div class="preview-score" title="${escapeHtml(scores.collectability_note || "Trait fit, rarity, and compactness")}">
      <span>Collectability</span><b>${Number(scores.collectability || 0).toFixed(1)}</b>
    </div>`;
}

function manualSurnameScores(first, surname, firstPart, secondPart, usageCount = 0) {
  const fullName = `${first} ${surname}`.trim();
  const boundaryRepeat = Boolean(
    firstPart &&
    secondPart &&
    firstPart.slice(-1).toLowerCase() === secondPart.slice(0, 1).toLowerCase()
  );
  const hardCluster = /[^aeiouy\s'-]{4,}/i.test(surname);
  let readability = 9.7;
  readability -= Math.max(0, surname.length - 13) * 0.22;
  readability -= Math.max(0, fullName.length - 27) * 0.12;
  if (boundaryRepeat) readability -= 0.6;
  if (hardCluster) readability -= 0.7;
  if (surname.length <= 11) readability += 0.2;

  let collectability = 8.2;
  if (surname.length >= 7 && surname.length <= 13) collectability += 0.5;
  if (firstPart && secondPart) collectability += 0.35;
  collectability -= Math.min(1.5, usageCount * 0.03);
  if (boundaryRepeat || hardCluster) collectability -= 0.35;
  const compact = surname.length <= 12 && fullName.length <= 27;
  const clamp = value => Math.max(5, Math.min(10, Math.round(value * 10) / 10));
  return {
    readability: clamp(readability),
    collectability: clamp(collectability),
    readability_note: compact
      ? "Compact length with a clear speaking rhythm"
      : "Scored from full-name length, rhythm, and compound boundary",
    collectability_note: usageCount
      ? `Manual trait fit and compactness, with ${usageCount} other fragment use${usageCount === 1 ? "" : "s"}`
      : "Manual trait fit, compactness, and no other proposed fragment uses"
  };
}

function normalizeManualSurnamePart(value) {
  const trimmed = String(value || "").trim();
  if (!/^[A-Za-z]{2,20}$/.test(trimmed)) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function normalizeManualFirstName(value) {
  const trimmed = String(value || "").trim();
  if (!/^[A-Za-z][A-Za-z'-]{1,19}$/.test(trimmed)) return null;
  if (/(pounder|diddy|cig|slur)/i.test(trimmed) || /^isis$/i.test(trimmed)) return null;
  return trimmed
    .toLowerCase()
    .replace(/(^|[-'])\p{L}/gu, match => match.toUpperCase());
}

function manualFirstNameUsage(value) {
  if (!value || !state.data) return 0;
  const target = value.toLowerCase();
  return state.data.characters.reduce((count, character) => {
    if (character.id === state.selected?.id) return count;
    return count + (
      effectivePartValue(character, "first").toLowerCase() === target ? 1 : 0
    );
  }, 0);
}

function manualFirstPreview(value) {
  const normalized = normalizeManualFirstName(value);
  if (!normalized || !state.selected || state.suggestionPart !== "first") return null;
  const usageCount = manualFirstNameUsage(normalized);
  return {
    value: normalized,
    usageCount,
    fullName: `${normalized} ${effectiveSurname(state.selected)}`.trim()
  };
}

function updateManualFirstPreview() {
  const raw = els.manualFirstInput.value;
  const preview = manualFirstPreview(raw);
  const started = Boolean(raw.trim());
  const duplicate = Boolean(preview?.usageCount);
  els.manualFirstInput.classList.toggle("invalid", started && (!preview || duplicate));
  els.manualFirstSave.disabled = !preview || duplicate;
  if (!preview) {
    els.manualFirstFullName.textContent = started
      ? "Use 2–20 English letters"
      : "Start typing to preview";
    els.manualFirstMeta.textContent =
      "Letters, apostrophe, or hyphen only · sensitive terms are blocked";
    return;
  }
  els.manualFirstFullName.textContent = preview.fullName;
  els.manualFirstMeta.textContent = duplicate
    ? `Already used ${preview.usageCount}× elsewhere · choose a unique first name`
    : `Unused collection-wide · Western custom for ${state.selected.clothing || "this character"}`;
}

function renderManualFirstEditor() {
  const show =
    state.suggestionPart === "first" &&
    state.suggestionLanguage === "western";
  els.manualFirstEditor.hidden = !show;
  if (!show) {
    els.manualFirstEditor.open = false;
    els.manualFirstInput.value = "";
    els.manualFirstInput.classList.remove("invalid");
    els.manualFirstSave.disabled = true;
    return;
  }
  const review = partReview(state.selected.id, "first");
  els.manualFirstInput.value =
    review.replacement_source === "Manual team edit · Western clothing theme"
      ? review.replacement_value || ""
      : "";
  els.manualFirstHelp.textContent =
    `Saves only for Surv!vor #${state.selected.id}. It is recorded as a Western custom ` +
    `for Clothing:${state.selected.clothing || "No clothing trait"} and checked against all 3,333 live first names.`;
  updateManualFirstPreview();
}

function saveManualFirstName() {
  const preview = manualFirstPreview(els.manualFirstInput.value);
  if (!preview || preview.usageCount || state.suggestionLanguage !== "western") return;
  const definition = partDefinitions(state.selected).find(part => part.key === "first");
  const traitSource = `Clothing:${state.selected.clothing || "No clothing trait"}`;
  updatePartReview("first", {
    decision: "replace",
    scope: "this_character",
    disabled: false,
    replacement_value: preview.value,
    replacement_source: "Manual team edit · Western clothing theme",
    replacement_trait_source: traitSource,
    replacement_language: "western",
    replacement_rationale:
      `Manually curated by the team as a Western first name for ${traitSource}. ` +
      `Replaced “${definition?.value || ""}” with the collection-unique “${preview.value}” ` +
      `for Surv!vor #${state.selected.id} only. Saved full-name preview: ${preview.fullName}.`,
    replacement_scores: null
  });
  els.suggestionDialog.close();
  showToast(`Saved unique custom first name ${preview.fullName}.`, "success");
}

function manualSurnameUsage(value) {
  if (!value || !state.data) return 0;
  const target = value.toLowerCase();
  return state.data.characters.reduce((count, character) => {
    return count + ["surname_part_1", "surname_part_2"]
      .filter(key =>
        !(character.id === state.selected?.id && key === state.suggestionPart) &&
        partDefinitions(character).some(part => part.key === key && part.available) &&
        effectivePartValue(character, key).toLowerCase() === target
      ).length;
  }, 0);
}

function manualSurnamePreview(value) {
  const normalized = normalizeManualSurnamePart(value);
  if (!normalized || !state.selected || !state.suggestionPart?.startsWith("surname_")) {
    return null;
  }
  const part1 = state.suggestionPart === "surname_part_1"
    ? normalized
    : effectivePartValue(state.selected, "surname_part_1");
  const part2 = state.suggestionPart === "surname_part_2"
    ? normalized
    : effectivePartValue(state.selected, "surname_part_2");
  const previewOrder = canFlipSurname(state.selected)
    ? state.suggestionPreviewOrder
    : surnameOrder(state.selected);
  const surname = composeSurname(
    state.selected,
    part1,
    part2,
    previewOrder,
    state.suggestionJoinStyle
  );
  const first = effectivePartValue(state.selected, "first");
  const usageCount = manualSurnameUsage(normalized);
  return {
    value: normalized,
    surname,
    fullName: `${first} ${surname}`.trim(),
    usageCount,
    scores: manualSurnameScores(
      first,
      surname,
      previewOrder === "21" ? part2 : part1,
      previewOrder === "21" ? part1 : part2,
      usageCount
    )
  };
}

function updateManualSurnamePreview() {
  const raw = els.manualSurnameInput.value;
  const preview = manualSurnamePreview(raw);
  const started = Boolean(raw.trim());
  els.manualSurnameInput.classList.toggle("invalid", started && !preview);
  els.manualSurnameSave.disabled = !preview;
  if (!preview) {
    els.manualSurnameFullName.textContent = started
      ? "Use 2–20 English letters"
      : "Start typing to preview";
    els.manualSurnameMeta.textContent =
      "No spaces, symbols, numbers, or Japanese-bank additions";
    els.manualSurnameScores.innerHTML = "";
    return;
  }
  els.manualSurnameFullName.textContent = preview.fullName;
  els.manualSurnameMeta.textContent =
    `${preview.value} · ${preview.usageCount} other current/proposed use${preview.usageCount === 1 ? "" : "s"}`;
  els.manualSurnameScores.innerHTML = suggestionScoreMarkup(preview.scores);
}

function renderManualSurnameEditor() {
  const show =
    state.suggestionPart?.startsWith("surname_") &&
    state.suggestionLanguage === "western";
  els.manualSurnameEditor.hidden = !show;
  if (!show) {
    els.manualSurnameEditor.open = false;
    els.manualSurnameInput.value = "";
    els.manualSurnameInput.classList.remove("invalid");
    els.manualSurnameSave.disabled = true;
    els.manualSurnameScores.innerHTML = "";
    return;
  }
  const review = partReview(state.selected.id, state.suggestionPart);
  els.manualSurnameInput.value =
    review.replacement_source === "Manual team edit"
      ? review.replacement_value || ""
      : "";
  els.manualSurnameHelp.textContent =
    `Saves only for Surv!vor #${state.selected.id}. Trait source remains ` +
    `${state.suggestionSource || effectivePartSource(state.selected, state.suggestionPart)} for auditing.`;
  updateManualSurnamePreview();
}

function saveManualSurnamePart() {
  const preview = manualSurnamePreview(els.manualSurnameInput.value);
  if (!preview || state.suggestionLanguage !== "western") return;
  if (canFlipSurname(state.selected)) {
    setSurnameOrder(state.suggestionPreviewOrder, {
      rerender: false,
      announce: false
    });
  }
  setSurnameJoinStyle(state.suggestionJoinStyle, {
    rerender: false,
    announce: false
  });
  const definition = partDefinitions(state.selected)
    .find(part => part.key === state.suggestionPart);
  const traitSource =
    state.suggestionSource ||
    state.suggestionPayload?.trait_source ||
    definition?.source ||
    "";
  updatePartReview(state.suggestionPart, {
    decision: "replace",
    scope: "this_character",
    replacement_value: preview.value,
    replacement_source: "Manual team edit",
    replacement_trait_source: traitSource,
    replacement_language: "western",
    replacement_rationale:
      `Manually curated by the team for ${traitSource || "this character's trait"}. ` +
      `Replaced “${definition?.value || ""}” with “${preview.value}” for Surv!vor #${state.selected.id} only. ` +
      `Saved full-name preview: ${preview.fullName}. ` +
      `Readability ${preview.scores.readability.toFixed(1)}/10; ` +
      `collectability ${preview.scores.collectability.toFixed(1)}/10.`,
    replacement_scores: preview.scores
  });
  els.suggestionDialog.close();
  showToast(`Saved manual surname ${preview.fullName}.`, "success");
}

function renderSuggestionCurrentPreview() {
  const current = state.suggestionPayload?.current_preview;
  if (!current) return;
  const formatPreviews =
    current.format_previews?.[state.suggestionJoinStyle] ||
    current.order_previews ||
    {};
  const preview =
    formatPreviews[state.suggestionPreviewOrder] ||
    current;
  els.suggestionFullPreview.hidden = false;
  els.suggestionCurrentFullName.textContent = preview.full_name;
  const formatLabel = state.suggestionJoinStyle === "lower_second"
    ? "lowercase second fragment"
    : "capitalized fragments";
  els.suggestionCurrentOrder.textContent = current.can_flip
    ? `${preview.surname} · preview only · ${
        preview.order === "21" ? "trait 2 → trait 1" : "trait 1 → trait 2"
      } · ${formatLabel} · saved only when you choose an option`
    : `${preview.surname} · one-word surname`;
  els.suggestionCurrentScores.innerHTML = suggestionScoreMarkup(preview.scores);
  els.suggestionFlipCurrent.hidden = !current.can_flip;
  if (current.can_flip) {
    const nextOrder = preview.order === "12" ? "21" : "12";
    const nextPart = effectivePartValue(
      state.selected,
      nextOrder === "21" ? "surname_part_2" : "surname_part_1"
    );
    els.suggestionFlipCurrent.textContent =
      `⇄ Preview ${nextPart || (nextOrder === "21" ? "trait 2" : "trait 1")} first`;
    els.suggestionFlipCurrent.setAttribute(
      "aria-label",
      `Preview all surname options with ${nextPart || (nextOrder === "21" ? "trait 2" : "trait 1")} first. This does not save until an option is chosen.`
    );
  }
  els.suggestionUseSingleCurrent.hidden =
    !state.suggestionPart?.startsWith("surname_") || !current.can_use_single;
  if (!els.suggestionUseSingleCurrent.hidden) {
    const kept = effectivePartValue(state.selected, state.suggestionPart);
    els.suggestionUseSingleCurrent.textContent =
      `Use ${kept || "this part"} as one-word surname`;
  }
}

function renderSuggestionTraitSources() {
  const payload = state.suggestionPayload;
  const isSurname = state.suggestionPart?.startsWith("surname_");
  const isAlternateJapaneseFirst =
    state.suggestionPart === "first" && state.suggestionLanguage === "japanese";
  const showTraitSource = isSurname || isAlternateJapaneseFirst;
  els.suggestionTraitSourceWrap.hidden = !showTraitSource;
  if (!payload) return;
  if (!showTraitSource) {
    const coverage = payload.japanese_coverage;
    els.suggestionPolicy.textContent =
      state.suggestionLanguage === "japanese" && coverage
        ? `Closed artist CSV only · ${coverage.unused_exact_options} unused exact options for this character from Clothing and its other visible traits · Body:${payload.gender_route}.`
        : state.suggestionNameSource === "iconic"
          ? "Persistent Iconic / Fun bank only · exact Clothing + Body gender · human-approved references · unused collection-wide."
          : "Western first names come only from the curated clothing-theme bank and must be unused across the full collection.";
    return;
  }
  els.suggestionTraitSourceLabel.textContent = isSurname
    ? "Name this surname part from"
    : "Choose exact Japanese first-name trait bank";
  els.suggestionTraitSource.innerHTML = (payload.available_trait_sources || [])
    .filter(item => state.suggestionLanguage === "japanese"
      ? item.japanese_count > 0
      : item.western_count > 0)
    .map(item => {
      const count = state.suggestionLanguage === "japanese"
        ? item.japanese_count
        : item.western_count;
      return `<option value="${escapeHtml(item.source)}" ${item.source === payload.trait_source ? "selected" : ""}>
        ${escapeHtml(item.label)} · ${Number(count || 0)} options
      </option>`;
    })
    .join("");
  els.suggestionTraitSource.disabled = false;
  els.suggestionTraitSourceApply.disabled = false;
  els.suggestionTraitSourceHelp.textContent =
    payload.trait_source === payload.original_trait_source
      ? isSurname
        ? "Using this surname part’s original trait. Choose any other visible character trait to switch banks."
        : "Primary rule: exact Clothing + Body-gender bank. This is the artist-approved default."
      : `Alternate visible trait selected. The choice will be auditable as ${payload.trait_source}, not ${payload.original_trait_source}.`;
  els.suggestionPolicy.textContent = state.suggestionLanguage === "japanese"
    ? isSurname
      ? `Closed artist bank only. Showing exact Japanese surnames indexed for ${payload.trait_source}.`
      : `Closed artist bank only. Showing exact first names indexed for ${payload.trait_source} and Body:${payload.gender_route}. Alternate visible-trait routing is opt-in and clearly recorded.`
    : `Showing reviewed fragments for ${payload.trait_source}, ranked for readability, collectability, and low repetition.`;
}

function candidateOrder(candidate) {
  const available =
    candidate.format_previews?.[state.suggestionJoinStyle] ||
    candidate.order_previews ||
    {};
  const preferred =
    state.suggestionPreviewOrder ||
    state.suggestionPayload?.current_preview?.order ||
    candidate.recommended_order ||
    "12";
  return available[preferred] ? preferred : Object.keys(available)[0] || "12";
}

function candidateBankSection(candidate) {
  return candidate.iconic_bank_section || candidate.surname_bank_section || "";
}

function sortedSuggestionEntries() {
  const suggestions = state.suggestionPayload?.suggestions || [];
  const entries = suggestions.map((candidate, index) => {
    const order = candidateOrder(candidate);
    const preview =
      candidate.format_previews?.[state.suggestionJoinStyle]?.[order] ||
      candidate.order_previews?.[order] || {
      full_name: candidate.preview_full_name || candidate.value,
      surname: candidate.preview_surname || candidate.value,
      scores: candidate.scores || {},
      compact: candidate.length_check === "Compact length"
    };
    return { candidate, index, order, preview };
  }).filter(({ candidate }) => {
    if (state.suggestionCategory !== "all" && candidateBankSection(candidate) !== state.suggestionCategory) return false;
    const query = state.suggestionSearch.trim().toLowerCase();
    if (!query) return true;
    return [candidate.value, candidate.fit, candidate.iconic_reference, candidate.iconic_category, candidate.source]
      .some(value => String(value || "").toLowerCase().includes(query));
  });
  if (state.suggestionSort === "shortest") {
    return entries.sort((left, right) =>
      String(left.candidate.preview_surname || "").length -
        String(right.candidate.preview_surname || "").length ||
      String(left.candidate.preview_full_name || "").length -
        String(right.candidate.preview_full_name || "").length ||
      Number(right.candidate.scores?.readability || 0) -
        Number(left.candidate.scores?.readability || 0)
    );
  }
  if (state.suggestionSort === "least-used") {
    return entries.sort((left, right) =>
      Number(left.candidate.usage_count || 0) - Number(right.candidate.usage_count || 0) ||
      Number(right.candidate.scores?.collectability || 0) -
        Number(left.candidate.scores?.collectability || 0)
    );
  }
  return entries.sort((left, right) =>
    (
      Number(right.candidate.scores?.readability || 0) +
      Number(right.candidate.scores?.collectability || 0)
    ) - (
      Number(left.candidate.scores?.readability || 0) +
      Number(left.candidate.scores?.collectability || 0)
    ) ||
    Number(left.candidate.usage_count || 0) - Number(right.candidate.usage_count || 0)
  );
}

function renderSuggestionOptions() {
  const entries = sortedSuggestionEntries();
  if (els.suggestionResultCount) {
    const total = state.suggestionPayload?.suggestions?.length || 0;
    els.suggestionResultCount.textContent = `${entries.length} shown · ${total} available`;
  }
  if (!entries.length) {
    const message =
      state.suggestionPart === "first" && state.suggestionLanguage === "japanese"
        ? "No unused exact name remains across this character’s artist Clothing/visible-trait banks for its Body gender. Japanese names will not be invented or taken from the internet."
        : state.suggestionPart === "first"
          ? "No unused name remains in this clothing bank. Keep the red X and add a note so the reserve bank can be curated further."
          : "No safe unused options remain in this exact bank. Keep the red X and add a note; the app will not invent a weak substitute.";
    els.suggestionList.innerHTML = `<div class="suggestion-empty">
      ${escapeHtml(message)}
    </div>`;
    return;
  }
  els.suggestionList.innerHTML = entries.map(({ candidate, index, order, preview }) => {
    const changeLabel = state.suggestionPart === "first"
      ? `First-name option · ${candidate.value}`
      : `${state.suggestionPart === "surname_part_1" ? "Trait 1 fragment" : "Trait 2 fragment"} · ${candidate.value}`;
    return `<article class="suggestion-option ${preview.compact ? "compact-option" : ""}">
      <div class="suggestion-option-preview">
        <div>
          <span>Full-name preview${preview.compact ? " · compact" : ""}</span>
          <h3>${escapeHtml(preview.full_name)}</h3>
        </div>
        <div class="preview-score-pair">${suggestionScoreMarkup(preview.scores)}</div>
      </div>
      <div class="suggestion-component-change">${escapeHtml(changeLabel)}</div>
      ${candidateBankSection(candidate) ? `<div class="suggestion-bank-badge">${escapeHtml(candidateBankSection(candidate))}${candidate.iconic_category ? ` · ${escapeHtml(candidate.iconic_category)}` : ""}</div>` : ""}
      <p>${escapeHtml(candidate.fit)}</p>
      <small>${escapeHtml(candidate.source)} · ${escapeHtml(candidate.uniqueness)}</small>
      <small>${escapeHtml(preview.scores?.readability_note || "")} · ${escapeHtml(preview.scores?.collectability_note || "")}</small>
      <div class="suggestion-option-actions">
        <span>${candidate.format_previews?.[state.suggestionJoinStyle]?.["21"] || candidate.order_previews?.["21"] ? `Preview order: ${order === "21" ? "trait 2 first" : "trait 1 first"} · ${state.suggestionJoinStyle === "lower_second" ? "lowercase join" : "capitalized join"}` : ""}</span>
        <button class="use-suggestion" data-use-suggestion="${index}" data-use-order="${order}">Use this exact preview</button>
        ${state.suggestionPart?.startsWith("surname_") ? `
          <button class="use-suggestion-single" data-use-single="${index}">
            Use ${escapeHtml(candidate.value)} as one-word surname
          </button>` : ""}
      </div>
    </article>`;
  }).join("");
  els.suggestionList.querySelectorAll("[data-use-suggestion]").forEach(button => {
    button.addEventListener("click", () => {
      const candidate = state.suggestionPayload.suggestions[Number(button.dataset.useSuggestion)];
      chooseSuggestion(candidate, button.dataset.useOrder);
    });
  });
  els.suggestionList.querySelectorAll("[data-use-single]").forEach(button => {
    button.addEventListener("click", () => {
      const candidate = state.suggestionPayload.suggestions[Number(button.dataset.useSingle)];
      chooseSuggestion(candidate, "12", true);
    });
  });
}

async function openSuggestions(part, language = null, source = null, nameSource = null) {
  const requestVersion = ++state.suggestionRequestVersion;
  state.suggestionPart = part;
  state.suggestionLanguage = language || suggestionLanguageFor(state.selected, part);
  state.suggestionNameSource = part === "first" && state.suggestionLanguage === "western"
    ? (nameSource === "normal" ? "normal" : "iconic")
    : "normal";
  state.suggestionCategory = "all";
  state.suggestionSearch = "";
  if (els.suggestionSearch) els.suggestionSearch.value = "";
  const definition = partDefinitions(state.selected).find(item => item.key === part);
  const requestedTraitSource = part.startsWith("surname_") ||
    (part === "first" && state.suggestionLanguage === "japanese")
    ? (source || partReview(state.selected.id, part).replacement_trait_source || definition?.source || "")
    : null;
  state.suggestionSource = requestedTraitSource;
  state.suggestionPayload = null;
  state.suggestionPreviewOrder = surnameOrder(state.selected);
  state.suggestionJoinStyle = surnameJoinStyle(state.selected);
  els.surnameFormatControls.hidden = !part.startsWith("surname_");
  els.surnameFormatControls.querySelectorAll("[data-join-style]").forEach(button => {
    button.classList.toggle("active", button.dataset.joinStyle === state.suggestionJoinStyle);
  });
  els.suggestionTitle.textContent = `Replace ${definition?.label || "name part"}`;
  els.suggestionContext.textContent =
    `Surv!vor #${state.selected.id} · ${definition?.source || state.selected.clothing}`;
  els.suggestionLanguage.querySelectorAll("[data-language]").forEach(button => {
    button.classList.toggle("active", button.dataset.language === state.suggestionLanguage);
  });
  els.suggestionNameSource.hidden = !(part === "first" && state.suggestionLanguage === "western");
  els.suggestionNameSource.querySelectorAll("[data-name-source]").forEach(button => {
    button.classList.toggle("active", button.dataset.nameSource === state.suggestionNameSource);
  });
  const showCategorizedBank = (part === "first" && state.suggestionNameSource === "iconic") ||
    (part.startsWith("surname_") && state.suggestionLanguage === "western");
  els.suggestionSubBanks.hidden = !showCategorizedBank;
  if (!els.suggestionSubBanks.hidden) {
    els.suggestionSubBanks.querySelector("span").textContent = part === "first"
      ? "Trait-connected first-name sub-bank"
      : "Surname source bank";
    els.suggestionSearch.placeholder = part === "first"
      ? "Kermit, ribbit, hopper…"
      : "Search custom, greenlit, or wordplay…";
    els.suggestionCategoryTabs.innerHTML = `<span class="suggestion-loading-inline">Loading categorized trait options…</span>`;
    els.suggestionResultCount.textContent = "";
  }
  els.suggestionPolicy.textContent =
    state.suggestionLanguage === "japanese"
      ? "Japanese mode is closed-bank only: every option must be an exact entry from the artist CSV. Gender routing comes only from Body."
      : part === "first"
        ? state.suggestionNameSource === "iconic"
          ? "Iconic / Fun options come only from the persistent, human-approved cultural-reference bank for this exact Clothing and Body gender."
          : "Western first names come only from the curated clothing-theme bank and must be unused across the full collection."
        : "Surname options come from the exact source trait’s reviewed fragment bank, ranked for low repetition.";
  els.suggestionList.innerHTML = `<div class="suggestion-loading">Checking fit, uniqueness, and current team proposals…</div>`;
  els.suggestionFullPreview.hidden = true;
  els.suggestionTraitSourceWrap.hidden = !(
    part.startsWith("surname_") ||
    (part === "first" && state.suggestionLanguage === "japanese")
  );
  els.suggestionTraitSource.disabled = true;
  els.suggestionTraitSourceApply.disabled = true;
  renderManualFirstEditor();
  renderManualSurnameEditor();
  if (!els.suggestionDialog.open) {
    const voiceNonmodal = !els.voiceDock.hidden;
    els.suggestionDialog.classList.toggle("voice-nonmodal", voiceNonmodal);
    if (voiceNonmodal) els.suggestionDialog.show();
    else els.suggestionDialog.showModal();
  }
  try {
    const params = new URLSearchParams({
      id: state.selected.id,
      part,
      language: state.suggestionLanguage,
      name_source: state.suggestionNameSource,
      request: `${requestVersion}-${Date.now()}`
    });
    if (requestedTraitSource) params.set("source", requestedTraitSource);
    const requestUrl = `/api/suggestions?${params}`;
    const response = await fetch(requestUrl, { cache: "no-store" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (requestVersion !== state.suggestionRequestVersion) return;
    state.suggestionPayload = payload;
    state.suggestionSource = payload.trait_source;
    const sections = [...new Set((payload.suggestions || [])
      .map(candidateBankSection)
      .filter(Boolean))];
    const showCategorizedBank =
      (state.suggestionPart === "first" && state.suggestionNameSource === "iconic") ||
      (state.suggestionPart?.startsWith("surname_") && state.suggestionLanguage === "western");
    els.suggestionSubBanks.hidden = !showCategorizedBank;
    els.suggestionCategoryTabs.innerHTML = ["all", ...sections].map(section => {
      const count = section === "all"
        ? payload.suggestions.length
        : payload.suggestions.filter(candidate => candidateBankSection(candidate) === section).length;
      const label = section === "all"
        ? state.suggestionPart === "first" ? "All trait names" : "All surname options"
        : section;
      return `<button class="${section === state.suggestionCategory ? "active" : ""}" data-suggestion-category="${escapeHtml(section)}">${escapeHtml(label)} <b>${count}</b></button>`;
    }).join("");
    els.suggestionCategoryTabs.querySelectorAll("[data-suggestion-category]").forEach(button => {
      button.addEventListener("click", () => {
        state.suggestionCategory = button.dataset.suggestionCategory;
        els.suggestionCategoryTabs.querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
        renderSuggestionOptions();
      });
    });
    renderSuggestionTraitSources();
    renderSuggestionCurrentPreview();
    renderManualFirstEditor();
    renderManualSurnameEditor();
    renderSuggestionOptions();
    updateVoiceWorkspace();
  } catch (error) {
    if (requestVersion !== state.suggestionRequestVersion) return;
    els.suggestionList.innerHTML = `<div class="suggestion-empty">${escapeHtml(error.message)}</div>`;
  }
}

function chooseSuggestion(candidate, order = "12", single = false) {
  const isSurname = state.suggestionPart.startsWith("surname_");
  const preview =
    candidate.format_previews?.[state.suggestionJoinStyle]?.[order] ||
    candidate.order_previews?.[order] ||
    candidate.single_preview;
  const replacement = {
    replacement_value: candidate.value,
    replacement_source: candidate.source,
    replacement_trait_source: state.suggestionPayload?.trait_source || candidate.source,
    replacement_language: candidate.language || state.suggestionLanguage,
    replacement_rationale:
      `${candidate.fit} ${candidate.uniqueness}. ` +
      `${candidate.iconic_source_url ? `Iconic-bank evidence: ${candidate.iconic_reference} · ${candidate.iconic_source_url}. ` : ""}` +
      `Chosen full-name preview: ${
        single
          ? candidate.single_preview?.full_name
          : preview?.full_name || candidate.preview_full_name || candidate.value
      }. ` +
      `Readability ${Number(
        (single ? candidate.single_preview?.scores : preview?.scores)?.readability ||
        candidate.scores?.readability ||
        0
      ).toFixed(1)}/10; ` +
      `collectability ${Number(
        (single ? candidate.single_preview?.scores : preview?.scores)?.collectability ||
        candidate.scores?.collectability ||
        0
      ).toFixed(1)}/10.`,
    replacement_scores:
      (single ? candidate.single_preview?.scores : preview?.scores) ||
      candidate.scores ||
      null
  };
  if (single && isSurname) {
    keepOnlySurnamePart(state.suggestionPart, { replacement });
    return;
  }
  if (isSurname && canFlipSurname(state.selected)) {
    setSurnameOrder(order, { rerender: false, announce: false });
    setSurnameJoinStyle(state.suggestionJoinStyle, {
      rerender: false,
      announce: false
    });
  }
  updatePartReview(state.suggestionPart, {
    decision: "replace",
    scope: partReview(state.selected.id, state.suggestionPart).scope || "this_character",
    disabled: false,
    ...replacement
  });
  els.suggestionDialog.close();
  showToast(
    `Saved ${preview?.full_name || effectiveDisplayName(state.selected)} as the requested full-name preview.`,
    "success"
  );
}

function renderActivity() {
  const history = [...state.cloudHistory].reverse().slice(0, 100);
  els.activityList.innerHTML = history.length
    ? history.map(item => `
      <div class="activity-item">
        <b>${escapeHtml(item.by || "Team")}</b>
        <span>${item.character_id ? `#${escapeHtml(item.character_id)} · ` : ""}${escapeHtml(item.part || "")} ${escapeHtml(item.action || "")}</span>
        <time>${escapeHtml(item.at ? new Date(item.at).toLocaleString() : "")}</time>
      </div>
    `).join("")
    : `<div class="suggestion-empty">No shared activity yet.</div>`;
}

async function checkCloudSession() {
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload.authenticated) {
      state.cloudMode = "auth";
      els.loginGate.hidden = false;
      setCloudStatus("offline", "Sign in");
      return false;
    }
    state.cloudAuthenticated = true;
    state.curation.reviewer = state.curation.reviewer || payload.reviewer || "";
    els.loginGate.hidden = true;
    await pullCloudState();
    await loadSelectedSurnameRepair();
    scheduleFullSurnameRepairScan();
    clearInterval(state.cloudPollTimer);
    state.cloudPollTimer = setInterval(syncCloudTick, CLOUD_POLL_MS);
    return true;
  } catch (_) {
    state.cloudMode = "local";
    state.cloudAuthenticated = false;
    els.loginGate.hidden = true;
    setCloudStatus("offline", "Local");
    els.saveState.textContent = "Local mode · start with Vercel to enable sync";
    return false;
  }
}

async function loginToCloud(event) {
  event.preventDefault();
  els.loginError.textContent = "";
  const reviewer = els.loginReviewer.value.trim();
  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewer,
        passcode: els.loginPasscode.value
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not sign in.");
    state.cloudAuthenticated = true;
    state.curation.reviewer = reviewer;
    els.reviewerName.value = reviewer;
    els.loginPasscode.value = "";
    els.loginGate.hidden = true;
    await pullCloudState();
    await loadSelectedSurnameRepair();
    scheduleFullSurnameRepairScan();
    scheduleCloudSave();
    clearInterval(state.cloudPollTimer);
    state.cloudPollTimer = setInterval(syncCloudTick, CLOUD_POLL_MS);
  } catch (error) {
    els.loginError.textContent = error.message;
  }
}

function loadVoiceSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) || "null");
    if (saved && typeof saved === "object") {
      state.voice.settings.personality = ["adaptive", "scout", "calm", "bold"]
        .includes(saved.personality) ? saved.personality : "scout";
      const rate = Number(saved.rate);
      state.voice.settings.rate = Number.isFinite(rate) ? Math.max(.55, Math.min(1.2, rate)) : .8;
      state.voice.settings.voiceURI = String(saved.voiceURI || "");
      state.voice.muted = Boolean(saved.muted);
    }
  } catch (_) {
    // Invalid voice preferences safely fall back to the clear default voice.
  }
}

function saveVoiceSettings() {
  localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify({
    ...state.voice.settings,
    muted: state.voice.muted
  }));
}

function setVoiceVisualState(status, label, hint = "") {
  if (!els.voiceDock) return;
  els.voiceDock.dataset.state = status;
  els.voiceStateLabel.textContent = label;
  if (hint) els.voiceHint.textContent = hint;
  document.body.classList.toggle("voice-listening", status === "listening");
}

function updateVoiceWorkspace() {
  if (!els.voiceDock || els.voiceDock.hidden || !state.selected) return;
  const character = state.selected;
  els.voicePortrait.src = `/pfps_webp/${character.id}.webp`;
  els.voiceCharacterId.textContent = `Character #${character.id} · ${character.clothing || "Special"}`;
  els.voiceCharacterName.textContent = effectiveDisplayName(character);
  els.voiceCharacterTraits.textContent = character.traits
    .slice(0, 5)
    .map(trait => `${trait.type}: ${trait.value}`)
    .join(" · ");

  let stage = "confirm";
  let hint = "This character is decided. Say “next undecided” to keep moving.";
  let recommended = ["next undecided"];
  if (state.voice.pending) {
    stage = "confirm";
    hint = `Confirm the pending change: ${state.voice.pending.label}.`;
    recommended = ["confirm", "cancel"];
  } else if (els.suggestionDialog?.open) {
    stage = "options";
    hint = "The option bank is open. Read choices or choose an option number.";
    recommended = ["read options", "use option one", "use option two", "use option three"];
  } else {
    const nextPart = partDefinitions(character).find(part => {
      if (!part.available) return false;
      const review = partReview(character.id, part.key);
      return review.decision !== "approve" && !(review.decision === "replace" && (review.replacement_value || review.disabled));
    });
    if (nextPart) {
      stage = nextPart.key;
      const review = partReview(character.id, nextPart.key);
      const label = voicePartLabel(nextPart.key);
      if (review.decision === "replace") {
        hint = `${label} is marked red. Open its fitting bank or dictate a custom replacement.`;
        recommended = nextPart.key === "first"
          ? ["suggest first", "iconic options"]
          : [`suggest surname ${nextPart.key === "surname_part_2" ? "two" : "one"}`];
      } else {
        hint = `Review ${label}. Lock it if it fits, or mark it for replacement.`;
        recommended = nextPart.key === "first"
          ? ["lock first", "replace first"]
          : [`lock surname ${nextPart.key === "surname_part_2" ? "two" : "one"}`, `mark surname ${nextPart.key === "surname_part_2" ? "two" : "one"} for replacement`];
      }
    }
  }
  els.voiceNextStep.textContent = hint;
  els.voiceCommandBoard.querySelectorAll("[data-voice-stage]").forEach(section => {
    section.classList.toggle("recommended", section.dataset.voiceStage === stage);
  });
  els.voiceCommandBoard.querySelectorAll("[data-voice-command]").forEach(button => {
    button.classList.toggle("command-recommended", recommended.includes(button.dataset.voiceCommand));
  });
}

function populateVoiceChoices() {
  if (!els.voiceSelect || !("speechSynthesis" in window)) return;
  const voices = window.speechSynthesis.getVoices()
    .filter(voice => /^en(?:[-_]|$)/i.test(voice.lang));
  const previous = state.voice.settings.voiceURI;
  els.voiceSelect.innerHTML = `<option value="">Default clear English voice</option>` + voices.map(voice =>
    `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}${voice.localService ? " · device" : ""}</option>`
  ).join("");
  if (voices.some(voice => voice.voiceURI === previous)) els.voiceSelect.value = previous;
}

function setVoiceDock(open) {
  els.voiceDock.hidden = !open;
  els.voiceModeButton.classList.toggle("active", open);
  els.voiceModeButton.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("voice-mode-open", open);
  if (open) {
    setVoiceVisualState(
      state.voice.supported ? "ready" : "unsupported",
      state.voice.supported ? "Voice ready" : "Dictation fallback ready",
      state.voice.supported
        ? "Tap Listen, or enable hands-free after microphone permission is granted."
        : "Use the microphone on your phone keyboard in the command field."
    );
    updateVoiceWorkspace();
  } else {
    stopVoiceListening(true);
  }
}

function voiceProfile() {
  let personality = state.voice.settings.personality;
  if (personality === "adaptive") {
    const clothing = String(state.selected?.clothing || "").toLowerCase();
    personality = /pirate|king|queen|devil|bull/.test(clothing) ? "bold" :
      /angel|painter|kimono|saint/.test(clothing) ? "calm" : "scout";
  }
  return personality === "bold" ? { pitch: 0.86, rate: 1 } :
    personality === "calm" ? { pitch: 0.96, rate: 1 } :
      { pitch: 1, rate: 1 };
}

function speakVoice(message, { resume = true } = {}) {
  const text = String(message || "").trim();
  if (!text) return Promise.resolve();
  state.voice.lastSpoken = text;
  if (state.voice.muted || !("speechSynthesis" in window)) {
    if (resume && state.voice.handsFree) setTimeout(startVoiceListening, 180);
    return Promise.resolve();
  }
  stopVoiceListening(false);
  window.speechSynthesis.cancel();
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    const profile = voiceProfile();
    utterance.lang = "en-US";
    utterance.pitch = profile.pitch;
    utterance.rate = Math.max(.65, Math.min(1.4, profile.rate * state.voice.settings.rate));
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find(voice => voice.voiceURI === state.voice.settings.voiceURI) ||
      voices.find(voice => /^en[-_]/i.test(voice.lang)) || voices[0] || null;
    const finish = () => {
      resolve();
      if (resume && state.voice.handsFree && !els.voiceDock.hidden) {
        setTimeout(startVoiceListening, 220);
      }
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  });
}

async function acquireVoiceWakeLock() {
  if (!("wakeLock" in navigator) || state.voice.wakeLock) return;
  try {
    state.voice.wakeLock = await navigator.wakeLock.request("screen");
    state.voice.wakeLock.addEventListener("release", () => {
      state.voice.wakeLock = null;
    });
  } catch (_) {
    // Wake Lock is optional; voice control still works while the page stays visible.
  }
}

function releaseVoiceWakeLock() {
  state.voice.wakeLock?.release?.().catch(() => {});
  state.voice.wakeLock = null;
}

function stopVoiceListening(manual = true) {
  state.voice.manualStop = manual;
  try { state.voice.recognition?.abort(); } catch (_) {}
  state.voice.listening = false;
  els.voiceMicButton?.setAttribute("aria-pressed", "false");
  els.voiceMicButton?.classList.remove("active");
  if (manual && !els.voiceDock?.hidden) {
    setVoiceVisualState("ready", "Voice ready", "Tap Listen for another command.");
  }
}

function startVoiceListening() {
  if (!state.voice.supported) {
    setVoiceVisualState(
      "unsupported",
      "Use phone dictation",
      "Tap the command field, use your keyboard microphone, then press Run."
    );
    els.voiceCommandInput?.focus();
    return;
  }
  if (state.voice.listening || els.voiceDock.hidden) return;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  state.voice.manualStop = false;
  try {
    state.voice.recognition.start();
  } catch (_) {
    // Mobile browsers can reject a duplicate start while the previous session ends.
  }
}

function readCurrentCharacter(section = "character") {
  if (!state.selected) return "No character is selected.";
  const character = state.selected;
  const name = effectiveDisplayName(character) || "name required";
  if (section === "name") return `${name}.`;
  if (section === "traits") {
    const traits = character.traits
      .filter(trait => trait.value)
      .map(trait => `${trait.type}, ${trait.value}`)
      .join(". ");
    return `Character ${character.id}. ${traits}.`;
  }
  if (section === "status") {
    const status = curationStatus(character);
    return `Character ${character.id}. ${status.decided} of ${status.total} name parts decided. ${status.rejected || 0} marked for replacement.`;
  }
  return `Character ${character.id}. ${name}. Clothing, ${character.clothing || "not listed"}. Say read traits for every trait, or suggest a name part.`;
}

function readVoiceOptions() {
  const entries = sortedSuggestionEntries().slice(0, 5);
  if (!entries.length) return "No fitting options are loaded. Say suggest first, suggest surname one, or suggest surname two.";
  return entries.map(({ candidate, preview }, index) =>
    `Option ${index + 1}, ${preview.full_name || candidate.preview_full_name || candidate.value}`
  ).join(". ") + ". Say use option and its number.";
}

function normalizeVoiceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[.,!?;:]/g, " ")
    .replace(/\b(sir|sur|certain)\s+name\b/g, "surname")
    .replace(/\bsurname\s+(won|one)\b/g, "surname one")
    .replace(/\bsurname\s+(too|to|two)\b/g, "surname two")
    .replace(/\bfirst\s+named?\b/g, "first name")
    .replace(/\b(luck|look)\b/g, "lock")
    .replace(/\b(next|neck)\s+on\s+decided\b/g, "next undecided")
    .replace(/\b(icon|iconics|ionic)\s+options\b/g, "iconic options")
    .replace(/\b(normal|regular)\s+names\b/g, "$1 options")
    .replace(/\boption\s+won\b/g, "option one")
    .replace(/\boption\s+to\b/g, "option two")
    .replace(/\boption\s+tree\b/g, "option three")
    .replace(/\b(use|choose|pick)\s+(?:the\s+)?(?:adoption|optional)\b/g, "$1 option")
    .replace(/\b(survivor|character|number|hash)\s+(\d+)\b/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

function parseVoiceIntentExact(raw) {
  const text = normalizeVoiceText(raw);
  if (!text) return { type: "empty", mutates: false };
  if (/^(confirm|yes|save it|do it)$/.test(text)) return { type: "confirm", mutates: true };
  if (/^(cancel|no|never mind|nevermind)$/.test(text)) return { type: "cancel", mutates: false };
  if (/^(stop speaking|be quiet|silence)$/.test(text)) return { type: "stop_speaking", mutates: false };
  if (/^(repeat|say that again)$/.test(text)) return { type: "repeat", mutates: false };
  if (/^next undecided$/.test(text)) return { type: "next_undecided", mutates: false };
  if (/^(next|next character)$/.test(text)) return { type: "move", direction: 1, mutates: false };
  if (/^(previous|back|previous character)$/.test(text)) return { type: "move", direction: -1, mutates: false };
  const goTo = text.match(/^(?:go to|open)\s+(\d{1,4})$/);
  if (goTo) return { type: "go_to", id: goTo[1], mutates: false };
  if (/^focus( mode)?$/.test(text)) return { type: "view", mode: "focus", mutates: false };
  if (/^browse( mode)?$/.test(text)) return { type: "view", mode: "browse", mutates: false };
  if (/^read( current)? character$/.test(text)) return { type: "read", section: "character", mutates: false };
  if (/^read( the)? name$/.test(text)) return { type: "read", section: "name", mutates: false };
  if (/^read( the)? traits$/.test(text)) return { type: "read", section: "traits", mutates: false };
  if (/^read( the)? status$/.test(text)) return { type: "read", section: "status", mutates: false };
  if (/^read( the)? options$/.test(text)) return { type: "read_options", mutates: false };
  if (/^close options$/.test(text)) return { type: "close_options", mutates: false };
  if (/^close voice$/.test(text)) return { type: "close_voice", mutates: false };
  if (/^flip( the)? surname$/.test(text)) return { type: "flip", mutates: true };
  if (/^(shortest|least used|best|balanced) options$/.test(text)) {
    return { type: "sort", sort: text.startsWith("shortest") ? "shortest" : text.startsWith("least") ? "least-used" : "balanced", mutates: false };
  }
  if (/^(japanese|western) options$/.test(text)) return { type: "language", language: text.split(" ")[0], mutates: false };
  if (/^(iconic|fun|iconic fun) options$/.test(text)) return { type: "name_source", source: "iconic", mutates: false };
  if (/^(normal|regular) options$/.test(text)) return { type: "name_source", source: "normal", mutates: false };
  const suggest = text.match(/^(?:suggest|find|replace)\s+(?:the\s+)?(first(?: name)?|surname(?: part)?\s*(?:one|two|1|2)|surname\s*(?:one|two|1|2))$/);
  if (suggest) {
    const part = suggest[1].startsWith("first") ? "first" : /(?:two|2)$/.test(suggest[1]) ? "surname_part_2" : "surname_part_1";
    return { type: "suggest", part, mutates: false };
  }
  const option = text.match(/^use option\s+(one|two|three|four|five|1|2|3|4|5)(?:\s+as\s+(?:a\s+)?(?:one|1) word)?$/);
  if (option) {
    const optionNumber = { one: 1, two: 2, three: 3, four: 4, five: 5 }[option[1]] || Number(option[1]);
    return { type: "use_option", index: optionNumber - 1, single: /(?:one|1) word$/.test(text), mutates: true };
  }
  const customFirst = text.match(/^set\s+(?:the\s+)?first(?:\s+name)?\s+to\s+(.+?)$/i);
  if (customFirst) return { type: "custom_first", value: customFirst[1], mutates: true };
  const customSurname = text.match(/^set\s+(?:the\s+)?surname(?:\s+part)?\s*(one|two|1|2)\s+to\s+(.+?)$/i);
  if (customSurname) return {
    type: "custom_surname",
    part: /^(two|2)$/i.test(customSurname[1]) ? "surname_part_2" : "surname_part_1",
    value: customSurname[2],
    mutates: true
  };
  if (/^lock( the)? remaining$|^lock all$/.test(text)) return { type: "lock_remaining", mutates: true };
  if (/^replace( the)? whole name$|^mark( the)? whole name( for)? replacement$/.test(text)) return { type: "replace_whole", mutates: true };
  if (/^clear( the)? character$|^clear all decisions$/.test(text)) return { type: "clear_character", mutates: true };
  const partAction = text.match(/^(lock|approve|clear|mark)\s+(?:the\s+)?(first(?: name)?|surname(?: part)?\s*(?:one|two|1|2)|surname\s*(?:one|two|1|2))(?:\s+for\s+replacement)?$/);
  if (partAction) {
    const part = partAction[2].startsWith("first") ? "first" : /(?:two|2)$/.test(partAction[2]) ? "surname_part_2" : "surname_part_1";
    const action = partAction[1] === "approve" ? "lock" : partAction[1];
    return { type: "part_action", action, part, mutates: true };
  }
  return { type: "unknown", raw: text, mutates: false };
}

const VOICE_CANONICAL_COMMANDS = [
  "confirm", "cancel", "stop speaking", "repeat", "next undecided", "next", "previous",
  "focus mode", "browse mode", "read character", "read name", "read traits", "read status",
  "read options", "close options", "close voice", "flip surname", "shortest options",
  "least used options", "best options", "japanese options", "western options", "iconic options",
  "normal options", "suggest first", "suggest surname one", "suggest surname two",
  "use option one", "use option two", "use option three", "use option four", "use option five",
  "lock first", "lock surname one", "lock surname two", "replace first",
  "mark surname one for replacement", "mark surname two for replacement", "lock remaining",
  "replace whole name", "clear character"
];

function editDistance(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

function voiceSimilarity(left, right) {
  const a = normalizeVoiceText(left);
  const b = normalizeVoiceText(right);
  if (!a || !b) return 0;
  const characterScore = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  const aWords = new Set(a.split(" "));
  const bWords = new Set(b.split(" "));
  const shared = [...aWords].filter(word => bWords.has(word)).length;
  const wordScore = shared / Math.max(aWords.size, bWords.size);
  return characterScore * .68 + wordScore * .32;
}

function parseVoiceIntent(raw) {
  const normalized = normalizeVoiceText(raw);
  let intent = parseVoiceIntentExact(normalized);
  if (intent.type !== "unknown") {
    return normalizeVoiceText(raw) === String(raw || "").toLowerCase().trim()
      ? intent
      : { ...intent, interpreted_as: normalized, correction_score: 1 };
  }

  if (/\bfirst\b/.test(normalized) && /\b(suggest|find|show|open|change|replace|options?)\b/.test(normalized)) {
    return { type: "suggest", part: "first", mutates: false, interpreted_as: "suggest first" };
  }
  if (/\bsurname\b/.test(normalized) && /\b(suggest|find|show|open|change|replace|options?)\b/.test(normalized)) {
    const part = /\b(two|2|second)\b/.test(normalized) ? "surname_part_2" : "surname_part_1";
    return { type: "suggest", part, mutates: false, interpreted_as: `suggest surname ${part === "surname_part_2" ? "two" : "one"}` };
  }

  const ranked = VOICE_CANONICAL_COMMANDS
    .map(command => ({ command, score: voiceSimilarity(normalized, command) }))
    .sort((left, right) => right.score - left.score);
  if (ranked[0]?.score >= .67 && ranked[0].score - (ranked[1]?.score || 0) >= .035) {
    intent = parseVoiceIntentExact(ranked[0].command);
    if (intent.type !== "unknown") return { ...intent, interpreted_as: ranked[0].command, correction_score: ranked[0].score };
  }
  return intent;
}

function voicePartLabel(key) {
  return key === "first" ? "first name" : key === "surname_part_2" ? "surname part two" : "surname part one";
}

function requestVoiceConfirmation(label, action) {
  state.voice.pending = { label, action, characterId: String(state.selected?.id || "") };
  setVoiceVisualState("confirm", "Confirmation needed", `Say “confirm” to ${label}, or “cancel”.`);
  updateVoiceWorkspace();
  return speakVoice(`Ready to ${label}. Say confirm to save, or cancel.`);
}

function clearCharacterConfirmed() {
  const timestamp = nowIso();
  state.curation.records[state.selected.id] = {
    note: "",
    note_updated_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp,
    parts: {}
  };
  saveCuration();
  renderCharacter();
  updateProgress();
  renderRoster();
}

async function executeVoiceCommand(raw) {
  const spoken = String(raw || "").trim();
  if (!spoken) return;
  setVoiceDock(true);
  state.voice.lastTranscript = spoken;
  const intent = parseVoiceIntent(spoken);
  els.voiceTranscript.textContent = intent.interpreted_as && spoken.toLowerCase().trim() !== intent.interpreted_as
    ? `${spoken} → ${intent.interpreted_as}`
    : spoken;
  if (intent.interpreted_as) {
    setVoiceVisualState("ready", "Command corrected", `Understood “${intent.interpreted_as}”.`);
  }

  if (intent.type === "confirm") {
    const pending = state.voice.pending;
    if (!pending) return speakVoice("There is no pending change to confirm.");
    if (pending.characterId !== String(state.selected?.id || "")) {
      state.voice.pending = null;
      return speakVoice("That confirmation was cancelled because the selected character changed.");
    }
    state.voice.pending = null;
    try {
      await pending.action();
      setVoiceVisualState("ready", "Saved", `Saved for character ${state.selected.id}.`);
      return speakVoice(`Saved. The current full name is ${effectiveDisplayName(state.selected)}.`);
    } catch (error) {
      setVoiceVisualState("error", "Could not save", error.message);
      return speakVoice(`I could not save that change. ${error.message}`);
    }
  }
  if (intent.type === "cancel") {
    state.voice.pending = null;
    setVoiceVisualState("ready", "Cancelled", "No change was saved.");
    updateVoiceWorkspace();
    return speakVoice("Cancelled. Nothing was changed.");
  }
  if (state.voice.pending) {
    return speakVoice("A change is waiting. Say confirm or cancel before another command.");
  }
  if (intent.type === "stop_speaking") {
    window.speechSynthesis?.cancel();
    return;
  }
  if (intent.type === "repeat") return speakVoice(state.voice.lastSpoken || readCurrentCharacter());
  if (intent.type === "move") {
    moveSelection(intent.direction);
    return speakVoice(readCurrentCharacter("character"));
  }
  if (intent.type === "next_undecided") {
    nextUndecided();
    return speakVoice(readCurrentCharacter("character"));
  }
  if (intent.type === "go_to") {
    const exists = state.data.characters.some(character => String(character.id) === intent.id);
    if (!exists) return speakVoice(`Character ${intent.id} was not found.`);
    selectById(intent.id);
    return speakVoice(readCurrentCharacter("character"));
  }
  if (intent.type === "view") {
    setViewMode(intent.mode);
    return speakVoice(`${intent.mode} mode enabled.`);
  }
  if (intent.type === "read") return speakVoice(readCurrentCharacter(intent.section));
  if (intent.type === "read_options") return speakVoice(readVoiceOptions());
  if (intent.type === "close_options") {
    if (els.suggestionDialog.open) els.suggestionDialog.close();
    return speakVoice("Options closed.");
  }
  if (intent.type === "close_voice") {
    setVoiceDock(false);
    return;
  }
  if (intent.type === "sort") {
    state.suggestionSort = intent.sort;
    renderSuggestionOptions();
    return speakVoice(`${intent.sort.replace("-", " ")} ranking selected. ${readVoiceOptions()}`);
  }
  if (intent.type === "language") {
    if (!state.suggestionPart) return speakVoice("Open a name part first. Say suggest first, surname one, or surname two.");
    await openSuggestions(state.suggestionPart, intent.language, state.suggestionSource);
    return speakVoice(`${intent.language} bank loaded. ${readVoiceOptions()}`);
  }
  if (intent.type === "name_source") {
    if (state.suggestionPart !== "first") return speakVoice("Iconic and normal sources apply to first names. Say suggest first, then iconic options.");
    await openSuggestions("first", "western", null, intent.source);
    return speakVoice(`${intent.source === "iconic" ? "Iconic and fun" : "Normal"} first-name bank loaded. ${readVoiceOptions()}`);
  }
  if (intent.type === "suggest") {
    const available = partDefinitions(state.selected).some(part => part.key === intent.part && part.available);
    if (!available) return speakVoice(`${voicePartLabel(intent.part)} is not active on this character.`);
    await openSuggestions(intent.part);
    return speakVoice(readVoiceOptions());
  }
  if (intent.type === "use_option") {
    const entry = sortedSuggestionEntries()[intent.index];
    if (!entry) return speakVoice("That option is not available. Say read options.");
    const fullName = intent.single
      ? entry.candidate.single_preview?.full_name || entry.candidate.value
      : entry.preview.full_name || entry.candidate.preview_full_name || entry.candidate.value;
    return requestVoiceConfirmation(`use ${fullName}`, () =>
      chooseSuggestion(entry.candidate, entry.order, intent.single)
    );
  }
  if (intent.type === "flip") {
    if (!canFlipSurname(state.selected)) return speakVoice("This character does not have two active surname parts to flip.");
    const flipped = surnameOrder(state.selected) === "12" ? "21" : "12";
    const currentId = state.selected.id;
    const preview = composeSurname(
      state.selected,
      effectivePartValue(state.selected, "surname_part_1"),
      effectivePartValue(state.selected, "surname_part_2"),
      flipped,
      surnameJoinStyle(state.selected)
    );
    return requestVoiceConfirmation(`flip the surname to ${preview}`, () => {
      if (state.selected.id !== currentId) throw new Error("Character changed.");
      setSurnameOrder(flipped, { announce: false });
    });
  }
  if (intent.type === "custom_first") {
    const value = normalizeManualFirstName(intent.value);
    if (!value) return speakVoice("That first name is not valid. Use two to twenty English letters, with an optional apostrophe or hyphen.");
    const usageCount = manualFirstNameUsage(value);
    if (usageCount) return speakVoice(`${value} is already used ${usageCount} times elsewhere. First names must remain unique.`);
    const fullName = `${value} ${effectiveSurname(state.selected)}`.trim();
    return requestVoiceConfirmation(`set the Western first name to ${value}. Full name ${fullName}`, () => {
      const definition = partDefinitions(state.selected).find(part => part.key === "first");
      const traitSource = `Clothing:${state.selected.clothing || "No clothing trait"}`;
      updatePartReview("first", {
        decision: "replace", scope: "this_character", disabled: false,
        replacement_value: value,
        replacement_source: "Manual team edit · Western clothing theme",
        replacement_trait_source: traitSource,
        replacement_language: "western",
        replacement_rationale: `Voice-curated Western first name for ${traitSource}. Replaced “${definition?.value || ""}” with the collection-unique “${value}”. Full-name preview: ${fullName}.`,
        replacement_scores: null
      });
    });
  }
  if (intent.type === "custom_surname") {
    const value = normalizeManualSurnamePart(intent.value);
    if (!value) return speakVoice("That surname fragment is not valid. Use two to twenty English letters with no spaces or symbols.");
    const available = partDefinitions(state.selected).some(part => part.key === intent.part && part.available);
    if (!available) return speakVoice(`${voicePartLabel(intent.part)} is not active on this character.`);
    state.suggestionPart = intent.part;
    state.suggestionLanguage = "western";
    state.suggestionSource = effectivePartSource(state.selected, intent.part);
    state.suggestionPreviewOrder = surnameOrder(state.selected);
    state.suggestionJoinStyle = surnameJoinStyle(state.selected);
    const preview = manualSurnamePreview(value);
    if (!preview) return speakVoice("I could not build a safe surname preview from that fragment.");
    return requestVoiceConfirmation(`set ${voicePartLabel(intent.part)} to ${value}. Full name ${preview.fullName}`, () => {
      const definition = partDefinitions(state.selected).find(part => part.key === intent.part);
      const traitSource = state.suggestionSource || definition?.source || "";
      updatePartReview(intent.part, {
        decision: "replace", scope: "this_character", disabled: false,
        replacement_value: value,
        replacement_source: "Manual team edit",
        replacement_trait_source: traitSource,
        replacement_language: "western",
        replacement_rationale: `Voice-curated by the team for ${traitSource || "this character's trait"}. Replaced “${definition?.value || ""}” with “${value}”. Full-name preview: ${preview.fullName}. Readability ${preview.scores.readability.toFixed(1)}/10; collectability ${preview.scores.collectability.toFixed(1)}/10.`,
        replacement_scores: preview.scores
      });
    });
  }
  if (intent.type === "lock_remaining") {
    return requestVoiceConfirmation("lock every undecided name part", approveRemaining);
  }
  if (intent.type === "replace_whole") {
    return requestVoiceConfirmation("mark the whole name for replacement", replaceWholeName);
  }
  if (intent.type === "clear_character") {
    return requestVoiceConfirmation("clear all decisions for this character", clearCharacterConfirmed);
  }
  if (intent.type === "part_action") {
    const available = partDefinitions(state.selected).some(part => part.key === intent.part && part.available);
    if (!available) return speakVoice(`${voicePartLabel(intent.part)} is not active on this character.`);
    const label = intent.action === "lock" ? `lock ${voicePartLabel(intent.part)}` :
      intent.action === "clear" ? `clear the decision on ${voicePartLabel(intent.part)}` :
        `mark ${voicePartLabel(intent.part)} for replacement`;
    const decision = intent.action === "lock" ? "approve" : intent.action === "clear" ? "clear" : "replace";
    return requestVoiceConfirmation(label, () => setPartDecision(intent.part, decision));
  }
  setVoiceVisualState("error", "Command not recognized", "Say “commands” to open the guide.");
  if (/^(commands|help|voice help)$/.test(normalizeVoiceText(spoken))) {
    els.voiceHelpDialog.showModal();
    return speakVoice("The voice command guide is open.");
  }
  return speakVoice("I did not recognize that command. Say commands to open the guide.");
}

function initVoiceControl() {
  loadVoiceSettings();
  els.voicePersonality.value = state.voice.settings.personality;
  els.voiceRate.value = String(state.voice.settings.rate);
  els.voiceRateValue.textContent = `${state.voice.settings.rate.toFixed(2)}×`;
  populateVoiceChoices();
  if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = populateVoiceChoices;
  els.voiceMuteButton.textContent = state.voice.muted ? "Voice back off" : "Voice back on";
  els.voiceMuteButton.setAttribute("aria-pressed", String(state.voice.muted));
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    els.voiceMicButton.disabled = true;
    els.voiceMicButton.querySelector("b").textContent = "Use dictation";
    return;
  }
  const recognition = new Recognition();
  recognition.lang = "en-US";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 5;
  recognition.onstart = () => {
    state.voice.listening = true;
    els.voiceMicButton.setAttribute("aria-pressed", "true");
    els.voiceMicButton.classList.add("active");
    setVoiceVisualState("listening", "Listening", "Say one command clearly.");
  };
  recognition.onresult = event => {
    let transcript = "";
    let isFinal = false;
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      const alternatives = Array.from(result);
      const rankedAlternatives = alternatives
        .map(alternative => ({
          transcript: alternative.transcript,
          intent: parseVoiceIntent(alternative.transcript),
          confidence: Number(alternative.confidence || 0)
        }))
        .sort((left, right) =>
          Number(right.intent.type !== "unknown") - Number(left.intent.type !== "unknown") ||
          Number(right.intent.correction_score || 0) - Number(left.intent.correction_score || 0) ||
          right.confidence - left.confidence
        );
      transcript += rankedAlternatives[0]?.transcript || result[0].transcript;
      isFinal ||= event.results[index].isFinal;
    }
    els.voiceTranscript.textContent = transcript.trim() || "Listening…";
    if (isFinal) executeVoiceCommand(transcript.trim());
  };
  recognition.onerror = event => {
    state.voice.listening = false;
    if (event.error === "aborted") return;
    const denied = event.error === "not-allowed" || event.error === "service-not-allowed";
    setVoiceVisualState(
      "error",
      denied ? "Microphone blocked" : "Could not hear that",
      denied
        ? "Allow microphone access, or use phone keyboard dictation below."
        : "Tap Listen and try one short command."
    );
  };
  recognition.onend = () => {
    state.voice.listening = false;
    els.voiceMicButton.setAttribute("aria-pressed", "false");
    els.voiceMicButton.classList.remove("active");
    document.body.classList.remove("voice-listening");
    if (state.voice.handsFree && !state.voice.manualStop && !window.speechSynthesis?.speaking && !els.voiceDock.hidden) {
      setTimeout(startVoiceListening, 320);
    }
  };
  state.voice.recognition = recognition;
}

async function copyText(value, successMessage) {
  const result = startClipboardTextWrite(value);
  if (!await result.completion) throw new Error("This browser blocked clipboard access.");
  showToast(successMessage, "success");
}

function legacyClipboardTextWrite(value) {
  const textarea = document.createElement("textarea");
  textarea.value = String(value || "");
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = Boolean(document.execCommand?.("copy"));
  } catch (_) {
    copied = false;
  }
  textarea.remove();
  return copied;
}

function startClipboardTextWrite(value) {
  const text = String(value || "");
  // Start both copy paths while the Name Studio tab is still focused and the
  // button tap still carries Android's transient clipboard permission.
  const legacyCopied = legacyClipboardTextWrite(text);
  let modernCopy = null;
  try {
    modernCopy = navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : null;
  } catch (_) {
    modernCopy = null;
  }
  return {
    legacyCopied,
    completion: modernCopy
      ? Promise.resolve(modernCopy).then(() => true).catch(() => legacyCopied)
      : Promise.resolve(legacyCopied)
  };
}

function exactTraitsText(character) {
  return (character.traits || []).map(trait => `${trait.type}: ${trait.value}`).join("\n");
}

function reviewPacketText(character) {
  const normalized = normalizedSurnameFor(character);
  const status = curationStatus(character);
  const record = recordFor(character.id);
  const components = (normalized.surname_components || []).map(component =>
    `${component.order}. ${component.text} ← ${component.source_raw}`
  ).join("\n") || "Unresolved — use Fix surname sources";
  const decisionLabel = decision => decision === "approve"
    ? "GREENLIT — do not change"
    : decision === "replace"
      ? "RED X — replacement requested"
      : "UNDECIDED";
  return [
    `?an!c Name Studio review packet`,
    `Character: #${character.id}`,
    `Current name: ${effectiveDisplayName(character)}`,
    `Clothing: ${character.clothing}`,
    `Body gender route: ${character.gender_from_body}`,
    `First name: ${effectivePartValue(character, "first")} — ${decisionLabel(partReview(character.id, "first").decision)}`,
    `Surname part 1: ${effectivePartValue(character, "surname_part_1") || "—"} — ${decisionLabel(partReview(character.id, "surname_part_1").decision)}`,
    `Surname part 2: ${effectivePartValue(character, "surname_part_2") || "—"} — ${decisionLabel(partReview(character.id, "surname_part_2").decision)}`,
    `Curation: ${status.label}`,
    `Surname repair needed: ${normalized.needs_surname_component_repair ? "yes" : "no"}`,
    `Surname components:\n${components}`,
    `Exact traits:\n${exactTraitsText(character)}`,
    `Character note: ${record.note || "—"}`,
  ].join("\n\n");
}

function handoffFirstNameBankText(character, candidates = []) {
  const language = effectiveFirstLanguage(character);
  const route = `Clothing:${character.clothing} + Body:${character.gender_from_body}`;
  if (!candidates.length) {
    return [
      `LIVE FIRST-NAME BANK FOR THIS CHARACTER`,
      `Route: ${route}`,
      `Language: ${language}`,
      `No unused alternatives were returned by the live bank. Do not invent replacements; review the current first name only.`
    ].join("\n");
  }
  return [
    `LIVE FIRST-NAME BANK FOR THIS CHARACTER — ${candidates.length} UNUSED OPTIONS`,
    `Route: ${route}`,
    `Language: ${language}`,
    `These options were fetched from the current Name Studio bank and checked against all current/proposed first names. They remain authoritative even if an older ChatGPT upload expired.`,
    ...candidates.map((candidate, index) =>
      `${index + 1}. ${candidate.name} — ${candidate.source}${candidate.connection ? ` — ${candidate.connection}` : ""}`
    )
  ].join("\n");
}

function chatGptHandoffText(character, firstNameCandidates = []) {
  const firstDecision = partReview(character.id, "first").decision;
  const surnameOpen = ["surname_part_1", "surname_part_2"].some(key =>
    partDefinitions(character).find(part => part.key === key)?.available &&
    partReview(character.id, key).decision !== "approve"
  );
  return [
    `Continue our existing ?an!c Name Studio naming workflow for the attached character.`,
    `Use the master naming instructions and any Markdown research files already attached in this editable ChatGPT conversation. Treat the exact live data and inline bank below as current.`,
    `Rules for this review:`,
    `- Never change a component marked GREENLIT.`,
    `- Respect the Body-only gender route for first names.`,
    `- Keep a Western surname as one collector-visible word made from exactly two auditable, eligible character-trait components unless I explicitly request a one-word Japanese surname.`,
    `- Do not invent Japanese names; use only the closed Japanese bank already supplied.`,
    `- Prefer readable, collectible, trait-recognizable combinations and explain the two exact source routes.`,
    `- Do not save or assume a replacement until I approve it.`,
    `Required response format:`,
    firstDecision === "approve"
      ? `- The first name is GREENLIT. Preserve it and do not offer first-name replacements.`
      : `- Start with 15–20 ranked one-word first-name choices selected ONLY from the inline live bank below. If fewer than 15 are supplied, show every supplied option and report the exact shortage. Never say the bank is unavailable and never invent an option.`,
    surnameOpen
      ? `- Then provide 20–30 strong Western surname choices using exactly two different eligible traits from this packet, followed by the 5 strongest complete full-name combinations.`
      : `- Preserve every GREENLIT surname component. Only discuss an alternative if a surname component is open or RED X.`,
    `- Keep the answer easy to scan: first-name table, surname table, then top full-name combinations.`,
    `Portrait URL: ${window.location.origin}/pfps_webp/${character.id}.webp`,
    handoffFirstNameBankText(character, firstNameCandidates),
    `Inspect the portrait and packet, identify only the parts still open or marked for replacement, and obey the option counts above.`,
    reviewPacketText(character)
  ].join("\n\n");
}

async function fetchHandoffFirstNameCandidates(character) {
  const language = effectiveFirstLanguage(character);
  const sources = language === "western" ? ["iconic", "normal"] : ["normal"];
  const responses = await Promise.allSettled(sources.map(async nameSource => {
    const params = new URLSearchParams({
      id: character.id,
      part: "first",
      language,
      name_source: nameSource,
      request: `handoff-${Date.now()}-${nameSource}`
    });
    const response = await fetch(`/api/suggestions?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.suggestions || []).map(candidate => ({
      name: candidate.value,
      source: candidate.source || `${language} ${character.clothing} bank`,
      connection: candidate.fit || candidate.iconic_reference || "",
      nameSource
    }));
  }));
  const bySource = Object.fromEntries(sources.map((source, index) => [
    source,
    responses[index].status === "fulfilled" ? responses[index].value : []
  ]));
  const pool = language === "western"
    ? [...(bySource.iconic || []).slice(0, 10), ...(bySource.normal || []).slice(0, 24)]
    : [...(bySource.normal || []).slice(0, 24)];
  const seen = new Set();
  return pool.filter(candidate => {
    const key = String(candidate.name || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function activeChatGptHandoffPacket(character = state.selected) {
  return state.chatGptHandoff.characterId === String(character?.id) && state.chatGptHandoff.packet
    ? state.chatGptHandoff.packet
    : chatGptHandoffText(character, []);
}

function validChatGptConversationUrl(value) {
  if (!String(value || "").trim()) {
    throw new Error("Paste the address of your prepared ChatGPT conversation first. Name Studio will remember it on this device.");
  }
  let url;
  try {
    url = new URL(String(value).trim());
  } catch (_) {
    throw new Error("Enter a valid ChatGPT conversation link, such as https://chatgpt.com/c/…");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(host)) {
    throw new Error("Use the private address of an editable chatgpt.com conversation.");
  }
  if (/^\/(share|s)(\/|$)/i.test(url.pathname)) {
    throw new Error("This is a public Shared conversation link. It is read-only and creates a separate chat. Open your original editable conversation and copy its /c/ address instead.");
  }
  if (!/\/c\/[^/]+/i.test(url.pathname)) {
    throw new Error("This is not an editable conversation address. Open the exact ChatGPT chat, then copy the address containing /c/ from Chrome’s top bar.");
  }
  return url.href;
}

function updateSavedChatControls() {
  const raw = els.chatgptChatUrl.value.trim();
  let valid = false;
  let message = "No conversation saved yet.";
  if (raw) {
    try {
      const url = validChatGptConversationUrl(raw);
      valid = true;
      message = state.chatGptHandoff.packet
        ? "Ready: editable conversation verified and live first-name bank attached."
        : "Editable conversation verified. Preparing the live first-name bank…";
    } catch (error) {
      message = error.message;
    }
  }
  els.chatgptOpenSavedChat.disabled = !valid || !state.chatGptHandoff.packet;
  els.chatgptSavedChatState.textContent = message;
  els.chatgptSavedChatState.className = `chatgpt-saved-chat-state ${valid ? "success" : raw ? "error" : ""}`.trim();
}

async function characterPortraitPngBlob(character = state.selected) {
  const response = await fetch(`/pfps_webp/${character.id}.webp`);
  if (!response.ok) throw new Error("Portrait could not be loaded.");
  const sourceBlob = await response.blob();
  let drawable;
  let cleanup = () => {};
  if (window.createImageBitmap) {
    drawable = await createImageBitmap(sourceBlob);
    cleanup = () => drawable.close?.();
  } else {
    const objectUrl = URL.createObjectURL(sourceBlob);
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    drawable = image;
    cleanup = () => URL.revokeObjectURL(objectUrl);
  }
  const canvas = document.createElement("canvas");
  canvas.width = drawable.width || drawable.naturalWidth;
  canvas.height = drawable.height || drawable.naturalHeight;
  canvas.getContext("2d").drawImage(drawable, 0, 0);
  cleanup();
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("Portrait could not be converted for sharing.");
  return png;
}

function setChatGptHandoffStatus(message, tone = "") {
  els.chatgptHandoffStatus.textContent = message;
  els.chatgptHandoffStatus.className = `chatgpt-handoff-status ${tone}`.trim();
}

function openChatGptHandoff() {
  const character = state.selected;
  const generation = ++state.chatGptHandoff.generation;
  state.chatGptHandoff.characterId = String(character.id);
  state.chatGptHandoff.bundle = null;
  state.chatGptHandoff.packet = null;
  state.chatGptHandoff.firstNameCandidates = [];
  els.chatgptHandoffPortrait.src = `/pfps_webp/${character.id}.webp`;
  els.chatgptHandoffPortrait.alt = `Portrait of survivor ${character.id}`;
  els.chatgptHandoffToken.textContent = `Survivor #${character.id}`;
  els.chatgptHandoffName.textContent = effectiveDisplayName(character);
  els.chatgptHandoffTrait.textContent = `${character.clothing} · ${character.gender_from_body} Body route`;
  els.chatgptChatUrl.value = localStorage.getItem(CHATGPT_HANDOFF_KEY) || "";
  updateSavedChatControls();
  els.chatgptPacketPreview.value = "Loading live unused first-name candidates for this character…";
  els.chatgptNativeShare.disabled = true;
  els.chatgptCopyPacket.disabled = true;
  els.chatgptNativeShare.querySelector("b").textContent = "Preparing secure share…";
  setChatGptHandoffStatus("Preparing the portrait before enabling Android sharing…");
  els.chatgptHandoffDialog.showModal();
  prepareChatGptShareBundle(character, generation);
}

async function prepareChatGptShareBundle(character, generation) {
  try {
    const [png, firstNameCandidates] = await Promise.all([
      characterPortraitPngBlob(character),
      fetchHandoffFirstNameCandidates(character)
    ]);
    const packet = chatGptHandoffText(character, firstNameCandidates);
    const portraitFile = new File([png], `panic-survivor-${character.id}.png`, { type: "image/png" });
    const packetFile = new File([packet], `panic-survivor-${character.id}-review.md`, { type: "text/markdown" });
    if (generation !== state.chatGptHandoff.generation || String(character.id) !== String(state.selected?.id)) return;
    state.chatGptHandoff.packet = packet;
    state.chatGptHandoff.firstNameCandidates = firstNameCandidates;
    state.chatGptHandoff.bundle = { characterId: String(character.id), packet, portraitFile, packetFile };
    els.chatgptPacketPreview.value = packet;
    els.chatgptNativeShare.disabled = false;
    els.chatgptCopyPacket.disabled = false;
    els.chatgptNativeShare.querySelector("b").textContent = "Share portrait + packet";
    updateSavedChatControls();
    setChatGptHandoffStatus(`Ready with ${firstNameCandidates.length} unused first-name options from the live bank. ChatGPT is instructed to rank 15–20 when the first name is open.`, "success");
  } catch (error) {
    if (generation !== state.chatGptHandoff.generation) return;
    state.chatGptHandoff.packet = null;
    els.chatgptNativeShare.disabled = true;
    els.chatgptCopyPacket.disabled = true;
    els.chatgptNativeShare.querySelector("b").textContent = "Share unavailable";
    updateSavedChatControls();
    setChatGptHandoffStatus(error.message || "The portrait could not be prepared for sharing.", "error");
  }
}

async function fallbackChatGptShare(bundle) {
  let copied = false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(bundle.packet);
    copied = true;
  } else {
    downloadExportFile(bundle.packetFile, bundle.packetFile.name);
  }
  downloadExportFile(bundle.portraitFile, bundle.portraitFile.name);
  setChatGptHandoffStatus(
    copied
      ? "Native sharing is unavailable here. The packet was copied and the portrait downloaded; paste both into your ChatGPT conversation."
      : "Native sharing and clipboard access are unavailable here. The portrait and Markdown packet were downloaded for you to attach in ChatGPT.",
    "success"
  );
}

async function shareCharacterToChatGpt() {
  const bundle = state.chatGptHandoff.bundle;
  if (!bundle || bundle.characterId !== String(state.selected?.id)) {
    setChatGptHandoffStatus("The share packet is still preparing. Wait for the green button to say it is ready.", "error");
    return;
  }
  try {
    if (navigator.share && navigator.canShare?.({ files: [bundle.portraitFile] })) {
      // Call share immediately inside the tap handler. Android expires the required
      // user activation if image fetching or conversion happens before this call.
      const shareOperation = navigator.share({
        files: [bundle.portraitFile],
        title: `?an!c survivor #${bundle.characterId} naming review`,
        text: bundle.packet
      });
      setChatGptHandoffStatus("Opening your phone’s share sheet…");
      await shareOperation;
      setChatGptHandoffStatus("Shared the portrait and complete review text. No Name Studio data changed.", "success");
      return;
    }
    if (navigator.share) {
      const shareOperation = navigator.share({
        title: `?an!c survivor #${bundle.characterId} naming review`,
        text: bundle.packet
      });
      setChatGptHandoffStatus("This browser cannot attach the portrait automatically. Opening a text share instead…");
      await shareOperation;
      downloadExportFile(bundle.portraitFile, bundle.portraitFile.name);
      setChatGptHandoffStatus("Shared the review text and downloaded the portrait for attachment.", "success");
      return;
    }
    await fallbackChatGptShare(bundle);
  } catch (error) {
    if (error?.name === "AbortError") {
      setChatGptHandoffStatus("Sharing cancelled. No Name Studio data changed.");
      return;
    }
    const denied = error?.name === "NotAllowedError" || /permission denied/i.test(String(error?.message || ""));
    setChatGptHandoffStatus(
      denied
        ? "Android blocked the native share sheet. Tap Copy packet + open saved chat below; the portrait is also available with Copy portrait."
        : (error.message || "The handoff could not be shared."),
      "error"
    );
  }
}

async function copyPacketAndOpenSavedChat() {
  let target;
  try {
    target = validChatGptConversationUrl(els.chatgptChatUrl.value);
  } catch (error) {
    setChatGptHandoffStatus(error.message, "error");
    els.chatgptChatUrl.focus();
    return;
  }
  const packet = activeChatGptHandoffPacket();
  // Begin copying before opening another tab. Opening first makes Android
  // remove focus and reject Clipboard.writeText with "Permission denied".
  const copyResult = startClipboardTextWrite(packet);
  // Keep one named ChatGPT tab so repeated handoffs return to the same
  // prepared conversation instead of creating another blank/new chat tab.
  const opened = window.open(target, "panic-name-studio-chatgpt");
  if (opened) opened.opener = null;
  try {
    const copied = await copyResult.completion;
    if (!copied) throw new Error("Chrome blocked clipboard access. Use Copy packet only, then tap Open saved chat again.");
    if (!opened) {
      setChatGptHandoffStatus("The packet is copied. Chrome blocked the new tab, so opening the saved chat in this tab…", "success");
      window.location.assign(target);
      return;
    }
    setChatGptHandoffStatus("Copied the complete packet and opened the same saved ChatGPT conversation. Paste it there; the packet also contains the public portrait URL.", "success");
  } catch (error) {
    setChatGptHandoffStatus(error.message || "Could not open the saved ChatGPT conversation.", "error");
  }
}

async function copyCharacterImage() {
  const png = await characterPortraitPngBlob(state.selected);
  try {
    if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error("Image clipboard unsupported");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    showToast(`Copied survivor #${state.selected.id} portrait as PNG.`, "success");
  } catch (_) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(png);
    link.download = `panic-survivor-${state.selected.id}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    showToast("This browser blocks image clipboard access, so the PNG was downloaded instead.", "warning");
  }
}

function normalizeAssistantComponent(component, order) {
  const source = String(component?.source_raw || "");
  const divider = source.indexOf(":");
  return {
    order,
    text: cleanSurnameComponent(component?.text),
    trait_category: source.slice(0, divider),
    trait_value: source.slice(divider + 1),
    source_raw: source,
    confidence: "ai_proposed_team_selected"
  };
}

async function applyAssistantName(firstName, surnameCandidate, source = "AI structured workshop") {
  const character = state.selected;
  const record = ensureRecord(character.id);
  const currentFirst = effectivePartValue(character, "first");
  const first = normalizeManualFirstName(firstName || currentFirst);
  if (!first) throw new Error("The proposed first name is not a safe one-word name.");
  if (first !== currentFirst && partReview(character.id, "first").decision === "approve") {
    throw new Error("The first name is greenlit. Unlock it before changing it.");
  }
  if (first !== currentFirst && manualFirstNameUsage(first)) throw new Error(`First name “${first}” is already used.`);
  const components = [
    normalizeAssistantComponent(surnameCandidate.component_1, 1),
    normalizeAssistantComponent(surnameCandidate.component_2, 2)
  ];
  const legal = new Set(eligibleSurnameTraits(character).map(trait => `${trait.type}:${trait.value}`));
  if (components.some(component => !component.text || !legal.has(component.source_raw))) {
    throw new Error("The AI surname contains an invalid component or source route.");
  }
  if (components[0].source_raw === components[1].source_raw) throw new Error("The AI surname reused the same trait twice.");
  const surname = `${components[0].text}${components[1].text.charAt(0).toLowerCase()}${components[1].text.slice(1)}`;
  if (String(surnameCandidate.surname || "").toLowerCase() !== surname.toLowerCase()) {
    throw new Error(`The AI display surname does not match its components (${surname}).`);
  }
  if (fullNameAlreadyUsed(first, surname)) throw new Error("That complete full name is already used.");
  if (["surname_part_1", "surname_part_2"].some(key => partReview(character.id, key).decision === "approve")) {
    throw new Error("A surname component is greenlit. Unlock it before applying a new surname.");
  }
  if (first !== currentFirst && state.cloudAuthenticated) {
    const response = await fetch(`/api/first-name-availability?value=${encodeURIComponent(first)}&except_id=${character.id}`);
    const availability = await response.json();
    if (!response.ok || !availability.available) throw new Error(availability.error || `First name “${first}” is no longer available.`);
  }
  const timestamp = nowIso();
  if (first !== currentFirst) {
    const current = partReview(character.id, "first");
    record.parts.first = { ...current, decision: "replace", scope: "this_character", disabled: false, replacement_value: first, replacement_source: source, replacement_trait_source: `Clothing:${character.clothing}`, replacement_language: "western", replacement_rationale: "Selected from the structured in-app naming workshop and revalidated for collection-wide uniqueness at apply time.", updated_at: timestamp, reviewer: state.curation.reviewer || current.reviewer || "", deleted_at: null };
  }
  components.forEach((component, index) => {
    const key = index ? "surname_part_2" : "surname_part_1";
    const current = partReview(character.id, key);
    record.parts[key] = { ...current, decision: "replace", scope: "this_character", disabled: false, replacement_value: component.text, replacement_source: source, replacement_trait_source: component.source_raw, replacement_language: "western", replacement_rationale: surnameCandidate.reason || `AI-proposed component for ${component.source_raw}; selected by the team.`, replacement_scores: { readability: surnameCandidate.readability, collectability: surnameCandidate.collectability }, updated_at: timestamp, reviewer: state.curation.reviewer || current.reviewer || "", deleted_at: null };
  });
  record.surname_order = "12";
  record.surname_order_updated_at = timestamp;
  record.surname_join_style = "lower_second";
  record.surname_join_style_updated_at = timestamp;
  record.surname_format_version = SURNAME_FORMAT_VERSION;
  record.normalized_name = { first_name: first, surname_display: surname, surname_components: components, surname_join_style: "lower_second", surname_format_version: SURNAME_FORMAT_VERSION, derivation_method: "ai_structured", needs_surname_component_repair: false };
  record.normalized_name_updated_at = timestamp;
  record.naming_assistant_history = [...(record.naming_assistant_history || []), { at: timestamp, by: state.curation.reviewer || "Team", action: "applied", full_name: `${first} ${surname}`, source }].slice(-20);
  record.updated_at = timestamp;
  saveCuration();
  renderCharacter();
  updateProgress();
  renderRoster();
  showToast(`Applied ${first} ${surname} with two verified trait sources.`, "success");
}

function assistantCard(title, subtitle, body, actions = "") {
  return `<article class="assistant-card"><header><div><span>${escapeHtml(subtitle)}</span><h4>${escapeHtml(title)}</h4></div></header><p>${escapeHtml(body)}</p>${actions}</article>`;
}

function renderNamingAssistant() {
  const payload = state.namingAssistant.payload;
  if (!payload?.result) {
    els.namingAssistantResults.innerHTML = `<div class="assistant-empty"><b>Ready for a trait-locked workshop</b><p>Generate ranked first names, structured two-trait surnames, and full-name combinations for the selected survivor.</p><button id="assistantGenerateButton">Generate workshop</button></div>`;
    $("assistantGenerateButton").addEventListener("click", () => requestNamingWorkshop());
    return;
  }
  const result = payload.result;
  els.namingAssistantResults.innerHTML = `
    <section><div class="assistant-section-title"><span>Best complete combinations</span><b>${result.full_names.length}</b></div><div class="assistant-card-grid">${result.full_names.map((item, index) => assistantCard(`${item.first_name} ${item.surname}`, `Full name · ${item.readability}/10 read · ${item.collectability}/10 collect`, item.reason, `<button data-ai-apply-full="${index}">Apply exact full name</button><button data-ai-copy-full="${index}">Copy</button>`)).join("")}</div></section>
    <section><div class="assistant-section-title"><span>First-name bank choices</span><b>${result.first_names.length}</b></div><div class="assistant-chip-grid">${result.first_names.map((item, index) => `<button data-ai-first="${index}"><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.tier)} · ${Number(item.score).toFixed(1)}</span><small>${escapeHtml(item.reason)}</small></button>`).join("")}</div></section>
    <section><div class="assistant-section-title"><span>Two-trait surname choices</span><b>${result.surnames.length}</b></div><div class="assistant-card-grid">${result.surnames.map((item, index) => assistantCard(item.surname, `${item.component_1.source_raw} + ${item.component_2.source_raw}`, item.reason, `<div class="assistant-score-row"><span>Read ${item.readability}/10</span><span>Collect ${item.collectability}/10</span></div><button data-ai-surname="${index}">Apply surname</button><button data-ai-copy-surname="${index}">Copy</button>`)).join("")}</div></section>`;
  els.namingAssistantResults.querySelectorAll("[data-ai-first]").forEach(button => button.addEventListener("click", () => {
    const item = result.first_names[Number(button.dataset.aiFirst)];
    els.fullNameEditFirstInput.value = item.name;
    openFullNameEditor();
    els.fullNameEditFirstInput.value = item.name;
    updateFullNameEditPreview();
  }));
  els.namingAssistantResults.querySelectorAll("[data-ai-surname]").forEach(button => button.addEventListener("click", async () => {
    try { await applyAssistantName(effectivePartValue(state.selected, "first"), result.surnames[Number(button.dataset.aiSurname)]); } catch (error) { showToast(error.message, "error"); }
  }));
  els.namingAssistantResults.querySelectorAll("[data-ai-apply-full]").forEach(button => button.addEventListener("click", async () => {
    const full = result.full_names[Number(button.dataset.aiApplyFull)];
    const surname = result.surnames.find(item => item.surname.toLowerCase() === full.surname.toLowerCase());
    try { if (!surname) throw new Error("This full-name card lost its structured surname record."); await applyAssistantName(full.first_name, surname); } catch (error) { showToast(error.message, "error"); }
  }));
  els.namingAssistantResults.querySelectorAll("[data-ai-copy-full]").forEach(button => button.addEventListener("click", () => {
    const item = result.full_names[Number(button.dataset.aiCopyFull)];
    copyText(`${item.first_name} ${item.surname}`, "Copied full name.");
  }));
  els.namingAssistantResults.querySelectorAll("[data-ai-copy-surname]").forEach(button => button.addEventListener("click", () => {
    copyText(result.surnames[Number(button.dataset.aiCopySurname)].surname, "Copied surname.");
  }));
}

async function requestNamingWorkshop(feedback = "") {
  if (state.namingAssistant.loading) return;
  state.namingAssistant.loading = true;
  els.namingAssistantStatus.textContent = "Researching this portrait and its legal trait routes…";
  els.namingAssistantResults.innerHTML = `<div class="assistant-loading"><i></i><b>Building a structured workshop</b><span>This can take a minute. No names are changed until you press Apply.</span></div>`;
  try {
    const response = await fetch("/api/naming-assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ character_id: state.selected.id, feedback }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "AI workshop failed.");
    state.namingAssistant.payload = payload;
    els.namingAssistantStatus.textContent = payload.bank ? `${payload.bank.filename} · ${payload.bank.candidates_sent} unused candidates sent securely` : "No matching Clothing Markdown bank is active; surname workshop uses exact traits only.";
    renderNamingAssistant();
  } catch (error) {
    els.namingAssistantStatus.textContent = error.message;
    els.namingAssistantResults.innerHTML = `<div class="assistant-empty error"><b>Workshop unavailable</b><p>${escapeHtml(error.message)}</p><button id="assistantRetryButton">Try again</button></div>`;
    $("assistantRetryButton").addEventListener("click", () => requestNamingWorkshop(feedback));
  } finally {
    state.namingAssistant.loading = false;
  }
}

async function openNamingAssistant() {
  state.namingAssistant.payload = null;
  els.namingAssistantContext.textContent = `#${state.selected.id} · ${state.selected.clothing} · ${state.selected.gender_from_body} Body route`;
  els.namingAssistantDialog.showModal();
  renderNamingAssistant();
  try {
    const response = await fetch("/api/naming-assistant", { cache: "no-store" });
    const status = await response.json();
    state.namingAssistant.configured = Boolean(status.configured);
    els.namingAssistantStatus.textContent = status.configured
      ? `Secure server assistant ready · ${status.model}`
      : "Setup needed: add OPENAI_API_KEY in Vercel. Your ChatGPT login cannot be embedded or exposed to this website.";
  } catch (_) {
    els.namingAssistantStatus.textContent = "Could not check the secure AI connection.";
  }
}

async function loadNameBanks() {
  const response = await fetch("/api/name-banks", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load banks.");
  els.nameBankList.innerHTML = payload.banks.length ? payload.banks.map(bank => `<article><div><b>${escapeHtml(bank.clothing)} · ${escapeHtml(bank.gender)}</b><span>${escapeHtml(bank.filename)}</span></div><strong>${bank.entries.length.toLocaleString()} names</strong><small>v${escapeHtml(bank.version)} · ${escapeHtml(bank.source_kind)}</small></article>`).join("") : `<p>No Markdown banks uploaded yet.</p>`;
}

async function openNameBanks() {
  els.nameBankDialog.showModal();
  try { await loadNameBanks(); } catch (error) { els.nameBankList.innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
}

function bindEvents() {
  els.voiceModeButton.addEventListener("click", () => setVoiceDock(els.voiceDock.hidden));
  els.voiceCloseButton.addEventListener("click", () => setVoiceDock(false));
  els.voiceMicButton.addEventListener("click", () => {
    if (state.voice.listening) stopVoiceListening(true);
    else startVoiceListening();
  });
  els.voiceReadButton.addEventListener("click", () => speakVoice(readCurrentCharacter()));
  els.voiceHandsFreeButton.addEventListener("click", async () => {
    state.voice.handsFree = !state.voice.handsFree;
    els.voiceHandsFreeButton.classList.toggle("active", state.voice.handsFree);
    els.voiceHandsFreeButton.setAttribute("aria-pressed", String(state.voice.handsFree));
    els.voiceHandsFreeButton.textContent = state.voice.handsFree ? "Hands-free on" : "Hands-free off";
    if (state.voice.handsFree) {
      await acquireVoiceWakeLock();
      speakVoice("Hands-free mode on. I will listen again after each reply.");
    } else {
      stopVoiceListening(true);
      releaseVoiceWakeLock();
      speakVoice("Hands-free mode off.", { resume: false });
    }
  });
  els.voiceMuteButton.addEventListener("click", () => {
    state.voice.muted = !state.voice.muted;
    els.voiceMuteButton.classList.toggle("active", state.voice.muted);
    els.voiceMuteButton.setAttribute("aria-pressed", String(state.voice.muted));
    els.voiceMuteButton.textContent = state.voice.muted ? "Voice back off" : "Voice back on";
    saveVoiceSettings();
    if (state.voice.muted) window.speechSynthesis?.cancel();
    else speakVoice("Voice feedback is on.");
  });
  els.voiceHelpButton.addEventListener("click", () => els.voiceHelpDialog.showModal());
  els.voiceHelpClose.addEventListener("click", () => els.voiceHelpDialog.close());
  els.voiceCommandForm.addEventListener("submit", event => {
    event.preventDefault();
    const command = els.voiceCommandInput.value.trim();
    els.voiceCommandInput.value = "";
    executeVoiceCommand(command);
  });
  els.voicePersonality.addEventListener("change", () => {
    state.voice.settings.personality = els.voicePersonality.value;
    saveVoiceSettings();
  });
  els.voiceSelect.addEventListener("change", () => {
    state.voice.settings.voiceURI = els.voiceSelect.value;
    saveVoiceSettings();
  });
  els.voiceRate.addEventListener("input", () => {
    state.voice.settings.rate = Number(els.voiceRate.value) || .8;
    els.voiceRateValue.textContent = `${state.voice.settings.rate.toFixed(2)}×`;
    saveVoiceSettings();
  });
  els.voiceTutorialTest.addEventListener("click", () =>
    speakVoice(`Voice check. Character ${state.selected?.id || 1}. Ready for curation.`)
  );
  els.voiceCommandBoard.querySelectorAll("[data-voice-command]").forEach(button => {
    button.addEventListener("click", () => executeVoiceCommand(button.dataset.voiceCommand));
  });
  els.voiceCommandBoard.querySelectorAll("[data-voice-example]").forEach(button => {
    button.addEventListener("click", () => {
      els.voiceCommandInput.value = `${button.dataset.voiceExample} `;
      els.voiceCommandInput.focus();
      els.voiceCommandInput.setSelectionRange(els.voiceCommandInput.value.length, els.voiceCommandInput.value.length);
    });
  });
  els.viewModeSwitch.querySelectorAll("[data-view-mode]").forEach(button => {
    button.addEventListener("click", () => setViewMode(button.dataset.viewMode));
  });
  els.mobileFiltersButton.addEventListener("click", () => setMobileRoster(true));
  els.closeMobileRoster.addEventListener("click", () => setMobileRoster(false));
  els.mobileRosterScrim.addEventListener("click", () => setMobileRoster(false));
  [
    "search",
    "clothingFilter",
    "traitValueFilter",
    "mixFilter",
    "firstLanguageFilter",
    "surnameLanguageFilter",
    "statusFilter"
  ].forEach(id => {
    $(id).addEventListener(id === "search" ? "input" : "change", applyFilters);
  });
  const setTraitMode = mode => {
    state.traitFilterMode = mode;
    const clothingMode = mode === "clothing";
    els.clothingTab.classList.toggle("active", clothingMode);
    els.anyTraitTab.classList.toggle("active", !clothingMode);
    els.clothingTab.setAttribute("aria-selected", String(clothingMode));
    els.anyTraitTab.setAttribute("aria-selected", String(!clothingMode));
    els.clothingFilterPanel.hidden = !clothingMode;
    els.anyTraitFilterPanel.hidden = clothingMode;
    applyFilters();
  };
  els.clothingTab.addEventListener("click", () => setTraitMode("clothing"));
  els.anyTraitTab.addEventListener("click", () => setTraitMode("any"));
  els.traitTypeFilter.addEventListener("change", () => {
    const type = els.traitTypeFilter.value;
    const counts = {};
    state.data.characters.forEach(character => {
      character.traits
        .filter(trait => trait.type === type && trait.value)
        .forEach(trait => {
          counts[trait.value] = (counts[trait.value] || 0) + 1;
        });
    });
    els.traitValueFilter.disabled = !type;
    els.traitValueFilter.innerHTML =
      `<option value="">Every ${escapeHtml(type || "trait")} value</option>` +
      Object.entries(counts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([value, count]) =>
          `<option value="${escapeHtml(value)}">${escapeHtml(value)} (${count})</option>`
        ).join("");
    applyFilters();
  });

  els.pagePrev.addEventListener("click", () => {
    state.page--;
    renderRoster();
  });
  els.pageNext.addEventListener("click", () => {
    state.page++;
    renderRoster();
  });
  els.previousButton.addEventListener("click", () => moveSelection(-1));
  els.nextButton.addEventListener("click", () => moveSelection(1));
  els.nextUndecidedButton.addEventListener("click", nextUndecided);
  els.approveRemainingButton.addEventListener("click", approveRemaining);
  els.replaceWholeButton.addEventListener("click", replaceWholeName);
  els.clearCharacterButton.addEventListener("click", clearCharacter);
  els.exportButton.addEventListener("click", exportReviews);
  els.activityButton.addEventListener("click", () => {
    renderActivity();
    els.activityDialog.showModal();
  });
  els.activityClose.addEventListener("click", () => els.activityDialog.close());
  els.suggestionClose.addEventListener("click", () => {
    els.suggestionDialog.close();
    updateVoiceWorkspace();
  });
  els.suggestionLanguage.querySelectorAll("[data-language]").forEach(button => {
    button.addEventListener("click", () => {
      openSuggestions(state.suggestionPart, button.dataset.language, state.suggestionSource);
    });
  });
  els.suggestionNameSource.querySelectorAll("[data-name-source]").forEach(button => {
    button.addEventListener("click", () => {
      openSuggestions(
        state.suggestionPart,
        "western",
        state.suggestionSource,
        button.dataset.nameSource
      );
    });
  });
  els.suggestionSearch.addEventListener("input", () => {
    state.suggestionSearch = els.suggestionSearch.value;
    renderSuggestionOptions();
  });
  els.suggestionTraitSourceApply.addEventListener("click", () => {
    const selectedSource = els.suggestionTraitSource.value;
    if (!selectedSource) return;
    state.suggestionSource = selectedSource;
    openSuggestions(
      state.suggestionPart,
      state.suggestionLanguage,
      selectedSource,
      state.suggestionNameSource
    );
  });
  els.suggestionToolbar.querySelectorAll("[data-suggestion-sort]").forEach(button => {
    button.addEventListener("click", () => {
      state.suggestionSort = button.dataset.suggestionSort;
      els.suggestionToolbar.querySelectorAll("[data-suggestion-sort]").forEach(option => {
        option.classList.toggle("active", option === button);
      });
      renderSuggestionOptions();
    });
  });
  els.suggestionFlipCurrent.addEventListener("click", () => {
    state.suggestionPreviewOrder =
      state.suggestionPreviewOrder === "12" ? "21" : "12";
    renderSuggestionCurrentPreview();
    renderSuggestionOptions();
  });
  els.surnameFormatControls.querySelectorAll("[data-join-style]").forEach(button => {
    button.addEventListener("click", () => {
      state.suggestionJoinStyle =
        button.dataset.joinStyle === "lower_second" ? "lower_second" : "camel";
      els.surnameFormatControls.querySelectorAll("[data-join-style]").forEach(option => {
        option.classList.toggle("active", option === button);
      });
      renderSuggestionCurrentPreview();
      renderSuggestionOptions();
      updateManualSurnamePreview();
    });
  });
  els.suggestionUseSingleCurrent.addEventListener("click", () => {
    keepOnlySurnamePart(state.suggestionPart);
  });
  els.manualSurnameInput.addEventListener("input", updateManualSurnamePreview);
  els.manualSurnameSave.addEventListener("click", saveManualSurnamePart);
  els.manualFirstInput.addEventListener("input", updateManualFirstPreview);
  els.manualFirstSave.addEventListener("click", saveManualFirstName);
  els.mobilePrevious.addEventListener("click", () => moveSelection(-1));
  els.mobileApprove.addEventListener("click", approveRemaining);
  els.mobileNext.addEventListener("click", () => moveSelection(1));
  els.focusPreviousButton.addEventListener("click", () => moveSelection(-1));
  els.focusNextButton.addEventListener("click", () => moveSelection(1));
  els.focusApproveNextButton.addEventListener("click", approveRemainingAndNext);
  els.focusNextUndecidedButton.addEventListener("click", nextUndecided);
  els.surnameFlipButton.addEventListener("click", () => toggleSurnameOrder());
  els.surnameRestoreButton.addEventListener("click", restoreTwoPartSurname);
  els.focusFlipButton.addEventListener("click", () => toggleSurnameOrder());
  els.characterName.addEventListener("click", openFullNameEditor);
  els.repairSurnameButton.addEventListener("click", openFullNameEditor);
  els.copyTraitsButton.addEventListener("click", () => copyText(exactTraitsText(state.selected), `Copied all exact traits for #${state.selected.id}.`));
  els.copyPacketButton.addEventListener("click", () => copyText(reviewPacketText(state.selected), `Copied review packet for #${state.selected.id}.`));
  els.copyImageButton.addEventListener("click", () => copyCharacterImage().catch(error => showToast(error.message, "error")));
  els.chatgptShareButton.addEventListener("click", openChatGptHandoff);
  els.chatgptHandoffClose.addEventListener("click", () => els.chatgptHandoffDialog.close());
  els.chatgptChatUrl.addEventListener("input", () => {
    localStorage.setItem(CHATGPT_HANDOFF_KEY, els.chatgptChatUrl.value.trim());
    updateSavedChatControls();
  });
  els.chatgptNativeShare.addEventListener("click", shareCharacterToChatGpt);
  els.chatgptOpenSavedChat.addEventListener("click", copyPacketAndOpenSavedChat);
  els.chatgptCopyPacket.addEventListener("click", async () => {
    try {
      const result = startClipboardTextWrite(activeChatGptHandoffPacket());
      if (!await result.completion) throw new Error("Clipboard blocked");
      setChatGptHandoffStatus("Copied the complete ChatGPT review packet.", "success");
    } catch (_) {
      setChatGptHandoffStatus("This browser blocked clipboard access.", "error");
    }
  });
  els.chatgptCopyPortrait.addEventListener("click", () => copyCharacterImage()
    .then(() => setChatGptHandoffStatus("Copied the portrait as PNG.", "success"))
    .catch(error => setChatGptHandoffStatus(error.message, "error")));
  els.askAiButton.addEventListener("click", openNamingAssistant);
  els.fullNameEditClose.addEventListener("click", () => els.fullNameEditDialog.close());
  els.fullNameEditCancel.addEventListener("click", () => els.fullNameEditDialog.close());
  els.fullNamePasteInput.addEventListener("input", beginPastedFullNameDetection);
  els.fullNameDetectButton.addEventListener("click", () => requestSurnameDetection());
  els.fullNameEditFirstInput.addEventListener("input", () => {
    const first = normalizeManualFirstName(els.fullNameEditFirstInput.value);
    if (first && els.fullNameEditSurnameInput.value) {
      els.fullNamePasteInput.value = `${first} ${els.fullNameEditSurnameInput.value}`;
    }
    updateFullNameEditPreview();
  });
  els.fullNameEditSurnameInput.addEventListener("input", () => {
    const first = normalizeManualFirstName(els.fullNameEditFirstInput.value);
    if (first) els.fullNamePasteInput.value = `${first} ${els.fullNameEditSurnameInput.value.trim()}`;
    beginPastedFullNameDetection();
  });
  [els.fullNameEditComponent1, els.fullNameEditComponent2].forEach(input => input.addEventListener("input", syncSurnameFromComponents));
  [els.fullNameEditSource1, els.fullNameEditSource2].forEach(select => select.addEventListener("change", updateFullNameEditPreview));
  els.fullNameEditFlip.addEventListener("click", () => {
    els.fullNameEditForm.dataset.order = els.fullNameEditForm.dataset.order === "21" ? "12" : "21";
    syncSurnameFromComponents();
  });
  els.fullNameEditForm.addEventListener("submit", saveFullNameEdit);
  els.namingAssistantClose.addEventListener("click", () => els.namingAssistantDialog.close());
  els.nameBankButton.addEventListener("click", openNameBanks);
  els.nameBankClose.addEventListener("click", () => els.nameBankDialog.close());
  els.assistantFeedback.querySelectorAll("[data-ai-feedback]").forEach(button => button.addEventListener("click", () => requestNamingWorkshop(button.dataset.aiFeedback)));
  els.nameBankForm.addEventListener("submit", async event => {
    event.preventDefault();
    const [file] = els.nameBankFile.files;
    if (!file) return;
    try {
      const response = await fetch("/api/name-banks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clothing: els.nameBankClothing.value, gender: els.nameBankGender.value, version: els.nameBankVersion.value, filename: file.name, raw_markdown: await file.text(), active: true }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Upload failed.");
      showToast(`Saved ${payload.entries.length} parsed names from ${payload.filename}.`, "success");
      els.nameBankFile.value = "";
      await loadNameBanks();
    } catch (error) { showToast(error.message, "error"); }
  });
  els.surnameOptions1.addEventListener("click", () => openSuggestions("surname_part_1"));
  els.surnameOptions2.addEventListener("click", () => openSuggestions("surname_part_2"));
  els.focusExportButton.addEventListener("click", exportReviews);
  els.focusImportButton.addEventListener("click", () => els.importFile.click());
  els.mobileExportButton.addEventListener("click", exportReviews);
  els.mobileImportButton.addEventListener("click", () => els.importFile.click());
  els.focusPortrait.addEventListener("pointerdown", event => {
    state.focusSwipeStart = event.clientX;
  });
  els.focusPortrait.addEventListener("pointerup", event => {
    if (state.focusSwipeStart === null) return;
    const delta = event.clientX - state.focusSwipeStart;
    state.focusSwipeStart = null;
    if (Math.abs(delta) < 55) return;
    moveSelection(delta < 0 ? 1 : -1);
  });
  els.focusPortrait.addEventListener("pointercancel", () => {
    state.focusSwipeStart = null;
  });
  els.focusPortrait.addEventListener("dragstart", event => event.preventDefault());
  els.loginForm.addEventListener("submit", loginToCloud);
  els.importButton.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    const [file] = els.importFile.files;
    if (!file) return;
    try {
      await importReviews(file);
    } catch (error) {
      showToast(`Import failed: ${error.message}`, "error");
    } finally {
      els.importFile.value = "";
    }
  });
  els.portrait.addEventListener("error", () => {
    els.portraitError.hidden = false;
  });
  document.querySelectorAll("[data-part][data-decision]").forEach(button => {
    button.addEventListener("click", () => {
      setPartDecision(button.dataset.part, button.dataset.decision);
    });
  });
  els.reviewNote.addEventListener("input", () => {
    const record = ensureRecord(state.selected.id);
    record.note = els.reviewNote.value;
    record.note_updated_at = nowIso();
    record.updated_at = record.note_updated_at;
    pruneRecord(state.selected.id);
    saveCuration();
    updateProgress();
    renderRoster();
  });
  els.reviewerName.addEventListener("input", () => {
    state.curation.reviewer = els.reviewerName.value.trim();
    saveCuration();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && els.app.classList.contains("mobile-roster-open")) {
      setMobileRoster(false);
      els.mobileFiltersButton.focus();
      return;
    }
    if (event.target.matches("input, textarea, select")) return;
    if (event.key === "/") {
      event.preventDefault();
      els.search.focus();
    }
    if (event.key === "ArrowLeft") moveSelection(-1);
    if (event.key === "ArrowRight") moveSelection(1);
    if (event.key.toLowerCase() === "n") nextUndecided();
    if (event.key.toLowerCase() === "a" && event.shiftKey) approveRemaining();
  });
  window.addEventListener("hashchange", () => {
    const requestedId = location.hash.slice(1);
    if (requestedId && requestedId !== state.selected?.id) selectById(requestedId);
  });
  window.addEventListener("online", () => {
    if (state.cloudAuthenticated) {
      pushCloudState();
      pullCloudState({ quiet: true });
    }
  });
  window.addEventListener("pagehide", flushCloudState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushCloudState();
      stopVoiceListening(false);
    } else if (state.voice.handsFree) {
      acquireVoiceWakeLock();
      startVoiceListening();
    }
  });
}

async function init() {
  document.querySelectorAll("[id]").forEach(element => {
    els[element.id] = element;
  });
  try {
    const response = await fetch("/review_data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.filtered = state.data.characters;
    await loadPackagedProgress();
    migrateLegacyReviews();

    const audit = state.data.audit;
    const clothingCounts = state.data.characters.reduce((counts, character) => {
      if (character.clothing) {
        counts[character.clothing] = (counts[character.clothing] || 0) + 1;
      }
      return counts;
    }, {});
    els.clothingFilter.innerHTML = `<option value="">Every clothing trait</option>` +
      Object.entries(clothingCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([trait, count]) =>
          `<option value="${escapeHtml(trait)}">${escapeHtml(trait)} (${count})</option>`
        ).join("");
    els.nameBankClothing.innerHTML = Object.keys(clothingCounts).sort().map(trait => `<option value="${escapeHtml(trait)}">${escapeHtml(trait)}</option>`).join("");
    const traitTypes = [...new Set(
      state.data.characters.flatMap(character =>
        character.traits.map(trait => trait.type)
      )
    )].filter(type => type && type !== "Clothing").sort();
    els.traitTypeFilter.innerHTML =
      `<option value="">Choose trait category</option>` +
      traitTypes.map(type =>
        `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`
      ).join("");
    els.collectionStats.innerHTML = `
      <span><b>${audit.named.toLocaleString()}</b> named</span>
      <span><b>${audit.distinct_first_names.toLocaleString()}</b> unique firsts</span>
      <span><b>${audit.duplicate_full_names}</b> duplicates</span>
      <span><b>${audit.hand_authored_names_required}</b> specials need names</span>`;
    els.reviewerName.value = state.curation.reviewer || "";

    initVoiceControl();
    bindEvents();
    setViewMode(state.viewMode);
    const requestedId = location.hash.slice(1);
    selectById(requestedId || "1");
    updateProgress();
    renderRoster();
    $("boot").hidden = true;
    $("app").hidden = false;
    window.__nameStudioSurnameRepairTest = () => ({
      ...state.surnameRepairSummary,
      selected: state.selected ? state.surnameRepairIndex[String(state.selected.id)] || null : null
    });
    await checkCloudSession();
    if (state.cloudAuthenticated) {
      els.reviewerName.value = state.curation.reviewer || "";
      renderCharacter();
      updateProgress();
      applyFilters();
    }
    window.__nameStudioVoiceTest = {
      parse: parseVoiceIntent,
      execute: executeVoiceCommand,
      read: readCurrentCharacter,
      state: () => ({
        supported: state.voice.supported,
        listening: state.voice.listening,
        handsFree: state.voice.handsFree,
        pending: state.voice.pending?.label || null
      })
    };
  } catch (error) {
    $("boot").textContent =
      `Could not load review data: ${error.message}. Start the app with the included launcher.`;
  }
}

init();
