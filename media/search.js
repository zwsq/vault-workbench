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
    replaceBtn: /** @type {HTMLButtonElement} */ (document.getElementById("replaceBtn")),
    status: /** @type {HTMLDivElement} */ (document.getElementById("status")),
    results: /** @type {HTMLDivElement} */ (document.getElementById("results")),
  };

  /** @type {Map<string, {result: any, groupEl: HTMLElement, checkbox: HTMLInputElement}>} */
  const groups = new Map();

  // The query/options that produced the current results (used for replace preview).
  let lastQuery = "";
  let lastOptions = currentOptions();

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
  el.replaceBtn.addEventListener("click", doReplace);
  // Ctrl/Cmd+Enter searches; plain Enter inserts a newline (for pasting blocks).
  el.query.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doSearch();
    }
  });
  // Live inline diff as the user edits the replace field (no re-search needed).
  // Focusing the replace box (even empty) previews deletions; typing previews
  // the replacement.
  let replaceFocused = false;
  el.replacement.addEventListener("input", rerenderAllMatches);
  el.replacement.addEventListener("focus", () => {
    replaceFocused = true;
    rerenderAllMatches();
  });
  el.replacement.addEventListener("blur", () => {
    replaceFocused = false;
    rerenderAllMatches();
  });
  autoGrow(el.query);
  autoGrow(el.replacement);
  el.query.addEventListener("input", () => autoGrow(el.query));
  el.replacement.addEventListener("input", () => autoGrow(el.replacement));
  el.connection.addEventListener("change", () =>
    vscode.postMessage({ type: "selectConnection", id: el.connection.value })
  );

  function autoGrow(area) {
    area.style.height = "auto";
    area.style.height = Math.min(area.scrollHeight, 200) + "px";
  }

  function doSearch() {
    groups.clear();
    el.results.innerHTML = "";
    updateReplaceButton();
    lastQuery = el.query.value;
    lastOptions = currentOptions();
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
    const includedPaths = [];
    for (const [path, g] of groups) {
      if (g.checkbox.checked) includedPaths.push(path);
    }
    if (includedPaths.length === 0) {
      setStatus("Nothing selected to replace.", true);
      return;
    }
    vscode.postMessage({
      type: "replace",
      query: lastQuery,
      replacement: el.replacement.value,
      options: lastOptions,
      mount: el.mount.value,
      includedPaths,
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function escapeRegExp(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Build a matcher identical to the extension's, or null if invalid. */
  function buildMatcher(query, o) {
    try {
      let src;
      if (o.regex) {
        src = query;
      } else if (/[\r\n]/.test(query)) {
        src = query.replace(/^\s+|\s+$/g, "").split(/\s+/).map(escapeRegExp).join("\\s+");
      } else {
        src = escapeRegExp(query);
      }
      if (o.wholeWord) src = "\\b(?:" + src + ")\\b";
      return new RegExp(src, "g" + (o.matchCase ? "" : "i"));
    } catch {
      return null;
    }
  }

  function applyReplacement(re, text, replacement, o) {
    re.lastIndex = 0;
    if (o.regex) return text.replace(re, replacement);
    return text.replace(re, replacement.replace(/\$/g, "$$$$"));
  }

  /** Render a single match line: highlight, or inline before/after diff when replacing. */
  function renderMatchLineHtml(match) {
    const line = match.lineText;
    const before = escapeHtml(line.slice(0, match.lineMatchStart));
    const matched = line.slice(match.lineMatchStart, match.lineMatchEnd);
    const after = escapeHtml(line.slice(match.lineMatchEnd));
    const replacement = el.replacement.value;
    const isMulti = match.startLine !== match.endLine;
    // "Replace mode" is active while the replace box is focused or non-empty,
    // so deletions (empty replacement) are previewed too.
    const replacing = replaceFocused || replacement.length > 0;

    if (!replacing) {
      const shown = escapeHtml(matched) + (isMulti ? "<span class='ellipsis'> …</span>" : "");
      return before + "<mark>" + shown + "</mark>" + after;
    }

    const re = buildMatcher(lastQuery, lastOptions);
    if (!re) {
      return before + "<mark>" + escapeHtml(matched) + "</mark>" + after;
    }
    const newFull = applyReplacement(re, match.matchText, replacement, lastOptions);
    const oldShown = escapeHtml(matched) + (isMulti ? " …" : "");
    const del = "<del>" + oldShown + "</del>";
    const ins = newFull.length > 0 ? "<ins>" + escapeHtml(isMulti ? newFull.split("\n")[0] + " …" : newFull) + "</ins>" : "";
    return before + del + ins + after;
  }

  function makeMatchRow(result, match) {
    const row = document.createElement("div");
    row.className = "match-line";
    row.innerHTML =
      '<span class="badge">' + match.location + "</span>" +
      '<span class="code">' + renderMatchLineHtml(match) + "</span>";
    row.title = "Line " + (match.startLine + 1) + " — click to open at this match";
    row.addEventListener("click", () =>
      vscode.postMessage({
        type: "openSecret",
        mount: el.mount.value,
        secretPath: result.secretPath,
        replacement: el.replacement.value,
        selection: {
          startLine: match.startLine,
          startChar: match.startChar,
          endLine: match.endLine,
          endChar: match.endChar,
        },
      })
    );
    return row;
  }

  function renderResult(result) {
    const group = document.createElement("div");
    group.className = "secret-group";

    const header = document.createElement("div");
    header.className = "secret-header";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.title = "Include in replace";
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", updateReplaceButton);
    header.appendChild(checkbox);

    const pathSpan = document.createElement("span");
    pathSpan.className = "path";
    pathSpan.textContent = result.secretPath;
    header.appendChild(pathSpan);

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(result.matches.length);
    header.appendChild(count);
    group.appendChild(header);

    const body = document.createElement("div");
    body.className = "match-body";
    for (const m of result.matches) {
      body.appendChild(makeMatchRow(result, m));
    }
    group.appendChild(body);

    header.addEventListener("click", () => body.classList.toggle("hidden"));
    el.results.appendChild(group);
    groups.set(result.secretPath, { result, groupEl: group, checkbox });
    updateReplaceButton();
  }

  /** Reflect selection in the replace button: "Replace All (N)" vs "Replace Selected (k)". */
  function updateReplaceButton() {
    const total = groups.size;
    let selected = 0;
    for (const g of groups.values()) if (g.checkbox.checked) selected++;
    if (total === 0) {
      el.replaceBtn.textContent = "Replace All";
      el.replaceBtn.disabled = false;
      return;
    }
    if (selected === total) {
      el.replaceBtn.textContent = "Replace All (" + total + ")";
    } else if (selected === 0) {
      el.replaceBtn.textContent = "Replace (none selected)";
    } else {
      el.replaceBtn.textContent = "Replace Selected (" + selected + ")";
    }
  }

  /** Re-render match rows (e.g. after the replace field changes) without re-searching. */
  function rerenderAllMatches() {
    for (const { result, groupEl } of groups.values()) {
      const body = groupEl.querySelector(".match-body");
      if (!body) continue;
      body.innerHTML = "";
      for (const m of result.matches) {
        body.appendChild(makeMatchRow(result, m));
      }
    }
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
        const preferred = msg.connections.find((c) => c.name === msg.defaultConnection) || msg.connections[0];
        fillSelect(el.connection, items, preferred ? preferred.id : undefined);
        if (preferred) vscode.postMessage({ type: "selectConnection", id: preferred.id });
        break;
      }
      case "mounts": {
        if (el.connection.value !== msg.connectionId) break;
        const items = msg.mounts.map((m) => ({ value: m, label: m }));
        fillSelect(el.mount, items, msg.defaultMount || msg.mounts[0] || "");
        break;
      }
      case "prime": {
        if (msg.connectionId) el.connection.value = msg.connectionId;
        if (msg.startPath) el.startPath.value = msg.startPath;
        if (msg.mount) setTimeout(() => { if (msg.mount) el.mount.value = msg.mount; }, 100);
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
