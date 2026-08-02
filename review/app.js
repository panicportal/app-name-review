const STORAGE_KEY = "panic-name-curation-v2-v11";
const LEGACY_STORAGE_KEY = "panic-name-reviews-v1";
const VIEW_MODE_KEY = "panic-name-review-view-mode";
const CLOUD_SYNC_MARKER_KEY = "panic-name-cloud-sync-v12-aug02";
const PRE_CLOUD_BACKUP_KEY = "panic-name-pre-cloud-backup-v12-aug02";
const SCHEMA_VERSION = "panic-name-curation/v2";
const PACKAGED_PROGRESS_URL = "/cloud_seed_curation.json";
const PART_KEYS = ["first", "surname_part_1", "surname_part_2"];
const CLOUD_POLL_MS = 12000;
const SURNAME_FORMAT_VERSION = 2;

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
  suggestionSource: null,
  suggestionSort: "balanced",
  suggestionPayload: null,
  suggestionPreviewOrder: "12",
  suggestionJoinStyle: "lower_second",
  suggestionRequestVersion: 0,
  focusSwipeStart: null
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
          ? (incoming.surname_join_style === "lower_second" ? "lower_second" : "camel")
          : (current.surname_join_style === "lower_second" ? "lower_second" : "camel"),
      surname_join_style_updated_at:
        timestamp(incoming.surname_join_style_updated_at) >= timestamp(current.surname_join_style_updated_at)
          ? (incoming.surname_join_style_updated_at || null)
          : (current.surname_join_style_updated_at || null),
      surname_format_version:
        timestamp(incoming.surname_join_style_updated_at) >= timestamp(current.surname_join_style_updated_at)
          ? Number(incoming.surname_format_version || 0)
          : Number(current.surname_format_version || 0),
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
  const hasSecondPart = Boolean(detail.source_2 || character.surname_source_2);
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
      short: hasSecondPart ? "S1" : "S",
      label: hasSecondPart ? "Surname part 1" : "Surname",
      value: detail.component_1 || character.surname_component_1 || character.surname || "",
      source: detail.source_1 || character.surname_source_1 || character.surname_source || "",
      usage_count: Number(detail.component_1_count || 0),
      available: Boolean(character.surname)
    },
    {
      key: "surname_part_2",
      short: "S2",
      label: "Surname part 2",
      value: detail.component_2 || character.surname_component_2 || "",
      source: detail.source_2 || character.surname_source_2 || "",
      usage_count: Number(detail.component_2_count || 0),
      available: Boolean(character.surname && hasSecondPart)
    }
  ];
}

function effectivePartValue(character, key) {
  const part = partDefinitions(character).find(item => item.key === key);
  const review = partReview(character.id, key);
  if (review.disabled) return "";
  return review.replacement_value || part?.value || "";
}

function effectivePartSource(character, key) {
  const definition = partDefinitions(character).find(item => item.key === key);
  return partReview(character.id, key).replacement_trait_source ||
    partReview(character.id, key).replacement_source ||
    definition?.source ||
    "";
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
    const characterMix = `${character.first_name_language}+${character.surname_language}`;
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
      (!firstLanguage || character.first_name_language === firstLanguage) &&
      (!surnameLanguage || character.surname_language === surnameLanguage) &&
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
    `${character.first_name_language} first · ${character.surname_language} surname · ${status.decided}/${status.total} parts decided`;
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
  els.tokenId.textContent = `Surv!vor #${c.id}`;
  els.languageMix.textContent = `${c.first_name_language} first / ${c.surname_language} surname`;
  els.portrait.src = `/pfps_webp/${c.id}.webp`;
  els.portrait.alt = `Pixel portrait of ${c.display_name}, survivor ${c.id}`;
  els.portraitError.hidden = true;
  els.clothingEyebrow.textContent = c.clothing || "Official one-of-one";
  const previewName = effectiveDisplayName(c);
  els.characterName.textContent = previewName;
  els.characterName.title = previewName !== c.display_name
    ? `Original: ${c.display_name}` : "";
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
    c.first_name_provenance === "sensitivity_review_replacement" ? "Sensitivity-reviewed theme" :
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
  els.surnameLanguage.textContent = languageLabel(c.surname_language);
  els.firstRationale.textContent = c.first_rationale;
  els.surnameRationale.textContent = liveSurnameRationale(c);
  els.firstTheme.textContent = c.clothing || "Hand-authored special";
  els.firstGenderRoute.textContent = c.gender_from_body || "Special";
  els.firstEvidence.textContent =
    c.first_name_provenance === "sensitivity_review_replacement" ? "Collection-wide language and context safety review" :
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
  els.firstSource.textContent = [c.first_name_source, c.first_name_source_detail]
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
  const hasSecondSurnamePart = Boolean(detail.source_2);
  els.surnameFusionOperator.hidden = !hasSecondSurnamePart;
  els.surnameFusionPart2.hidden = !hasSecondSurnamePart;
  els.surnameRecipe.classList.toggle("single-surname", !hasSecondSurnamePart);
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
      importedRecord.surname_join_style_updated_at &&
      timestamp(importedRecord.surname_join_style_updated_at) >=
        timestamp(local.surname_join_style_updated_at)
    ) {
      local.surname_join_style =
        importedRecord.surname_join_style === "lower_second" ? "lower_second" : "camel";
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
  return part === "first"
    ? (character.first_name_language || "western")
    : (character.surname_language || "western");
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

async function openSuggestions(part, language = null, source = null) {
  const requestVersion = ++state.suggestionRequestVersion;
  state.suggestionPart = part;
  state.suggestionLanguage = language || suggestionLanguageFor(state.selected, part);
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
  els.suggestionPolicy.textContent =
    state.suggestionLanguage === "japanese"
      ? "Japanese mode is closed-bank only: every option must be an exact entry from the artist CSV. Gender routing comes only from Body."
      : part === "first"
        ? "Western first names come only from the curated clothing-theme bank and must be unused across the full collection."
        : "Surname options come from the exact source trait’s reviewed fragment bank, ranked for low repetition.";
  els.suggestionList.innerHTML = `<div class="suggestion-loading">Checking fit, uniqueness, and current team proposals…</div>`;
  els.suggestionFullPreview.hidden = true;
  els.suggestionTraitSourceWrap.hidden = !(
    part.startsWith("surname_") ||
    (part === "first" && state.suggestionLanguage === "japanese")
  );
  els.suggestionTraitSource.disabled = true;
  els.suggestionTraitSourceApply.disabled = true;
  renderManualSurnameEditor();
  if (!els.suggestionDialog.open) els.suggestionDialog.showModal();
  try {
    const params = new URLSearchParams({
      id: state.selected.id,
      part,
      language: state.suggestionLanguage,
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
    renderSuggestionTraitSources();
    renderSuggestionCurrentPreview();
    renderManualSurnameEditor();
    renderSuggestionOptions();
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
    replacement_rationale:
      `${candidate.fit} ${candidate.uniqueness}. ` +
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
    scheduleCloudSave();
    clearInterval(state.cloudPollTimer);
    state.cloudPollTimer = setInterval(syncCloudTick, CLOUD_POLL_MS);
  } catch (error) {
    els.loginError.textContent = error.message;
  }
}

function bindEvents() {
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
  els.suggestionClose.addEventListener("click", () => els.suggestionDialog.close());
  els.suggestionLanguage.querySelectorAll("[data-language]").forEach(button => {
    button.addEventListener("click", () => {
      openSuggestions(state.suggestionPart, button.dataset.language, state.suggestionSource);
    });
  });
  els.suggestionTraitSourceApply.addEventListener("click", () => {
    const selectedSource = els.suggestionTraitSource.value;
    if (!selectedSource) return;
    state.suggestionSource = selectedSource;
    openSuggestions(
      state.suggestionPart,
      state.suggestionLanguage,
      selectedSource
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
  els.mobilePrevious.addEventListener("click", () => moveSelection(-1));
  els.mobileApprove.addEventListener("click", approveRemaining);
  els.mobileNext.addEventListener("click", () => moveSelection(1));
  els.focusPreviousButton.addEventListener("click", () => moveSelection(-1));
  els.focusNextButton.addEventListener("click", () => moveSelection(1));
  els.focusApproveNextButton.addEventListener("click", approveRemainingAndNext);
  els.focusNextUndecidedButton.addEventListener("click", nextUndecided);
  els.surnameFlipButton.addEventListener("click", () => toggleSurnameOrder());
  els.focusFlipButton.addEventListener("click", () => toggleSurnameOrder());
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
    if (document.visibilityState === "hidden") flushCloudState();
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

    bindEvents();
    setViewMode(state.viewMode);
    const requestedId = location.hash.slice(1);
    selectById(requestedId || "1");
    updateProgress();
    renderRoster();
    $("boot").hidden = true;
    $("app").hidden = false;
    await checkCloudSession();
    if (state.cloudAuthenticated) {
      els.reviewerName.value = state.curation.reviewer || "";
      renderCharacter();
      updateProgress();
      applyFilters();
    }
  } catch (error) {
    $("boot").textContent =
      `Could not load review data: ${error.message}. Start the app with the included launcher.`;
  }
}

init();
