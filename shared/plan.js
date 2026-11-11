(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.CuadernoPlan = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY_NAMES_ES = [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
  ];
  const DAY_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const MAX_SPAN_DAYS = 400;
  const MAX_TEXT = 2000;

  function parseISO(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return date;
  }

  function toISO(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function formatES(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${day}/${month}/${date.getFullYear()}`;
  }

  function todayISO(now) {
    return toISO(now instanceof Date ? now : new Date());
  }

  function parseHours(value) {
    const number = Number(String(value ?? "").trim().replace(",", "."));
    return number;
  }

  function formatHours(value, commaDecimals) {
    const number = parseHours(value);
    if (!Number.isFinite(number)) return "";
    const rounded = Math.round(number * 100) / 100;
    const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
    if (!Number.isInteger(rounded) && commaDecimals !== false) {
      return text.replace(".", ",");
    }
    return text;
  }

  function applyTemplate(str, entry) {
    return String(str ?? "")
      .split("{fecha}")
      .join(entry.fecha)
      .split("{dia}")
      .join(entry.dia)
      .split("{horas}")
      .join(entry.horas);
  }

  function clamp(str, max) {
    const text = String(str ?? "");
    return text.length > max ? text.slice(0, max) : text;
  }

  function defaultSettings(now) {
    const today = todayISO(now);
    return {
      start: today,
      end: today,
      hoursByWeekday: ["0", "8", "8", "8", "8", "8", "0"],
      skipZero: true,
      commaDecimals: true,
      descripcion: "",
      observaciones: "",
      dificultades: "",
      hourOverrides: {},
      textOverrides: {},
      pauseMs: 1200,
    };
  }

  function buildPlan(settings) {
    const start = parseISO(settings.start);
    const end = parseISO(settings.end);
    const errors = [];
    if (!start || !end) errors.push("Elige una fecha de inicio y una fecha de fin.");
    if (start && end && start > end) errors.push("La fecha de inicio es posterior a la de fin.");

    const span = start && end ? Math.round((end - start) / 86400000) + 1 : 0;
    if (span > MAX_SPAN_DAYS) {
      errors.push(`El intervalo no puede pasar de ${MAX_SPAN_DAYS} días.`);
    }
    if (errors.length) {
      return { entries: [], errors, span, submittable: [] };
    }

    const hoursByWeekday = settings.hoursByWeekday || [];
    const hourOverrides = settings.hourOverrides || {};
    const textOverrides = settings.textOverrides || {};
    const entries = [];

    for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const iso = toISO(cursor);
      const dow = cursor.getDay();
      const weekdayHours = hoursByWeekday[dow] ?? "0";
      const raw = Object.prototype.hasOwnProperty.call(hourOverrides, iso)
        ? hourOverrides[iso]
        : weekdayHours;
      const hoursNum = parseHours(raw);
      const horas = formatHours(raw, settings.commaDecimals);
      const skipped = settings.skipZero !== false && !(hoursNum > 0);
      const base = {
        iso,
        fecha: formatES(cursor),
        dia: DAY_NAMES_ES[dow],
        diaCorto: DAY_SHORT[dow],
        dow,
        horas,
        hoursNum,
        skipped,
      };
      const customText = String(textOverrides[iso] || "").trim();
      entries.push({
        ...base,
        descripcion: clamp(applyTemplate(customText || settings.descripcion || "", base), MAX_TEXT),
        observaciones: clamp(applyTemplate(settings.observaciones || "", base), MAX_TEXT),
        dificultades: clamp(applyTemplate(settings.dificultades || "", base), MAX_TEXT),
        customText: Boolean(customText),
        status: "pending",
      });
    }

    const submittable = entries.filter((entry) => !entry.skipped);
    for (const entry of submittable) {
      if (!Number.isFinite(entry.hoursNum) || entry.hoursNum < 0 || entry.hoursNum > 24) {
        errors.push(`${entry.fecha} tiene que tener entre 0 y 24 horas.`);
        break;
      }
      if (!entry.descripcion.trim()) {
        errors.push("La descripción es obligatoria. Se envía en cada día que guardes.");
        break;
      }
    }

    return { entries, errors, span, submittable };
  }

  function parseHoursPaste(text) {
    const overrides = {};
    const ignored = [];
    const lines = String(text || "").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(
        /^(\d{4})-(\d{2})-(\d{2})\s+(\d+(?:[.,]\d+)?)|^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\s+(\d+(?:[.,]\d+)?)/
      );
      if (!match) {
        ignored.push(trimmed);
        continue;
      }
      const iso = match[1]
        ? `${match[1]}-${match[2]}-${match[3]}`
        : `${match[7]}-${match[6].padStart(2, "0")}-${match[5].padStart(2, "0")}`;
      const hours = match[1] ? match[4] : match[8];
      if (!parseISO(iso)) {
        ignored.push(trimmed);
        continue;
      }
      overrides[iso] = hours;
    }
    return { overrides, ignored };
  }

  function summarize(plan) {
    const days = plan.submittable.length;
    const hours = plan.submittable.reduce((total, entry) => total + entry.hoursNum, 0);
    const rounded = Math.round(hours * 100) / 100;
    const skipped = plan.entries.filter((entry) => entry.skipped).length;
    return {
      days,
      hours: rounded,
      skipped,
      first: plan.submittable[0]?.fecha || "",
      last: plan.submittable[plan.submittable.length - 1]?.fecha || "",
    };
  }

  return {
    DAY_NAMES_ES,
    DAY_SHORT,
    MAX_SPAN_DAYS,
    MAX_TEXT,
    parseISO,
    toISO,
    formatES,
    todayISO,
    parseHours,
    formatHours,
    applyTemplate,
    defaultSettings,
    buildPlan,
    parseHoursPaste,
    summarize,
  };
});
