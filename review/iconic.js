(() => {
  const iconic = {
    payload: null,
    selectedTrait: "Aware frog",
    editing: null,
  };

  const el = (id) => document.getElementById(id);
  const escape = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);

  function activeGender(row) {
    if (!row) return "Female";
    return row.Male.characters >= row.Female.characters ? "Male" : "Female";
  }

  function selectedCoverage() {
    return iconic.payload?.coverage.find((row) => row.clothing === iconic.selectedTrait) || null;
  }

  function notice(message, tone = "") {
    el("iconicNotice").textContent = message || "";
    el("iconicNotice").dataset.tone = tone;
  }

  async function request(method = "GET", body = null) {
    const response = await fetch("/api/iconic-bank", {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : null,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function renderCoverage() {
    const query = el("iconicTraitSearch").value.trim().toLowerCase();
    const rows = iconic.payload.coverage.filter((row) =>
      !query || row.clothing.toLowerCase().includes(query)
    );
    el("iconicCoverageList").innerHTML = rows.map((row) => {
      const completion = row.target_total
        ? Math.min(100, Math.round(row.capacity_approved_total / row.target_total * 100))
        : 100;
      return `<button class="iconic-coverage-card ${row.clothing === iconic.selectedTrait ? "active" : ""}"
        data-iconic-trait="${escape(row.clothing)}" style="--coverage:${completion}%">
        <strong>${escape(row.clothing)}</strong><b>${row.needed_total}</b>
        <small>${row.characters} characters · ${row.capacity_approved_total}/${row.target_total} active capacity</small>
        <i aria-label="${completion}% capacity"></i>
      </button>`;
    }).join("");
  }

  function renderLedger(row) {
    el("iconicGenderLedger").innerHTML = ["Male", "Female"].map((gender) => {
      const info = row[gender];
      return `<article class="iconic-gender-card">
        <b>${gender}</b>
        <div><span>Characters</span><strong>${info.characters}</strong></div>
        <div><span>Approved / target</span><strong>${info.approved} / ${info.target}</strong></div>
        <div><span>Still needed</span><strong>${info.needed}</strong></div>
      </article>`;
    }).join("");
  }

  function visibleCandidates(row) {
    const genderFilter = el("iconicGenderFilter").value;
    const gender = genderFilter === "active" ? activeGender(row) : genderFilter;
    const status = el("iconicStatusFilter").value;
    const category = el("iconicCategoryFilter").value;
    const candidates = iconic.payload.candidates.filter((candidate) =>
      candidate.clothing === row.clothing &&
      (gender === "all" || candidate.gender === gender) &&
      (status === "all" || candidate.status === status) &&
      (category === "all" || candidate.category === category)
    );
    const sort = el("iconicSort").value;
    return candidates.sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name);
      if (sort === "newest") return String(right.updated_at).localeCompare(String(left.updated_at));
      return Number(right.confidence || 0) - Number(left.confidence || 0) || left.name.localeCompare(right.name);
    });
  }

  function conflictMarkup(candidate) {
    const labels = [];
    if (candidate.conflicts?.assigned) labels.push("Already assigned");
    if (candidate.conflicts?.normal_bank) labels.push("Also in normal bank");
    if (candidate.conflicts?.duplicate_in_pool) labels.push("Duplicate in pool");
    return labels.length
      ? `<div class="iconic-conflicts">${labels.map((label) => `<span>${label}</span>`).join("")}</div>`
      : "";
  }

  function renderCandidates(row) {
    const candidates = visibleCandidates(row);
    el("iconicCandidateGrid").innerHTML = candidates.length
      ? candidates.map((candidate) => `<article class="iconic-candidate-card" data-status="${candidate.status}">
          <div class="iconic-candidate-head">
            <div><h4>${escape(candidate.name)}</h4><div class="iconic-candidate-meta">${escape(candidate.gender)} · ${escape(candidate.category)} · ${escape(candidate.status)}</div></div>
            <span class="iconic-confidence" title="Relevance confidence">${Number(candidate.confidence || 0)}</span>
          </div>
          <p>${escape(candidate.reason)}</p>
          <div>
            <a href="${escape(candidate.source_url)}" target="_blank" rel="noopener noreferrer">${escape(candidate.reference)}</a>
            ${conflictMarkup(candidate)}
          </div>
          <div class="iconic-card-actions">
            <button data-iconic-status="${candidate.id}" data-status-action="approved">Approve</button>
            <button data-iconic-status="${candidate.id}" data-status-action="rejected">Reject</button>
            <button data-iconic-edit="${candidate.id}">Edit</button>
          </div>
        </article>`).join("")
      : `<div class="suggestion-empty">No candidates match these filters. Research this trait or add a directly connected name.</div>`;
  }

  function renderWorkbench() {
    const row = selectedCoverage();
    if (!row) return;
    const gender = activeGender(row);
    const active = row[gender];
    el("iconicTraitTitle").textContent = row.clothing;
    el("iconicTraitSummary").textContent =
      `${row.characters} collection characters · active ${gender} route · ` +
      `${active.approved}/${active.target} active capacity approved; ${row.approved_total} approved across both stored gender pools. ` +
      `The normal and Japanese banks remain separate.`;
    el("iconicCapacityStamp").querySelector("strong").textContent = row.needed_total;
    renderLedger(row);
    renderCandidates(row);
  }

  function render() {
    renderCoverage();
    renderWorkbench();
  }

  async function loadBank({ preserveNotice = false } = {}) {
    if (!preserveNotice) notice("Loading the persistent Iconic / Fun bank…");
    iconic.payload = await request();
    el("iconicCategoryFilter").innerHTML =
      `<option value="all">Every category</option>` +
      iconic.payload.categories.map((category) => `<option value="${escape(category)}">${escape(category)}</option>`).join("");
    el("iconicEditCategory").innerHTML = iconic.payload.categories
      .map((category) => `<option value="${escape(category)}">${escape(category)}</option>`).join("");
    el("iconicEditClothing").innerHTML = iconic.payload.coverage
      .map((row) => `<option value="${escape(row.clothing)}">${escape(row.clothing)}</option>`).join("");
    if (!iconic.payload.coverage.some((row) => row.clothing === iconic.selectedTrait)) {
      iconic.selectedTrait = iconic.payload.coverage[0]?.clothing || "";
    }
    render();
    if (!preserveNotice) notice("");
  }

  function openEditor(candidate = null) {
    const row = selectedCoverage();
    iconic.editing = candidate;
    el("iconicEditTitle").textContent = candidate ? `Edit ${candidate.name}` : "Add candidate";
    el("iconicEditId").value = candidate?.id || "";
    el("iconicEditName").value = candidate?.name || "";
    el("iconicEditClothing").value = candidate?.clothing || row.clothing;
    el("iconicEditGender").value = candidate?.gender || activeGender(row);
    el("iconicEditCategory").value = candidate?.category || "Iconic Character";
    el("iconicEditReference").value = candidate?.reference || "";
    el("iconicEditSourceUrl").value = candidate?.source_url || "";
    el("iconicEditReason").value = candidate?.reason || "";
    el("iconicEditConfidence").value = Number(candidate?.confidence || 85);
    el("iconicEditStatus").value = candidate?.status || "proposed";
    el("iconicEditDelete").hidden = !candidate;
    el("iconicEditDialog").showModal();
  }

  function formCandidate() {
    return {
      id: el("iconicEditId").value || undefined,
      name: el("iconicEditName").value,
      clothing: el("iconicEditClothing").value,
      gender: el("iconicEditGender").value,
      category: el("iconicEditCategory").value,
      reference: el("iconicEditReference").value,
      source_url: el("iconicEditSourceUrl").value,
      reason: el("iconicEditReason").value,
      confidence: Number(el("iconicEditConfidence").value),
      status: el("iconicEditStatus").value,
      source_kind: iconic.editing?.source_kind || "manual",
    };
  }

  async function saveCandidate(candidate) {
    await request("PUT", { base_revision: iconic.payload.revision, candidate });
    await loadBank({ preserveNotice: true });
  }

  async function updateStatus(id, status) {
    const candidate = iconic.payload.candidates.find((item) => item.id === id);
    if (!candidate) return;
    notice(`${status === "approved" ? "Approving" : "Rejecting"} ${candidate.name}…`);
    await saveCandidate({ ...candidate, status });
    notice(`${candidate.name} marked ${status}. The permanent bank is synced.`);
  }

  async function research() {
    const row = selectedCoverage();
    let gender = el("iconicGenderFilter").value;
    if (gender === "active" || gender === "all") gender = activeGender(row);
    el("iconicDiscoverButton").disabled = true;
    notice(`Researching ${gender} ${row.clothing} references through Wikimedia…`);
    try {
      const result = await request("POST", {
        action: "discover",
        base_revision: iconic.payload.revision,
        clothing: row.clothing,
        gender,
      });
      await loadBank({ preserveNotice: true });
      notice(`Research complete: ${result.found} evidence-qualified results, ${result.added} new proposals saved. Review before approving.`);
    } finally {
      el("iconicDiscoverButton").disabled = false;
    }
  }

  function exportCsv() {
    const headers = ["Name", "Clothing", "Gender", "Category", "Reference", "Source URL", "Reason", "Confidence", "Status", "Assigned conflict", "Normal-bank overlap", "Updated at", "Updated by"];
    const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = [headers.map(quote).join(",")];
    for (const candidate of iconic.payload.candidates) {
      lines.push([
        candidate.name, candidate.clothing, candidate.gender, candidate.category,
        candidate.reference, candidate.source_url, candidate.reason, candidate.confidence,
        candidate.status, candidate.conflicts?.assigned, candidate.conflicts?.normal_bank,
        candidate.updated_at, candidate.updated_by,
      ].map(quote).join(","));
    }
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `iconic_fun_name_bank_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  el("iconicBankButton").addEventListener("click", async () => {
    el("iconicBankDialog").showModal();
    try {
      await loadBank();
    } catch (error) {
      notice(`Could not load the Iconic bank: ${error.message}`, "error");
    }
  });
  el("iconicBankClose").addEventListener("click", () => el("iconicBankDialog").close());
  el("iconicEditClose").addEventListener("click", () => el("iconicEditDialog").close());
  el("iconicTraitSearch").addEventListener("input", renderCoverage);
  el("iconicCoverageList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-iconic-trait]");
    if (!button) return;
    iconic.selectedTrait = button.dataset.iconicTrait;
    el("iconicGenderFilter").value = "active";
    render();
  });
  ["iconicGenderFilter", "iconicStatusFilter", "iconicCategoryFilter", "iconicSort"]
    .forEach((id) => el(id).addEventListener("change", renderWorkbench));
  el("iconicCandidateGrid").addEventListener("click", async (event) => {
    const statusButton = event.target.closest("[data-iconic-status]");
    const editButton = event.target.closest("[data-iconic-edit]");
    try {
      if (statusButton) await updateStatus(statusButton.dataset.iconicStatus, statusButton.dataset.statusAction);
      if (editButton) {
        const candidate = iconic.payload.candidates.find((item) => item.id === editButton.dataset.iconicEdit);
        if (candidate) openEditor(candidate);
      }
    } catch (error) {
      notice(error.message, "error");
    }
  });
  el("iconicAddButton").addEventListener("click", () => openEditor());
  el("iconicDiscoverButton").addEventListener("click", () => research().catch((error) => notice(error.message, "error")));
  el("iconicExportButton").addEventListener("click", exportCsv);
  el("iconicEditForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const candidate = formCandidate();
      await saveCandidate(candidate);
      el("iconicEditDialog").close();
      notice(`${candidate.name} saved to the persistent bank.`);
    } catch (error) {
      notice(error.message, "error");
    }
  });
  el("iconicEditDelete").addEventListener("click", async () => {
    const id = el("iconicEditId").value;
    if (!id || !window.confirm("Delete this Iconic / Fun candidate record?")) return;
    try {
      await request("DELETE", { base_revision: iconic.payload.revision, id });
      await loadBank({ preserveNotice: true });
      el("iconicEditDialog").close();
      notice("Candidate deleted. Existing character names were not changed.");
    } catch (error) {
      notice(error.message, "error");
    }
  });
})();
