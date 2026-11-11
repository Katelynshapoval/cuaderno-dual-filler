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

  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    logo: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M9.5 13.5l2 2 3.5-4"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    collapse: svg('<path d="M6 15l6-6 6 6"/>'),
    prev: svg('<path d="M15 6l-6 6 6 6"/>'),
    next: svg('<path d="M9 6l6 6-6 6"/>'),
    calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2"/>'),
    arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  };
  const Cal = globalThis.CuadernoCalendar;
  const KIND_LABEL = { t1: "Tipo 1", t2: "Tipo 2", t3: "Tipo 3", t4: "Tipo 4" };
  // El calendario solo vive aquí, en memoria: no se guarda en chrome.storage.
  let calendar = null;
  let calWeekStart = null;
  let calWeekAnchor = null;
  const NEAR_LIMIT = 1700;

  function dias(count) {
    return count === 1 ? "1 día" : `${count} días`;
  }

  function setCount(el, length) {
    el.textContent = `${length}/2000`;
    el.classList.toggle("is-near", length >= NEAR_LIMIT);
  }

  function setChip(kind, text) {
    els.chip.hidden = !text;
    els.chip.className = kind ? `chip ${kind}` : "chip";
    els.chip.textContent = text;
  }

  function presetRange(name) {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    let start = today;
    let end = today;
    if (name === "week") {
      start = monday;
    } else if (name === "last-week") {
      start = new Date(monday);
      start.setDate(monday.getDate() - 7);
      end = new Date(monday);
      end.setDate(monday.getDate() - 1);
    } else if (name === "month") {
      start = new Date(today.getFullYear(), today.getMonth(), 1, 12);
    }
    return [Plan.toISO(start), Plan.toISO(end)];
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
    return {
      start: els.start.value,
      end: els.end.value,
      hoursByWeekday,
      skipZero: els.skipZero.checked,
      commaDecimals: false,
      descripcion: els.descripcion.value,
      observaciones: els.observaciones.value,
      dificultades: els.dificultades.value,
      hourOverrides: {},
      textOverrides: {},
      pauseMs: Plan.defaultSettings().pauseMs,
    };
  }

  function writeSettings(settings) {
    els.start.value = settings.start || "";
    els.end.value = settings.end || "";
    els.skipZero.checked = settings.skipZero !== false;
    els.descripcion.value = settings.descripcion || "";
    els.observaciones.value = settings.observaciones || "";
    els.dificultades.value = settings.dificultades || "";
    const hours = settings.hoursByWeekday || Plan.defaultSettings().hoursByWeekday;
    for (const input of weekdayInputs()) {
      input.value = hours[Number(input.dataset.dow)] ?? "0";
    }
    els.extraText.open = Boolean(settings.observaciones || settings.dificultades);
  }

  function updateSummary() {
    const settings = readSettingsFromForm();
    const plan = Plan.buildPlan(withCalendar(settings));
    const summary = Plan.summarize(plan);
    setCount(els.descCount, settings.descripcion.length);
    setCount(els.obsCount, settings.observaciones.length);
    setCount(els.difCount, settings.dificultades.length);
    if (calendar) {
      const weekly = renderCalWeek(settings);
      els.weekTotal.textContent = `${Math.round(weekly * 100) / 100} h esta semana`;
    } else {
      const weekly = settings.hoursByWeekday.reduce((total, value) => {
        const hours = Plan.parseHours(value);
        return total + (hours > 0 ? hours : 0);
      }, 0);
      els.weekTotal.textContent = `${Math.round(weekly * 100) / 100} h / semana`;
    }

    for (const button of els.presets.querySelectorAll(".preset")) {
      const [start, end] = presetRange(button.dataset.preset);
      button.classList.toggle("is-active", start === settings.start && end === settings.end);
    }

    els.stats.hidden = !summary.days;
    els.summaryEmpty.hidden = Boolean(summary.days);
    if (!summary.days) {
      els.summaryEmpty.textContent = plan.entries.length
        ? "Nada que rellenar: todos los días de este intervalo están a 0 horas."
        : "No hay días en este intervalo.";
    } else {
      els.statDays.textContent = summary.days;
      els.statDaysLabel.textContent = summary.days === 1 ? "día" : "días";
      els.statHours.textContent = summary.hours;
      const span = summary.first === summary.last ? summary.first : `${summary.first} – ${summary.last}`;
      const skipped = summary.skipped === 1 ? " · 1 omitido" : summary.skipped ? ` · ${summary.skipped} omitidos` : "";
      els.statRange.textContent = `${span}${skipped}`;
    }
    els.hint.textContent = plan.errors[0] || "";
    const running = currentRun && currentRun.status === "running";
    els.fill.disabled = running || plan.errors.length > 0 || summary.days === 0;
    els.fillLabel.textContent = summary.days ? `Rellenar ${dias(summary.days)}` : "Rellenar";
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
    els.stop.hidden = status !== "running";
    els.edit.hidden = status === "running";
    els.summaryBox.hidden = active;

    const total = currentRun.entries?.length || 0;
    const index = Math.min(currentRun.index || 0, total);
    const done = status === "done" ? total : index;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    els.progressWrap.hidden = !active;
    els.progressWrap.classList.toggle("is-running", status === "running");
    els.progressBar.style.width = `${status === "done" ? 100 : pct}%`;
    els.progressCount.textContent = `${done} / ${total}`;

    if (status === "running") {
      const fecha = currentRun.entries?.[index]?.fecha || "";
      setChip("busy", "Rellenando");
      els.progressLabel.textContent = fecha ? `Guardando ${fecha}…` : `Guardando ${dias(total)}…`;
      setBanner(els.runBanner, "", "");
    } else if (status === "paused") {
      setChip("warn", "En pausa");
      els.progressLabel.textContent = "En pausa";
      setBanner(els.runBanner, "warn", "Los días ya guardados siguen en el portal. Pulsa Continuar para seguir.");
    } else if (status === "error") {
      const fecha = currentRun.entries?.[index]?.fecha || "Este día";
      setChip("bad", "Error");
      els.progressLabel.textContent = "Detenido";
      setBanner(els.runBanner, "bad", `${fecha}: ${currentRun.error || "La página no ha aceptado este día."}`);
    } else if (status === "done") {
      setChip("ok", "Hecho");
      els.progressLabel.textContent = "Completado";
      setBanner(
        els.runBanner,
        "ok",
        total === 1 ? "Se ha guardado 1 día." : `Se han guardado ${total} días.`
      );
    } else {
      setChip("", "");
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

  function onPreset(event) {
    const button = event.target.closest(".preset");
    if (!button) return;
    const [start, end] = presetRange(button.dataset.preset);
    els.start.value = start;
    els.end.value = end;
    onStructureChange();
  }

  function onToken(event) {
    const button = event.target.closest(".token");
    if (!button) return;
    const area = els.descripcion;
    const from = area.selectionStart ?? area.value.length;
    const to = area.selectionEnd ?? from;
    area.setRangeText(button.dataset.token, from, to, "end");
    area.focus();
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function withCalendar(settings) {
    return calendar ? { ...settings, calendar: { days: calendar.days, hours: calendar.hours } } : settings;
  }

  function mondayOf(iso) {
    const date = Plan.parseISO(iso) || Plan.parseISO(Plan.todayISO());
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return date;
  }

  function renderCalWeek(settings) {
    if (settings.start !== calWeekAnchor) {
      calWeekAnchor = settings.start;
      calWeekStart = mondayOf(settings.start);
    }
    const sunday = new Date(calWeekStart);
    sunday.setDate(calWeekStart.getDate() + 6);
    const week = Plan.buildPlan(
      withCalendar({ ...settings, start: Plan.toISO(calWeekStart), end: Plan.toISO(sunday) })
    );
    let total = 0;
    const cells = week.entries.map((entry) => {
      if (!entry.skipped && entry.hoursNum > 0) total += entry.hoursNum;
      let value = `${Number.isFinite(entry.hoursNum) ? entry.hoursNum : 0} h`;
      if (entry.calKind === "festivo") value = "Festivo";
      else if (entry.calKind === "vacaciones") value = "Vacac.";
      else if (entry.skipped) value = "—";
      const inRange = entry.iso >= settings.start && entry.iso <= settings.end;
      const dow = entry.diaCorto.charAt(0).toUpperCase() + entry.diaCorto.slice(1);
      return `
        <div class="cw-day${inRange ? " in-range" : ""}" data-kind="${entry.calKind}" title="${entry.dia} ${entry.fecha}">
          <span class="cw-dow">${dow}</span>
          <span class="cw-date">${entry.fecha.slice(0, 5)}</span>
          <span class="cw-hours">${value}</span>
        </div>`;
    });
    els.calWeekDays.innerHTML = cells.join("");
    els.calWeekLabel.textContent = `Semana del ${Plan.formatES(calWeekStart).slice(0, 5)} al ${Plan.formatES(sunday)}`;
    return total;
  }

  function onCalWeekShift(days) {
    if (!calWeekStart) return;
    calWeekStart = new Date(calWeekStart);
    calWeekStart.setDate(calWeekStart.getDate() + days);
    updateSummary();
  }

  function formatISO(iso) {
    const date = Plan.parseISO(iso);
    return date ? Plan.formatES(date) : "";
  }

  function renderCalendar() {
    const loaded = Boolean(calendar);
    els.calPick.hidden = loaded;
    els.calLoaded.hidden = !loaded;
    els.calWeek.hidden = !loaded;
    els.week.hidden = loaded;
    calWeekAnchor = null;
    if (!loaded) {
      els.calTypes.replaceChildren();
      return;
    }
    els.calRange.textContent = `${formatISO(calendar.firstWork)} – ${formatISO(calendar.lastWork)}`;
    const fragment = document.createDocumentFragment();
    for (const kind of Cal.WORK_KINDS) {
      const count = calendar.counts[kind];
      if (!count) continue;
      const row = document.createElement("label");
      row.className = "cal-type";
      row.innerHTML = `
        <span class="swatch" style="background:${Cal.SWATCH[kind]}"></span>
        <span class="cal-type-name">${KIND_LABEL[kind]}</span>
        <span class="cal-type-count">${dias(count)}</span>
        <span class="cal-type-hours"><input type="number" min="0" max="24" step="0.5" data-kind="${kind}" aria-label="Horas en empresa, ${KIND_LABEL[kind]}" /> h</span>
      `;
      row.querySelector("input").value = calendar.hours[kind];
      fragment.appendChild(row);
    }
    els.calTypes.replaceChildren(fragment);
    const off = [];
    if (calendar.counts.festivo) {
      off.push(`<span class="swatch" style="background:${Cal.SWATCH.festivo}"></span> ${calendar.counts.festivo} festivos`);
    }
    if (calendar.counts.vacaciones) {
      off.push(`<span class="swatch" style="background:${Cal.SWATCH.vacaciones}"></span> ${dias(calendar.counts.vacaciones)} de vacaciones`);
    }
    els.calOff.innerHTML = off.length ? `${off.join(" · ")} <span class="cal-off-note">se saltan</span>` : "";
  }

  async function onCalendarFile(file) {
    if (!file || !Cal) return;
    els.calError.textContent = "";
    els.calPick.disabled = true;
    els.calPickLabel.textContent = "Leyendo el calendario…";
    try {
      const result = await Cal.readCalendar(file);
      calendar = { ...result, hours: { ...Cal.DEFAULT_HOURS } };
      renderCalendar();
      onStructureChange();
    } catch (error) {
      els.calError.textContent = (error && error.message) || "No he podido leer el calendario.";
    } finally {
      els.calFile.value = "";
      els.calPick.disabled = false;
      els.calPickLabel.textContent = "Usar mi calendario FP Dual";
    }
  }

  function onCalendarHours(event) {
    const input = event.target.closest("input[data-kind]");
    if (!input || !calendar) return;
    calendar.hours[input.dataset.kind] = input.value.trim() || "0";
    onStructureChange();
  }

  function onCalendarRemove() {
    calendar = null;
    els.calError.textContent = "";
    renderCalendar();
    onStructureChange();
  }

  function onCalendarContract() {
    if (!calendar) return;
    const today = Plan.todayISO();
    els.start.value = calendar.firstWork;
    els.end.value = calendar.lastWork < today ? calendar.lastWork : today;
    onStructureChange();
  }

  function bindCalendar() {
    if (!Cal) {
      $("cal-box").hidden = true;
      return;
    }
    els.calPick.addEventListener("click", () => els.calFile.click());
    els.calFile.addEventListener("change", () => onCalendarFile(els.calFile.files[0]));
    els.calPick.addEventListener("dragover", (event) => {
      event.preventDefault();
      els.calPick.classList.add("is-drag");
    });
    els.calPick.addEventListener("dragleave", () => els.calPick.classList.remove("is-drag"));
    els.calPick.addEventListener("drop", (event) => {
      event.preventDefault();
      els.calPick.classList.remove("is-drag");
      onCalendarFile(event.dataTransfer.files[0]);
    });
    els.calTypes.addEventListener("input", onCalendarHours);
    $("cal-remove").addEventListener("click", onCalendarRemove);
    $("cal-contract").addEventListener("click", onCalendarContract);
    $("cal-week-prev").addEventListener("click", () => onCalWeekShift(-7));
    $("cal-week-next").addEventListener("click", () => onCalWeekShift(7));
  }

  function onMinimize() {
    const min = host.classList.toggle("is-min");
    els.minimize.setAttribute("aria-expanded", min ? "false" : "true");
    els.minimize.setAttribute("aria-label", min ? "Expandir" : "Minimizar");
    els.minimize.title = min ? "Expandir" : "Minimizar";
  }

  function onStructureChange() {
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
    for (const el of [els.descripcion, els.observaciones, els.dificultades]) {
      el.addEventListener("input", () => {
        updateSummary();
        persist();
      });
    }
    $("close").addEventListener("click", () => hide());
    els.minimize.addEventListener("click", onMinimize);
    els.presets.addEventListener("click", onPreset);
    els.tokens.addEventListener("click", onToken);
    bindCalendar();
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
          <div class="brand">
            <span class="logo">${ICONS.logo}</span>
            <div>
              <h1>Cuaderno Dual</h1>
              <p class="sub">Rellena el seguimiento en esta página</p>
            </div>
          </div>
          <span id="status-chip" class="chip" hidden></span>
          <button id="minimize" type="button" class="icon-btn" aria-label="Minimizar" title="Minimizar" aria-expanded="true">${ICONS.collapse}</button>
          <button id="close" type="button" class="icon-btn" aria-label="Cerrar" title="Cerrar">${ICONS.close}</button>
        </header>
        <div class="body">
        <div id="editor">
          <section class="card">
            <h2 class="step"><span class="num">1</span> Fechas</h2>
            <div class="presets" id="presets">
              <button type="button" class="preset" data-preset="today">Hoy</button>
              <button type="button" class="preset" data-preset="week">Esta semana</button>
              <button type="button" class="preset" data-preset="last-week">Semana pasada</button>
              <button type="button" class="preset" data-preset="month">Este mes</button>
            </div>
            <div class="dates">
              <label>Desde <input id="start" type="date" autocomplete="off" /></label>
              <label>Hasta <input id="end" type="date" autocomplete="off" /></label>
            </div>
          </section>
          <section class="card">
            <div class="step-row">
              <h2 class="step"><span class="num">2</span> Horario</h2>
              <span id="week-total" class="pill">0 h / semana</span>
            </div>
            <div id="cal-box">
              <input id="cal-file" type="file" accept="application/pdf,.pdf,image/png,image/jpeg" hidden />
              <button id="cal-pick" type="button" class="dropzone">
                ${ICONS.calendar}
                <span class="dropzone-text">
                  <strong id="cal-pick-label">Usar mi calendario FP Dual</strong>
                  <span>PDF opcional · se lee en tu equipo y no se guarda</span>
                </span>
              </button>
              <div id="cal-loaded" class="cal" hidden>
                <div class="cal-head">
                  <div>
                    <strong>Calendario cargado</strong>
                    <span id="cal-range" class="cal-range"></span>
                  </div>
                  <button id="cal-remove" type="button" class="text-button">Quitar</button>
                </div>
                <div id="cal-types" class="cal-types"></div>
                <p id="cal-off" class="cal-off"></p>
                <div class="cal-foot">
                  <button id="cal-contract" type="button" class="text-button">Desde el inicio del contrato hasta hoy</button>
                </div>
                <p class="cal-note">Solo está en memoria: al recargar la página tendrás que subirlo otra vez.</p>
              </div>
              <p id="cal-error" class="hint error"></p>
            </div>
            <div id="cal-week" class="cal-week" hidden>
              <div class="cal-week-head">
                <button id="cal-week-prev" type="button" class="icon-btn small" aria-label="Semana anterior" title="Semana anterior">${ICONS.prev}</button>
                <span id="cal-week-label"></span>
                <button id="cal-week-next" type="button" class="icon-btn small" aria-label="Semana siguiente" title="Semana siguiente">${ICONS.next}</button>
              </div>
              <div id="cal-week-days" class="week"></div>
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
            <label class="switch"><input id="skip-zero" type="checkbox" /> Saltar los días con 0 horas</label>
          </section>
          <section class="card">
            <h2 class="step"><span class="num">3</span> Descripción</h2>
            <label class="field">
              <span class="field-label">Actividades desarrolladas <span id="desc-count" class="count">0/2000</span></span>
              <textarea id="descripcion" rows="3" maxlength="2000" autocomplete="off" placeholder="Qué has hecho. Las etiquetas de abajo cambian cada día."></textarea>
            </label>
            <div class="tokens" id="tokens">
              Insertar
              <button type="button" class="token" data-token="{fecha}">{fecha}</button>
              <button type="button" class="token" data-token="{dia}">{dia}</button>
              <button type="button" class="token" data-token="{horas}">{horas}</button>
            </div>
            <details id="extra-text" class="sub-details">
              <summary>Observaciones y dificultades <span class="opt">opcional</span></summary>
              <label class="field">
                <span class="field-label">Observaciones <span id="obs-count" class="count">0/2000</span></span>
                <textarea id="observaciones" rows="2" maxlength="2000" autocomplete="off" placeholder="Opcional"></textarea>
              </label>
              <label class="field">
                <span class="field-label">Dificultades <span id="dif-count" class="count">0/2000</span></span>
                <textarea id="dificultades" rows="2" maxlength="2000" autocomplete="off" placeholder="Opcional"></textarea>
              </label>
            </details>
          </section>
        </div>
        </div>
        <footer class="actions">
          <p id="run-banner" class="banner" role="status" aria-live="polite" hidden></p>
          <div id="progress-wrap" class="progress-card" hidden>
            <div class="progress-head">
              <span id="progress-label" aria-live="polite">Guardando</span>
              <span id="progress-count" class="progress-count">0 / 0</span>
            </div>
            <div class="progress"><div id="progress-bar"></div></div>
          </div>
          <div id="summary-box" class="summary-box">
            <div id="stats" class="stats">
              <span class="stats-main"><strong id="stat-days">0</strong> <span id="stat-days-label">días</span> · <strong id="stat-hours">0</strong> h</span>
              <span id="stat-range" class="stats-range"></span>
            </div>
            <p id="summary-empty" class="summary-empty" hidden></p>
            <p id="plan-hint" class="hint error"></p>
          </div>
          <div id="run-actions" hidden>
            <button id="resume" type="button" class="primary">Continuar</button>
            <button id="skip" type="button" class="secondary">Saltar este día</button>
            <button id="stop" type="button" class="secondary">Parar</button>
            <button id="edit" type="button" class="text-button">Editar el plan</button>
          </div>
          <div id="idle-actions">
            <button id="fill" type="button" class="primary"><span id="fill-label">Rellenar</span>${ICONS.arrow}</button>
          </div>
          <p class="fine">Deja esta página abierta hasta que termine.</p>
        </footer>
      </div>
    `;
  }

  async function applyCss() {
    const fallback =
      ":host{all:initial;position:fixed;top:12px;right:12px;z-index:2147483646;width:392px;display:block;font:13px/1.45 Segoe UI,system-ui,sans-serif;color:#202734;background:#fff} :host(.is-hidden){display:none !important} [hidden]{display:none !important}";
    const style = document.createElement("style");
    // Oculto hasta tener el CSS: así las transiciones no arrancan desde el estilo del navegador.
    style.textContent = `${fallback} .sheet{display:none}`;
    shadow.appendChild(style);
    try {
      if (chrome.runtime?.getURL) {
        const response = await fetch(chrome.runtime.getURL("panel/panel.css"));
        const css = response.ok ? await response.text() : "";
        if (css.includes(":host")) {
          style.textContent = css;
          return;
        }
      }
    } catch (error) {
      // Si el CSS no carga, el panel sigue en la página con el estilo mínimo.
    }
    style.textContent = fallback;
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
      stats: $("stats"),
      statDays: $("stat-days"),
      statDaysLabel: $("stat-days-label"),
      statHours: $("stat-hours"),
      statRange: $("stat-range"),
      summaryEmpty: $("summary-empty"),
      hint: $("plan-hint"),
      runBanner: $("run-banner"),
      progressWrap: $("progress-wrap"),
      progressBar: $("progress-bar"),
      fill: $("fill"),
      fillLabel: $("fill-label"),
      resume: $("resume"),
      skip: $("skip"),
      stop: $("stop"),
      edit: $("edit"),
      idleActions: $("idle-actions"),
      runActions: $("run-actions"),
      chip: $("status-chip"),
      minimize: $("minimize"),
      presets: $("presets"),
      tokens: $("tokens"),
      extraText: $("extra-text"),
      weekTotal: $("week-total"),
      summaryBox: $("summary-box"),
      progressLabel: $("progress-label"),
      progressCount: $("progress-count"),
      calFile: $("cal-file"),
      calPick: $("cal-pick"),
      calPickLabel: $("cal-pick-label"),
      calLoaded: $("cal-loaded"),
      calRange: $("cal-range"),
      calTypes: $("cal-types"),
      calOff: $("cal-off"),
      calError: $("cal-error"),
      calWeek: $("cal-week"),
      calWeekLabel: $("cal-week-label"),
      calWeekDays: $("cal-week-days"),
      week: $("week"),
    };
  }

  async function boot() {
    const saved = await storageGet("settings");
    const settings = { ...Plan.defaultSettings(), ...(saved || {}) };
    if (!settings.start) settings.start = Plan.todayISO();
    if (!settings.end) settings.end = Plan.todayISO();
    writeSettings(settings);
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
