// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {Record<string, boolean>} */
  const opts = { regex: false, matchCase: false, wholeWord: false };

  const el = {
    connection: /** @type {HTMLSelectElement} */ (document.getElementById("connection")),
    mount: /** @type {HTMLSelectElement} */ (document.getElementById("mount")),
    startPath: /** @type {HTMLInputElement} */ (document.getElementById("startPath")),
    query: /** @type {HTMLInputElement} */ (document.getElementById("query")),
    replacement: /** @type {HTMLInputElement} */ (document.getElementById("replacement")),
    searchKeys: /** @type {HTMLInputElement} */ (document.getElementById("searchKeys")),
    searchValues: /** @type {HTMLInputElement} */ (document.getElementById("searchValues")),
    searchBtn: /** @type {HTMLButtonElement} */ (document.getElementById("searchBtn")),
    cancelBtn: /** @type {HTMLButtonElement} */ (document.getElementById("cancelBtn")),
    previewBtn: /** @type {HTMLButtonElement} */ (document.getElementById("previewBtn")),
    replaceBtn: /** @type {HTMLButtonElement} */ (document.getElementById("replaceBtn")),
    status: /** @type {HTMLDivElement} */ (document.getElementById("status")),
    results: /** @type {HTMLDivElement} */ (document.getElementById("results")),
  };

  /** @type {Map<string, {secretPath: string, matches: any[]}>} */
  const resultsMap = new Map();

  function currentOptions() {
    return {
      regex: opts.regex,
      matchCase: opts.matchCase,
      wholeWord: opts.wholeWord,
      searchKeys: el.searchKeys.checked,
      searchValues: el.searchValues.checked,
    };
  }

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.classList.toggle("error", Boolean(isError));
  }

  // --- option toggle buttons ---
  document.querySelectorAll(".options button[data-opt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-opt");
      if (!key) return;
      opts[key] = !opts[key];
      btn.classList.toggle("active", opts[key]);
    });
  });

  el.searchBtn.addEventListener("click", doSearch);
  el.cancelBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  el.previewBtn.addEventListener("click", () =>
    vscode.postMessage({
      type: "preview",
      query: el.query.value,
      replacement: el.replacement.value,
      options: currentOptions(),
    })
  );
  el.replaceBtn.addEventListener("click", doReplace);
  el.query.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  el.connection.addEventListener("change", () =>
    vscode.postMessage({ type: "selectConnection", id: el.connection.value })
  );

  function doSearch() {
    resultsMap.clear();
    el.results.innerHTML = "";
    vscode.postMessage({
      type: "search",
      request: {
        query: el.query.value,
        replacement: el.replacement.value,
        options: currentOptions(),
        connectionId: el.connection.value,
        mount: el.mount.value,
        startPath: el.startPath.value,
      },
    });
  }

  function doReplace() {
    const includedPaths = Array.from(resultsMap.keys());
    if (includedPaths.length === 0) {
      setStatus("Run a search first.", true);
      return;
    }
    vscode.postMessage({
      type: "replace",
      query: el.query.value,
      replacement: el.replacement.value,
      options: currentOptions(),
      mount: el.mount.value,
      includedPaths,
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /** Highlight ranges [start,end) inside text. */
  function highlight(text, ranges) {
    if (!ranges || ranges.length === 0) return escapeHtml(text);
    let out = "";
    let last = 0;
    for (const [start, end] of ranges) {
      out += escapeHtml(text.slice(last, start));
      out += "<mark>" + escapeHtml(text.slice(start, end)) + "</mark>";
      last = end;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  function renderResult(result) {
    resultsMap.set(result.secretPath, result);
    const group = document.createElement("div");
    group.className = "secret-group";

    const header = document.createElement("div");
    header.className = "secret-header";
    header.innerHTML =
      '<span class="path">' + escapeHtml(result.secretPath) + "</span>" +
      '<span class="count">' + result.matches.length + "</span>";
    group.appendChild(header);

    const body = document.createElement("div");
    for (const m of result.matches) {
      const line = document.createElement("div");
      line.className = "match-line";
      line.innerHTML =
        '<span class="badge">' + m.location + '</span>' +
        '<span class="key">' + escapeHtml(m.key) + ":</span> " +
        "<span>" + highlight(m.original, m.ranges) + "</span>";
      line.addEventListener("click", () =>
        vscode.postMessage({ type: "openSecret", mount: el.mount.value, secretPath: result.secretPath })
      );
      body.appendChild(line);
    }
    group.appendChild(body);

    header.addEventListener("click", () => body.classList.toggle("hidden"));
    el.results.appendChild(group);
  }

  function renderPreviews(previews) {
    const existing = document.getElementById("previewBox");
    if (existing) existing.remove();
    const box = document.createElement("div");
    box.id = "previewBox";
    box.className = "preview";
    if (previews.length === 0) {
      box.innerHTML = "<h3>No replacements would change anything.</h3>";
    } else {
      let html = "<h3>" + previews.length + " replacement(s) preview</h3>";
      for (const p of previews.slice(0, 200)) {
        html +=
          '<div class="preview-item">' +
          '<div class="path">' + escapeHtml(p.secretPath) + " › " + escapeHtml(p.key) + " (" + p.location + ")</div>" +
          '<div class="diff-old">- ' + escapeHtml(p.before) + "</div>" +
          '<div class="diff-new">+ ' + escapeHtml(p.after) + "</div>" +
          "</div>";
      }
      if (previews.length > 200) {
        html += "<div class='path'>…and " + (previews.length - 200) + " more</div>";
      }
      box.innerHTML = html;
    }
    el.results.prepend(box);
  }

  function fillSelect(select, items, selectedValue) {
    select.innerHTML = "";
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.value;
      opt.textContent = item.label;
      if (item.value === selectedValue) opt.selected = true;
      select.appendChild(opt);
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "connections": {
        const items = msg.connections.map((c) => ({ value: c.id, label: c.name }));
        const preferred = (msg.connections.find((c) => c.name === msg.defaultConnection) || msg.connections[0]);
        fillSelect(el.connection, items, preferred ? preferred.id : undefined);
        if (preferred) vscode.postMessage({ type: "selectConnection", id: preferred.id });
        break;
      }
      case "mounts": {
        if (el.connection.value !== msg.connectionId) break;
        const items = msg.mounts.map((m) => ({ value: m, label: m }));
        fillSelect(el.mount, items, msg.defaultMount || (msg.mounts[0] || ""));
        break;
      }
      case "prime": {
        if (msg.connectionId) el.connection.value = msg.connectionId;
        if (msg.startPath) el.startPath.value = msg.startPath;
        if (msg.mount) {
          // mount options may arrive later; set once available
          setTimeout(() => { if (msg.mount) el.mount.value = msg.mount; }, 100);
        }
        el.query.focus();
        break;
      }
      case "searchStarted":
        setStatus("Searching…");
        el.searchBtn.hidden = true;
        el.cancelBtn.hidden = false;
        break;
      case "result":
        renderResult(msg.result);
        break;
      case "progress":
        setStatus(
          "Discovered " + msg.progress.discovered + ", scanned " + msg.progress.scanned + ", matched " + msg.progress.matched
        );
        break;
      case "searchDone":
        el.searchBtn.hidden = false;
        el.cancelBtn.hidden = true;
        setStatus((msg.cancelled ? "Cancelled — " : "") + msg.count + " secret(s) matched.");
        break;
      case "previews":
        renderPreviews(msg.previews);
        break;
      case "replaceDone":
        setStatus(
          "Replaced " + msg.report.succeeded + ", skipped " + msg.report.skipped + ", failed " + msg.report.failed + "."
        );
        break;
      case "error":
        setStatus(msg.message, true);
        el.searchBtn.hidden = false;
        el.cancelBtn.hidden = true;
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
