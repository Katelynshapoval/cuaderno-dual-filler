(function () {
  const frameId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let loopPromise = null;
  let loopActive = false;
  let pageUnloading = false;
  let claimMisses = 0;

  function norm(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function storageGet(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (data) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(data ? data[key] : undefined);
      });
    });
  }

  function storageSet(obj) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(obj, () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) resolve(null);
          else resolve(response || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isTextControl(el) {
    if (!el || el.disabled) return false;
    const type = (el.getAttribute("type") || (el.tagName === "INPUT" ? "text" : "")).toLowerCase();
    if (el.tagName === "TEXTAREA") return isVisible(el);
    if (el.tagName !== "INPUT") return false;
    if (!["text", "number", "tel", "search", "date"].includes(type)) return false;
    return isVisible(el);
  }

  function isVisible(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "hidden") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isAfter(a, b) {
    return Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  const LABEL_TESTS = [
    (text) => text.includes("fecha") && !text.includes("inicio") && !text.includes("fin"),
    (text) => /\bhoras\b/.test(text) && !text.includes("totales"),
    (text) => text.includes("actividades desarrolladas") || (text.includes("descripcion") && !text.includes("totales")),
    (text) => text.includes("observaciones"),
    (text) => text.includes("dificultad"),
  ];

  function isLabelText(text) {
    const normalized = norm(text);
    if (!normalized || normalized.length > 180) return false;
    return LABEL_TESTS.some((test) => test(normalized));
  }

  function scopeFor(textNode) {
    const parent = textNode.parentElement;
    if (!parent) return document.body;
    return parent.closest("tr") || parent.parentElement || parent;
  }

  function textNodes(predicate) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement && node.parentElement.closest("script, style, noscript")) continue;
      const text = norm(node.nodeValue || "");
      if (!text || text.length > 180) continue;
      if (!predicate(text)) continue;
      hits.push(node);
    }
    hits.sort((a, b) => norm(a.nodeValue).length - norm(b.nodeValue).length);
    return hits;
  }

  function nextLabelNode(textNode, scope) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let seen = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!seen) {
        if (node === textNode) seen = true;
        continue;
      }
      if (isLabelText(node.nodeValue || "")) return node;
    }
    return null;
  }

  function controlInScope(textNode, scope, accept) {
    const stopAt = nextLabelNode(textNode, scope);
    for (const el of scope.querySelectorAll("input, textarea")) {
      if (!accept(el)) continue;
      if (!isAfter(textNode, el)) continue;
      if (stopAt && !isAfter(el, stopAt)) continue;
      return el;
    }
    return null;
  }

  // Sube unos niveles por si la etiqueta y el campo están en cajas hermanas (div > label + div > input).
  function controlAfterTextNode(textNode, accept) {
    let scope = scopeFor(textNode);
    for (let level = 0; level < 4 && scope && scope !== document.body; level += 1) {
      if (scope.contains(textNode)) {
        const el = controlInScope(textNode, scope, accept);
        if (el) return el;
      }
      scope = scope.parentElement;
    }
    return null;
  }

  function controlForLabel(predicate, accept) {
    for (const label of document.querySelectorAll("label")) {
      const text = norm(label.textContent);
      if (!text || text.length > 180 || !predicate(text)) continue;
      const el = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector("input, textarea");
      if (el && accept(el)) return el;
    }
    return null;
  }

  function controlByAttributes(attrTest, accept) {
    for (const el of document.querySelectorAll("input, textarea")) {
      if (!accept(el)) continue;
      const attrs = norm(
        [el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("title")].join(" ")
      );
      if (attrs && attrTest(attrs)) return el;
    }
    return null;
  }

  function findField(predicate, options, used) {
    const wantsTextarea = Boolean(options && options.textarea);
    const accept = (el) => isTextControl(el) && !used.has(el);
    const acceptKind = (el) => accept(el) && (!wantsTextarea || el.tagName === "TEXTAREA");
    let fallback = null;
    for (const node of textNodes(predicate)) {
      const el = controlAfterTextNode(node, accept);
      if (!el) continue;
      if (wantsTextarea && el.tagName !== "TEXTAREA") {
        fallback = fallback || el;
        continue;
      }
      return el;
    }
    return (
      controlForLabel(predicate, acceptKind) ||
      (options && options.attrs ? controlByAttributes(options.attrs, acceptKind) : null) ||
      fallback
    );
  }

  function findNueva(afterEl) {
    const candidates = [...document.querySelectorAll("a, button, input")].filter((el) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT" && !["submit", "button", "image"].includes(type)) return false;
      const text = norm(el.innerText || el.value || el.getAttribute("alt") || el.getAttribute("title") || "");
      if (text !== "nueva" && text !== "nuevo") return false;
      return isVisible(el);
    });
    if (afterEl) {
      const later = candidates.find((el) => isAfter(afterEl, el));
      if (later) return later;
    }
    return candidates[candidates.length - 1] || candidates[0] || null;
  }

  function controlSummary(el) {
    if (!el) return "missing";
    const name = el.getAttribute("name") || el.id || el.tagName.toLowerCase();
    return name;
  }

  // Formulario real de aplicaciones.aragon.es/fct (desarrollo.*.do): ids fijos y botón que llama a nuevo().
  function detectPortalFields() {
    const byId = (id) => {
      const el = document.getElementById(id);
      return el && isTextControl(el) ? el : null;
    };
    const fecha = byId("FECHA");
    const horas = byId("HORAS");
    const descripcion = document.getElementById("descripcion");
    if (!fecha || !horas || !descripcion || descripcion.tagName !== "TEXTAREA" || !isVisible(descripcion)) return null;
    const nueva =
      [...document.querySelectorAll("button, input[type='button'], input[type='submit'], a")].find(
        (el) => /\bnuevo\s*\(/.test(el.getAttribute("onclick") || el.getAttribute("href") || "") && isVisible(el)
      ) || findNueva(descripcion);
    if (!nueva) return null;
    return {
      fecha,
      horas,
      descripcion,
      observaciones: byId("OBSERVACIONES"),
      dificultades: byId("DIFICULTADES"),
      nueva,
    };
  }

  function detectFields() {
    const portal = detectPortalFields();
    if (portal) {
      return {
        ok: true,
        error: "",
        fields: portal,
        summary:
          "Formulario encontrado: Fecha, Horas, Descripción" +
          (portal.observaciones ? ", Observaciones" : "") +
          (portal.dificultades ? ", Dificultades" : "") +
          " y el botón Nueva.",
      };
    }
    const used = new Set();
    const take = (el) => {
      if (el) used.add(el);
      return el;
    };
    const fecha = take(
      findField(
        (text) => text.includes("fecha") && !text.includes("inicio") && !text.includes("fin"),
        { attrs: (attrs) => attrs.includes("fecha") && !/inicio|fin|desde|hasta|oculta/.test(attrs) },
        used
      )
    );
    const horas = take(
      findField(
        (text) => /\bhoras?\b/.test(text) && !text.includes("totales"),
        { attrs: (attrs) => /hora/.test(attrs) && !/total/.test(attrs) },
        used
      )
    );
    const descripcion = take(
      findField(
        (text) => text.includes("actividades desarrolladas") || text.includes("descripcion"),
        { textarea: true, attrs: (attrs) => /descrip|actividad/.test(attrs) },
        used
      )
    );
    const observaciones = take(
      findField((text) => text.includes("observaciones"), { textarea: true, attrs: (attrs) => attrs.includes("observ") }, used)
    );
    const dificultades = take(
      findField((text) => text.includes("dificultad"), { textarea: true, attrs: (attrs) => attrs.includes("dificult") }, used)
    );
    const nueva = findNueva(dificultades || descripcion || horas || fecha);
    const missing = [];
    if (!fecha) missing.push("Fecha");
    if (!horas) missing.push("Horas");
    if (!descripcion) missing.push("Descripción");
    if (!nueva) missing.push("Nueva");
    const fields = { fecha, horas, descripcion, observaciones, dificultades, nueva };
    if (missing.length) {
      const framed = window === window.top && document.querySelector("iframe, frame");
      let hint = " Abre tu cuaderno y pulsa el icono de Desarrollo, en la página con Fecha, Horas y Nueva.";
      if (framed) hint = " El formulario puede estar dentro de un marco de la página: recarga la página y vuelve a intentarlo.";
      return {
        ok: false,
        error: "No encuentro el formulario de Desarrollo (falta " + missing.join(", ") + ")." + hint,
        fields,
        summary: "",
      };
    }
    const summary =
      "Formulario encontrado. Fecha (" +
      controlSummary(fecha) +
      "), Horas (" +
      controlSummary(horas) +
      "), Descripción (" +
      controlSummary(descripcion) +
      ")" +
      (observaciones ? ", Observaciones" : "") +
      (dificultades ? ", Dificultades" : "") +
      ", Nueva.";
    return { ok: true, error: "", fields, summary };
  }

  function datesMatch(actual, expected) {
    const normalizeDate = (value) => {
      const text = String(value || "").trim();
      const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
      const match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
      if (!match) return text;
      return `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${match[3]}`;
    };
    return normalizeDate(actual) === normalizeDate(expected);
  }

  function hoursMatch(actual, expected) {
    const left = String(actual || "").trim().replace(",", ".");
    const right = String(expected || "").trim().replace(",", ".");
    return left === right;
  }

  function setControlValue(el, value) {
    let text = String(value ?? "");
    const es = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (es && (el.getAttribute("type") || "").toLowerCase() === "date") text = `${es[3]}-${es[2]}-${es[1]}`;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (el.readOnly) el.readOnly = false;
    if (descriptor && descriptor.set) descriptor.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("keyup", { bubbles: true }));
    if (el.value !== text) el.value = text;
  }

  function datePattern(fecha) {
    const escaped = fecha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dashed = escaped.replaceAll("/", "[\\/\\-.]");
    return new RegExp(`(^|\\D)${dashed}(\\D|$)`);
  }

  function dateAlreadyListed(fecha, fields) {
    const pattern = datePattern(fecha);
    const formRow = fields.fecha ? fields.fecha.closest("tr") : null;
    const own = new Set(
      [fields.fecha, fields.horas, fields.descripcion, fields.observaciones, fields.dificultades].filter(Boolean)
    );
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!pattern.test(node.nodeValue || "")) continue;
      const el = node.parentElement;
      if (!el || el.closest("script, style, noscript, textarea, input")) continue;
      if (formRow && formRow.contains(el)) continue;
      const row = el.closest("tr");
      if (formRow && row && !isAfter(row, formRow)) continue;
      return true;
    }
    for (const el of document.querySelectorAll("input, textarea")) {
      if (own.has(el) || (!el.readOnly && !el.disabled)) continue;
      if (!pattern.test(el.value || "")) continue;
      if (formRow && formRow.contains(el)) continue;
      return true;
    }
    return false;
  }

  function isBenignAlert(message) {
    const text = norm(message);
    return /(guardad|correctament|se ha (anadido|creado|insertado)|exito|operacion realizada)/.test(text);
  }

  function formCleared(fields, entry) {
    const fecha = String(fields.fecha.value || "").trim();
    return !fecha && !datesMatch(fields.fecha.value, entry.fecha);
  }

  function installDialogHooks() {
    if (window.__cuadernoHooked) return;
    window.__cuadernoHooked = true;
    window.__cuadernoOriginalAlert = window.alert;
    window.__cuadernoOriginalConfirm = window.confirm;
    window.__cuadernoLastAlert = "";
    window.alert = function (message) {
      window.__cuadernoLastAlert = String(message ?? "");
    };
    window.confirm = function (message) {
      window.__cuadernoLastConfirm = String(message ?? "");
      return true;
    };
  }

  function removeDialogHooks() {
    if (!window.__cuadernoHooked) return;
    window.alert = window.__cuadernoOriginalAlert;
    window.confirm = window.__cuadernoOriginalConfirm;
    window.__cuadernoHooked = false;
  }

  async function patchError(message) {
    if (pageUnloading) return;
    const run = await storageGet("run");
    if (!run || run.status !== "running") return;
    await storageSet({
      run: {
        ...run,
        status: "error",
        phase: "idle",
        owner: null,
        error: message,
        updatedAt: Date.now(),
      },
    });
  }

  async function markDoneAndAdvance(expectedIndex) {
    const run = await storageGet("run");
    if (!run || run.index !== expectedIndex) return false;
    if (run.status !== "running" && run.status !== "paused") return false;
    const entries = run.entries.map((entry, index) =>
      index === expectedIndex ? { ...entry, status: "done" } : entry
    );
    const finished = expectedIndex + 1 >= entries.length;
    await storageSet({
      run: {
        ...run,
        entries,
        index: expectedIndex + 1,
        status: finished ? "done" : run.status,
        phase: "idle",
        owner: null,
        ownerIndex: null,
        submittingFecha: null,
        error: null,
        updatedAt: Date.now(),
      },
    });
    return true;
  }

  async function claimDay(index) {
    const response = await sendMessage({ type: "CLAIM", index, frame: frameId });
    if (response == null) return true;
    return Boolean(response.ok);
  }

  async function waitForOutcome(entry, fields, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (pageUnloading) return "unloaded";
      if (dateAlreadyListed(entry.fecha, fields)) return "saved";
      const alertText = window.__cuadernoLastAlert || "";
      if (alertText && isBenignAlert(alertText) && formCleared(fields, entry)) return "saved";
      if (alertText && !isBenignAlert(alertText)) return "alert";
      await sleep(200);
    }
    if (pageUnloading) return "unloaded";
    if (dateAlreadyListed(entry.fecha, fields)) return "saved";
    return "timeout";
  }

  function portalErrorText() {
    const box = document.getElementById("error_container");
    if (!box || window.getComputedStyle(box).display === "none") return "";
    return [...box.querySelectorAll("li")]
      .filter((li) => !li.classList.contains("elementoOculto"))
      .map((li) => li.textContent.trim())
      .filter(Boolean)
      .join(" ");
  }

  // Nueva envía el formulario y recarga la página. El listado está paginado, así que
  // que el día no aparezca no significa que no se haya guardado: se decide por el formulario.
  async function afterSubmit(index, entry, fields) {
    if (!dateAlreadyListed(entry.fecha, fields)) {
      const errorText = portalErrorText();
      if (errorText) {
        await patchError(`${entry.fecha}: ${errorText}`);
        return false;
      }
      if (fields.descripcion.value.trim()) {
        await patchError(
          `El portal ha vuelto con ${entry.fecha} sin confirmar que se haya guardado. Revisa el listado: si está, pulsa Saltar este día; si no, Continuar.`
        );
        return false;
      }
    }
    await markDoneAndAdvance(index);
    const after = await storageGet("run");
    if (!after || after.status !== "running") return false;
    await sleep(after.pauseMs ?? 1200);
    return true;
  }

  async function detectSoon() {
    let last = detectFields();
    for (let attempt = 0; attempt < 4 && !last.ok; attempt += 1) {
      await sleep(attempt === 0 ? 250 : 600);
      if (pageUnloading) return null;
      last = detectFields();
    }
    return last;
  }

  async function step() {
    const who = await sendMessage({ type: "WHOAMI" });
    let run = await storageGet("run");
    if (!run || run.status !== "running") return false;
    if (who && who.tabId != null && run.tabId != null && who.tabId !== run.tabId) return false;
    if (run.index >= run.entries.length) {
      await storageSet({
        run: { ...run, status: "done", phase: "idle", owner: null, updatedAt: Date.now() },
      });
      return false;
    }

    const index = run.index;
    const entry = run.entries[index];
    let detected = await detectSoon();
    if (!detected || !detected.ok) {
      if (window !== window.top) return false;
      const fresh = await storageGet("run");
      if (!fresh || fresh.status !== "running" || fresh.index !== index) return false;
      if (fresh.phase === "working" || fresh.phase === "submitting") return false;
      await patchError((detected && detected.error) || "El formulario de Desarrollo no está en esta página.");
      return false;
    }

    if (run.phase === "submitting" && run.submittingFecha === entry.fecha && run.owner !== frameId) {
      if (window !== window.top) return false;
      return afterSubmit(index, entry, detected.fields);
    }

    if (dateAlreadyListed(entry.fecha, detected.fields)) {
      await markDoneAndAdvance(index);
      claimMisses = 0;
      return true;
    }

    const claimed = await claimDay(index);
    if (!claimed) {
      claimMisses += 1;
      const fresh = await storageGet("run");
      if (!fresh || fresh.status !== "running") return false;
      if (fresh.index !== index) {
        claimMisses = 0;
        return true;
      }
      if (claimMisses >= 15 && window === window.top) {
        await patchError("Se ha perdido el día siguiente. Pulsa Continuar.");
        return false;
      }
      await sleep(400);
      return claimMisses < 15;
    }
    claimMisses = 0;
    run = await storageGet("run");
    if (!run || run.status !== "running") return false;
    if (run.index !== index) return true;
    if (run.index >= run.entries.length) return false;
    detected = detectFields();
    if (!detected.ok) {
      await patchError(detected.error);
      return false;
    }
    const current = run.entries[run.index];
    if (dateAlreadyListed(current.fecha, detected.fields)) {
      await markDoneAndAdvance(run.index);
      return true;
    }

    window.__cuadernoLastAlert = "";
    setControlValue(detected.fields.fecha, current.fecha);
    // El portal valida las horas con isNaN(): "7,5" lo rechaza, "7.5" no.
    setControlValue(detected.fields.horas, String(current.horas).replace(",", "."));
    setControlValue(detected.fields.descripcion, current.descripcion);
    if (detected.fields.observaciones) {
      setControlValue(detected.fields.observaciones, current.observaciones || "");
    }
    if (detected.fields.dificultades) {
      setControlValue(detected.fields.dificultades, current.dificultades || "");
    }
    await sleep(200);

    if (!datesMatch(detected.fields.fecha.value, current.fecha) || !hoursMatch(detected.fields.horas.value, current.horas)) {
      await patchError(
        `La página no ha conservado la fecha o las horas del ${current.fecha}. Pulsa el campo de fecha una vez y luego Continuar.`
      );
      return false;
    }
    if (current.descripcion.trim() && !detected.fields.descripcion.value.trim()) {
      await patchError("La página ha borrado la descripción antes de pulsar Nueva.");
      return false;
    }

    const latest = await storageGet("run");
    if (!latest || latest.status !== "running") return false;
    await storageSet({
      run: {
        ...latest,
        phase: "submitting",
        submittingFecha: current.fecha,
        updatedAt: Date.now(),
      },
    });
    detected.fields.nueva.click();

    const outcome = await waitForOutcome(current, detected.fields, 8000);
    if (outcome === "unloaded") return false;
    if (outcome === "saved") {
      await markDoneAndAdvance(latest.index);
      const after = await storageGet("run");
      if (!after || after.status !== "running") return false;
      await sleep(after.pauseMs ?? 1200);
      return true;
    }
    if (outcome === "alert") {
      await patchError(window.__cuadernoLastAlert || "La página ha rechazado este día.");
      return false;
    }
    await patchError(
      `Se ha pulsado Nueva, pero ${current.fecha} no aparece en el listado. Si sí se ha guardado, pulsa Saltar este día.`
    );
    return false;
  }

  async function runLoop() {
    installDialogHooks();
    try {
      await sleep(300);
      while (!pageUnloading && (await step())) {
        // Each pass saves one day or skips one that is already listed.
      }
    } catch (error) {
      await patchError(error && error.message ? error.message : "El rellenado se ha detenido.");
    } finally {
      removeDialogHooks();
    }
  }

  function kick() {
    if (loopActive) return loopPromise;
    loopActive = true;
    loopPromise = runLoop().finally(() => {
      loopActive = false;
      loopPromise = null;
    });
    return loopPromise;
  }

  const painted = [];

  function paint(el, color) {
    if (!el) return;
    el.dataset.cuadernoOutline = el.style.outline;
    el.style.outline = `2px solid ${color}`;
    el.style.outlineOffset = "2px";
    painted.push(el);
  }

  function clearPaint() {
    for (const el of painted) {
      el.style.outline = el.dataset.cuadernoOutline || "";
      delete el.dataset.cuadernoOutline;
    }
    painted.length = 0;
  }

  function inspect(highlight) {
    const detected = detectFields();
    if (highlight && detected.ok) {
      clearPaint();
      paint(detected.fields.fecha, "#a33b2b");
      paint(detected.fields.horas, "#a33b2b");
      paint(detected.fields.descripcion, "#245c45");
      paint(detected.fields.observaciones, "#245c45");
      paint(detected.fields.dificultades, "#245c45");
      paint(detected.fields.nueva, "#1d4e89");
      detected.fields.fecha.scrollIntoView({ block: "center", inline: "nearest" });
      setTimeout(clearPaint, 4000);
    }
    return { ok: detected.ok, error: detected.error, summary: detected.summary };
  }

  window.addEventListener("pagehide", () => {
    pageUnloading = true;
    sendMessage({ type: "RELEASE", frame: frameId });
  });

  globalThis.CuadernoFill = {
    detectFields,
    inspect,
    kick,
    dateAlreadyListed,
    setControlValue,
  };

  if (globalThis.__cuadernoLoaded) return;
  globalThis.__cuadernoLoaded = true;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.run) return;
    const run = changes.run.newValue;
    if (run && run.status === "running") kick();
  });

  storageGet("run")
    .then((run) => {
      if (run && run.status === "running") kick();
    })
    .catch(() => {});

  if (window === window.top && globalThis.CuadernoPanel) {
    globalThis.CuadernoPanel.install();
  }
})();
