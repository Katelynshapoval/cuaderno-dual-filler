(function () {
  const Plan = globalThis.CuadernoPlan;
  const memory = { settings: null, run: { status: "idle" }, panelOpen: false };
  const listeners = [];
  let host = null;
  let shadow = null;
  let els = null;
  let bootPromise = null;
  let persistTimer = 0;
  let currentRun = { status: "idle" };
  let installed = false;

  const storageArea = {
    get(keys, callback) {
      if (globalThis.chrome?.storage?.local) {
        chrome.storage.local.get(keys, callback);
        return;
      }
      const names = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const name of names) out[name] = memory[name];
      callback(out);
    },
    set(obj, callback) {
      if (globalThis.chrome?.storage?.local) {
        chrome.storage.local.set(obj, callback);
        return;
      }
      Object.assign(memory, obj);
      for (const listener of listeners) {
        const changes = {};
        for (const [key, value] of Object.entries(obj)) changes[key] = { newValue: value };
        listener(changes, "local");
      }
      if (callback) callback();
    },
  };

  function storageGet(key) {
    return new Promise((resolve, reject) => {
      storageArea.get(key, (data) => {
        const err = globalThis.chrome?.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve(data ? data[key] : undefined);
      });
    });
  }

  function storageSet(obj) {
    return new Promise((resolve, reject) => {
      storageArea.set(obj, () => {
        const err = globalThis.chrome?.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  function $(id) {
    return shadow.getElementById(id);
  }

  function dias(count) {
    return count === 1 ? "1 día" : `${count} días`;
  }

  function weekdayInputs() {
    return [...shadow.querySelectorAll("#week input")];
  }

  function readSettingsFromForm() {
    const defaults = Plan.defaultSettings();
    const hoursByWeekday = defaults.hoursByWeekday.slice();
    for (const input of weekdayInputs()) {
      hoursByWeekday[Number(input.dataset.dow)] = input.value.trim() || "0";
    }
    const hourOverrides = {};
    const textOverrides = {};
    for (const row of els.days.querySelectorAll(".day")) {
      if (row.dataset.touched === "1") {
        hourOverrides[row.dataset.iso] = row.querySelector(".hours").value.trim() || "0";
      }
      const text = row.querySelector(".day-text")?.value.trim() || "";
      if (text) textOverrides[row.dataset.iso] = text;
    }
    const pauseSeconds = Number(els.pause.value);
    return {
      start: els.start.value,
      end: els.end.value,
      hoursByWeekday,
      skipZero: els.skipZero.checked,
      commaDecimals: els.comma.checked,
      descripcion: els.descripcion.value,
      observaciones: els.observaciones.value,
      dificultades: els.dificultades.value,
      hourOverrides,
      textOverrides,
      pauseMs: Number.isFinite(pauseSeconds) ? Math.round(Math.min(10, Math.max(0.4, pauseSeconds)) * 1000) : 1200,
    };
  }

  function writeSettings(settings) {
    els.start.value = settings.start || "";
    els.end.value = settings.end || "";
    els.skipZero.checked = settings.skipZero !== false;
    els.comma.checked = settings.commaDecimals !== false;
    els.descripcion.value = settings.descripcion || "";
    els.observaciones.value = settings.observaciones || "";
    els.dificultades.value = settings.dificultades || "";
    els.pause.value = String((settings.pauseMs || 1200) / 1000);
    const hours = settings.hoursByWeekday || Plan.defaultSettings().hoursByWeekday;
    for (const input of weekdayInputs()) {
      input.value = hours[Number(input.dataset.dow)] ?? "0";
    }
  }

  function renderDays(settings) {
    const previous = new Map();
    for (const row of els.days.querySelectorAll(".day")) {
      previous.set(row.dataset.iso, {
        text: row.querySelector(".day-text")?.value || "",
        open: row.querySelector(".day-extra") && !row.querySelector(".day-extra").hidden,
      });
    }
    const plan = Plan.buildPlan({ ...settings, hourOverrides: settings.hourOverrides || {} });
    const fragment = document.createDocumentFragment();
    for (const entry of plan.entries) {
      const saved = previous.get(entry.iso);
      const touched = Object.prototype.hasOwnProperty.call(settings.hourOverrides || {}, entry.iso);
      const hours = Number.isFinite(entry.hoursNum) ? String(entry.hoursNum) : "";
      const text = saved?.text || settings.textOverrides?.[entry.iso] || "";
      const row = document.createElement("div");
      row.className = "day";
      row.dataset.iso = entry.iso;
      row.dataset.touched = touched ? "1" : "0";
      if (Plan.parseHours(hours) <= 0) row.classList.add("is-off");
      if (touched) row.classList.add("is-custom");
      row.innerHTML = `
        <span class="dmy">${entry.fecha}</span>
        <span class="day-dow" title="${entry.dia}">${entry.diaCorto}</span>
        <input class="hours" type="number" min="0" max="24" step="0.5" aria-label="Horas del ${entry.fecha}" />
        <button type="button" class="text-toggle" aria-expanded="false">Texto</button>
        <div class="day-extra" hidden>
          <textarea class="day-text" rows="2" maxlength="2000" placeholder="Descripción solo para este día. Vacío: se usa la principal."></textarea>
        </div>
      `;
      row.querySelector(".hours").value = hours;
      const extra = row.querySelector(".day-extra");
      const toggle = row.querySelector(".text-toggle");
      row.querySelector(".day-text").value = text;
      if ((saved && saved.open) || text) {
        extra.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
      }
      fragment.appendChild(row);
    }
    els.days.replaceChildren(fragment);
    if (plan.entries.length > 0 && plan.entries.length <= 12) els.details.open = true;
  }

  function updateSummary() {
    const settings = readSettingsFromForm();
    const plan = Plan.buildPlan(settings);
    const summary = Plan.summarize(plan);
    els.descCount.textContent = `${settings.descripcion.length}/2000`;
    els.obsCount.textContent = `${settings.observaciones.length}/2000`;
    els.difCount.textContent = `${settings.dificultades.length}/2000`;
    for (const row of els.days.querySelectorAll(".day")) {
      const hours = Plan.parseHours(row.querySelector(".hours").value);
      row.classList.toggle("is-off", !(hours > 0));
      row.classList.toggle("is-custom", row.dataset.touched === "1");
    }
    if (!summary.days) {
      els.summary.textContent = plan.entries.length
        ? "Todos los días de este intervalo están a 0 horas."
        : "No hay días en este intervalo.";
    } else {
      const span = summary.first === summary.last ? summary.first : `${summary.first} – ${summary.last}`;
      const skipped = summary.skipped === 1 ? " · 1 omitido" : summary.skipped ? ` · ${summary.skipped} omitidos` : "";
      els.summary.textContent = `${dias(summary.days)} · ${summary.hours} h · ${span}${skipped}`;
    }
    els.hint.textContent = plan.errors[0] || "";
    const running = currentRun && currentRun.status === "running";
    els.fill.disabled = running || plan.errors.length > 0 || summary.days === 0;
    els.fill.textContent = `Rellenar ${dias(summary.days)}`;
    if (host) {
      host.dataset.days = String(summary.days);
      host.dataset.ready = "1";
    }
    return { settings, plan, summary };
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      storageSet({ settings: readSettingsFromForm() }).catch(() => {});
    }, 150);
  }

  function setBanner(el, kind, text) {
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      el.className = "banner";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = `banner ${kind}`;
  }

  function renderRun(run) {
    currentRun = run && run.status ? run : { status: "idle" };
    const status = currentRun.status || "idle";
    const active = status === "running" || status === "paused" || status === "error" || status === "done";
    host.classList.toggle("is-locked", status !== "idle");
    els.idleActions.hidden = active;
    els.runActions.hidden = !active;
    els.resume.hidden = status === "running" || status === "done";
    els.skip.hidden = status !== "error";
    els.stop.hidden = status !== "running" && status !== "paused";
    els.stop.textContent = status === "paused" ? "En pausa" : "Parar";
    els.edit.hidden = status === "running";

    const total = currentRun.entries?.length || 0;
    const index = Math.min(currentRun.index || 0, total);
    const pct = total === 0 ? 0 : Math.round((Math.min(index, total) / total) * 100);
    els.progressWrap.hidden = !active;
    els.progressBar.style.width = `${status === "done" ? 100 : pct}%`;

    if (status === "running") {
      const fecha = currentRun.entries?.[index]?.fecha || "";
      setBanner(
        els.runBanner,
        "warn",
        fecha ? `Guardando ${index + 1} de ${total} · ${fecha}` : `Guardando ${dias(total)}…`
      );
    } else if (status === "paused") {
      setBanner(
        els.runBanner,
        "warn",
        `En pausa, van ${index} de ${total}. Los días ya guardados siguen en el portal.`
      );
    } else if (status === "error") {
      const fecha = currentRun.entries?.[index]?.fecha || "Este día";
      setBanner(els.runBanner, "bad", `${fecha}: ${currentRun.error || "La página no ha aceptado este día."}`);
    } else if (status === "done") {
      setBanner(
        els.runBanner,
        "ok",
        total === 1 ? "Se ha guardado 1 día." : `Se han guardado ${total} días.`
      );
    } else {
      setBanner(els.runBanner, "", "");
    }
    updateSummary();
  }

  async function currentTabId() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "WHOAMI" });
      return response && response.tabId != null ? response.tabId : null;
    } catch (error) {
      return null;
    }
  }

  function kickFill() {
    if (globalThis.CuadernoFill) return globalThis.CuadernoFill.kick();
    return null;
  }

  async function onCheck() {
    try {
      if (!globalThis.CuadernoFill) {
        setBanner(els.tabBanner, "bad", "Recarga la página del cuaderno e inténtalo de nuevo.");
        return;
      }
      const result = globalThis.CuadernoFill.inspect(true);
      if (!result || !result.ok) {
        setBanner(els.tabBanner, "bad", (result && result.error) || "No encuentro el formulario en esta página.");
        return;
      }
      setBanner(els.tabBanner, "ok", result.summary);
    } catch (error) {
      setBanner(els.tabBanner, "bad", "No he podido leer esta página. Recárgala e inténtalo de nuevo.");
    }
  }

  function queueFromPlan(plan) {
    return plan.submittable.map((entry) => ({
      iso: entry.iso,
      fecha: entry.fecha,
      horas: entry.horas,
      descripcion: entry.descripcion,
      observaciones: entry.observaciones,
      dificultades: entry.dificultades,
      status: "pending",
    }));
  }

  async function onFill() {
    const { settings, plan } = updateSummary();
    if (plan.errors.length || !plan.submittable.length) return;
    const run = {
      status: "running",
      index: 0,
      pauseMs: settings.pauseMs,
      phase: "idle",
      tabId: await currentTabId(),
      entries: queueFromPlan(plan),
      error: null,
      owner: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await storageSet({ settings, run });
      renderRun(run);
      kickFill();
    } catch (error) {
      setBanner(els.runBanner, "bad", "No he podido empezar. Recarga la página e inténtalo de nuevo.");
    }
  }

  async function patchRun(mutator) {
    const run = await storageGet("run");
    if (!run) return null;
    const next = mutator(run);
    if (!next) return run;
    await storageSet({ run: next });
    renderRun(next);
    return next;
  }

  async function onStop() {
    await patchRun((run) => (run.status === "running" ? { ...run, status: "paused", updatedAt: Date.now() } : run));
  }

  async function onResume() {
    const tabId = await currentTabId();
    const next = await patchRun((run) => {
      if (!run.entries || run.index >= run.entries.length) {
        return { ...run, status: "done", phase: "idle", error: null, updatedAt: Date.now() };
      }
      return {
        ...run,
        status: "running",
        phase: "idle",
        owner: null,
        error: null,
        tabId: tabId != null ? tabId : run.tabId,
        updatedAt: Date.now(),
      };
    });
    if (next && next.status === "running") kickFill();
  }

  async function onSkip() {
    const tabId = await currentTabId();
    const next = await patchRun((run) => {
      if (!run.entries || run.index >= run.entries.length) {
        return { ...run, status: "done", error: null, phase: "idle" };
      }
      const entries = run.entries.map((entry, index) =>
        index === run.index ? { ...entry, status: "skipped" } : entry
      );
      const index = run.index + 1;
      const finished = index >= entries.length;
      return {
        ...run,
        entries,
        index,
        status: finished ? "done" : "running",
        phase: "idle",
        owner: null,
        error: null,
        tabId: tabId != null ? tabId : run.tabId,
        updatedAt: Date.now(),
      };
    });
    if (next && next.status === "running") kickFill();
  }

  async function onEdit() {
    await patchRun((run) => ({
      ...run,
      status: "idle",
      phase: "idle",
      owner: null,
      error: null,
      updatedAt: Date.now(),
    }));
  }

  function onDayClick(event) {
    const toggle = event.target.closest(".text-toggle");
    if (!toggle) return;
    const extra = toggle.parentElement.querySelector(".day-extra");
    extra.hidden = !extra.hidden;
    toggle.setAttribute("aria-expanded", extra.hidden ? "false" : "true");
  }

  function onDayInput(event) {
    const row = event.target.closest(".day");
    if (!row) return;
    if (event.target.classList.contains("hours")) row.dataset.touched = "1";
    updateSummary();
    persist();
  }

  function onPaste() {
    const parsed = Plan.parseHoursPaste(els.paste.value);
    let applied = 0;
    for (const [iso, hours] of Object.entries(parsed.overrides)) {
      const row = els.days.querySelector(`.day[data-iso="${iso}"]`);
      if (!row) continue;
      row.querySelector(".hours").value = String(Plan.parseHours(hours));
      row.dataset.touched = "1";
      applied += 1;
    }
    const outside = Object.keys(parsed.overrides).length - applied;
    const parts = [`Aplicadas ${applied}.`];
    if (outside > 0) parts.push(`${outside} fuera del intervalo.`);
    if (parsed.ignored.length) parts.push(`${parsed.ignored.length} líneas no eran fechas.`);
    els.pasteResult.textContent = parts.join(" ");
    updateSummary();
    persist();
  }

  function onResetHours() {
    for (const row of els.days.querySelectorAll(".day")) row.dataset.touched = "0";
    const settings = readSettingsFromForm();
    settings.hourOverrides = {};
    renderDays(settings);
    updateSummary();
    persist();
  }

  function onStructureChange() {
    const settings = readSettingsFromForm();
    renderDays(settings);
    updateSummary();
    persist();
  }

  function bind() {
    $("start").addEventListener("change", onStructureChange);
    $("end").addEventListener("change", onStructureChange);
    for (const input of weekdayInputs()) input.addEventListener("input", onStructureChange);
    els.skipZero.addEventListener("change", () => {
      updateSummary();
      persist();
    });
    els.comma.addEventListener("change", () => {
      updateSummary();
      persist();
    });
    for (const el of [els.descripcion, els.observaciones, els.dificultades, els.pause]) {
      el.addEventListener("input", () => {
        updateSummary();
        persist();
      });
    }
    els.days.addEventListener("input", onDayInput);
    els.days.addEventListener("click", onDayClick);
    $("apply-paste").addEventListener("click", onPaste);
    $("reset-hours").addEventListener("click", onResetHours);
    $("close").addEventListener("click", () => hide());
    els.check.addEventListener("click", () => onCheck().catch(() => {}));
    els.fill.addEventListener("click", () => onFill().catch(() => {}));
    els.stop.addEventListener("click", () => onStop().catch(() => {}));
    els.resume.addEventListener("click", () => onResume().catch(() => {}));
    els.skip.addEventListener("click", () => onSkip().catch(() => {}));
    els.edit.addEventListener("click", () => onEdit().catch(() => {}));
    shadow.addEventListener(
      "wheel",
      (event) => {
        if (event.target.type === "number" && shadow.activeElement === event.target) event.preventDefault();
      },
      { passive: false }
    );
  }

  function markup() {
    return `
      <div class="sheet">
        <header class="top">
          <div>
            <h1>Cuaderno Dual</h1>
            <p>Rellena el desarrollo en esta misma página.</p>
          </div>
          <button id="close" type="button" aria-label="Cerrar">×</button>
        </header>
        <p id="tab-banner" class="banner" hidden></p>
        <p id="run-banner" class="banner" role="status" aria-live="polite" hidden></p>
        <div id="progress-wrap" class="progress" hidden><div id="progress-bar"></div></div>
        <div id="editor">
          <section class="card">
            <div class="dates">
              <label>Desde <input id="start" type="date" autocomplete="off" /></label>
              <label>Hasta <input id="end" type="date" autocomplete="off" /></label>
            </div>
            <div class="week" id="week">
              <label class="dow">Lun <input type="number" min="0" max="24" step="0.5" data-dow="1" autocomplete="off" /></label>
              <label class="dow">Mar <input type="number" min="0" max="24" step="0.5" data-dow="2" autocomplete="off" /></label>
              <label class="dow">Mié <input type="number" min="0" max="24" step="0.5" data-dow="3" autocomplete="off" /></label>
              <label class="dow">Jue <input type="number" min="0" max="24" step="0.5" data-dow="4" autocomplete="off" /></label>
              <label class="dow">Vie <input type="number" min="0" max="24" step="0.5" data-dow="5" autocomplete="off" /></label>
              <label class="dow weekend">Sáb <input type="number" min="0" max="24" step="0.5" data-dow="6" autocomplete="off" /></label>
              <label class="dow weekend">Dom <input type="number" min="0" max="24" step="0.5" data-dow="0" autocomplete="off" /></label>
            </div>
            <label class="check"><input id="skip-zero" type="checkbox" /> Saltar los días con 0 horas</label>
          </section>
          <section class="card">
            <label class="field">
              <span class="field-label">Descripción <span id="desc-count" class="count">0/2000</span></span>
              <textarea id="descripcion" rows="3" maxlength="2000" autocomplete="off" placeholder="Qué has hecho. {fecha}, {dia} y {horas} cambian cada día."></textarea>
            </label>
            <label class="field">
              <span class="field-label">Observaciones <span id="obs-count" class="count">0/2000</span></span>
              <textarea id="observaciones" rows="2" maxlength="2000" autocomplete="off" placeholder="Opcional"></textarea>
            </label>
            <label class="field">
              <span class="field-label">Dificultades <span id="dif-count" class="count">0/2000</span></span>
              <textarea id="dificultades" rows="2" maxlength="2000" autocomplete="off" placeholder="Opcional"></textarea>
            </label>
          </section>
          <section class="card">
            <div class="summary-row">
              <p id="summary" class="summary">Sin días</p>
              <button id="reset-hours" type="button" class="text-button">Restablecer horas</button>
            </div>
            <p id="plan-hint" class="hint"></p>
            <details id="day-details">
              <summary>Horas y texto de cada día</summary>
              <div id="days" class="days"></div>
              <label class="field paste-field">Pegar horas
                <textarea id="paste" rows="3" autocomplete="off" placeholder="10/11/2026 8&#10;11/11/2026 6,5"></textarea>
              </label>
              <button id="apply-paste" type="button" class="secondary">Aplicar horas pegadas</button>
              <p id="paste-result" class="hint"></p>
            </details>
            <label class="more">Pausa entre días (segundos) <input id="pause" type="number" min="0.4" max="10" step="0.1" autocomplete="off" /></label>
            <label class="check"><input id="comma" type="checkbox" /> Enviar los decimales con coma (7,5)</label>
          </section>
        </div>
        <footer class="actions">
          <div id="run-actions" class="run-actions" hidden>
            <button id="resume" type="button" class="primary">Continuar</button>
            <button id="skip" type="button" class="secondary">Saltar este día</button>
            <button id="stop" type="button" class="secondary">Parar</button>
            <button id="edit" type="button" class="text-button">Editar el plan</button>
          </div>
          <div id="idle-actions">
            <button id="check" type="button" class="secondary">Comprobar esta página</button>
            <button id="fill" type="button" class="primary">Rellenar días</button>
          </div>
          <p class="fine">Elige el intervalo y pulsa Rellenar. Se escribe en el formulario de esta página y se pulsa Nueva por cada día, sin abrir otra ventana. Déjala abierta hasta que termine.</p>
        </footer>
      </div>
    `;
  }

  async function applyCss() {
    const style = document.createElement("style");
    style.textContent = ":host{all:initial;position:fixed;top:12px;right:12px;z-index:2147483646;width:380px;display:block;font:13px/1.4 Segoe UI,sans-serif;color:#241c18} :host(.is-hidden){display:none !important}";
    shadow.appendChild(style);
    try {
      if (!chrome.runtime?.getURL) return;
      const response = await fetch(chrome.runtime.getURL("panel/panel.css"));
      if (!response.ok) return;
      const css = await response.text();
      if (css.includes(":host")) style.textContent = css;
    } catch (error) {
      // Si el CSS no carga, el panel sigue en la página con el estilo mínimo.
    }
  }

  function cacheElements() {
    els = {
      start: $("start"),
      end: $("end"),
      skipZero: $("skip-zero"),
      descripcion: $("descripcion"),
      observaciones: $("observaciones"),
      dificultades: $("dificultades"),
      descCount: $("desc-count"),
      obsCount: $("obs-count"),
      difCount: $("dif-count"),
      summary: $("summary"),
      hint: $("plan-hint"),
      days: $("days"),
      details: $("day-details"),
      paste: $("paste"),
      pasteResult: $("paste-result"),
      pause: $("pause"),
      comma: $("comma"),
      tabBanner: $("tab-banner"),
      runBanner: $("run-banner"),
      progressWrap: $("progress-wrap"),
      progressBar: $("progress-bar"),
      fill: $("fill"),
      check: $("check"),
      resume: $("resume"),
      skip: $("skip"),
      stop: $("stop"),
      edit: $("edit"),
      idleActions: $("idle-actions"),
      runActions: $("run-actions"),
    };
  }

  async function boot() {
    const saved = await storageGet("settings");
    const settings = { ...Plan.defaultSettings(), ...(saved || {}) };
    if (!settings.start) settings.start = Plan.todayISO();
    if (!settings.end) settings.end = Plan.todayISO();
    writeSettings(settings);
    renderDays(settings);
    bind();
    const run = await storageGet("run");
    renderRun(run);
    const listen = (changes, area) => {
      if (area === "local" && changes.run) renderRun(changes.run.newValue);
    };
    listeners.push(listen);
    if (globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener(listen);
  }

  function create() {
    host = document.createElement("div");
    host.id = "cuaderno-dual-host";
    host.className = "is-hidden";
    shadow = host.attachShadow({ mode: "open" });
    const root = document.createElement("div");
    root.innerHTML = markup();
    shadow.appendChild(root);
    cacheElements();
    document.documentElement.appendChild(host);
    bootPromise = applyCss().then(() => boot());
    return bootPromise;
  }

  function show() {
    if (window !== window.top) return Promise.resolve();
    const pending = host ? bootPromise : create();
    host.classList.remove("is-hidden");
    storageSet({ panelOpen: true }).catch(() => {});
    return pending;
  }

  function hide() {
    if (host) host.classList.add("is-hidden");
    storageSet({ panelOpen: false }).catch(() => {});
  }

  function toggle() {
    if (host && !host.classList.contains("is-hidden")) {
      hide();
      return Promise.resolve();
    }
    return show();
  }

  function install() {
    if (installed || window !== window.top) return;
    installed = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "TOGGLE_PANEL") return;
      toggle();
      sendResponse({ ok: true });
    });
    Promise.all([storageGet("panelOpen"), storageGet("run")])
      .then(([open, run]) => {
        const active = run && run.status && run.status !== "idle";
        if (open || active) return show();
        return null;
      })
      .catch(() => {});
  }

  globalThis.CuadernoPanel = { install, show, hide, toggle };
})();
