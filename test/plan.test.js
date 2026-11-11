const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPlan, defaultSettings, parseHoursPaste, formatHours } = require("../shared/plan.js");

test("builds weekdays from Monday through Sunday and skips zeros", () => {
  const plan = buildPlan({
    ...defaultSettings(new Date(2026, 10, 11)),
    start: "2026-11-09",
    end: "2026-11-15",
    descripcion: "Trabajo del {dia} ({fecha}), {horas} h.",
    observaciones: "Sin observaciones",
    dificultades: "",
    hourOverrides: { "2026-11-13": "4" },
    textOverrides: { "2026-11-10": "Inventario del {fecha}" },
  });

  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.submittable.map((entry) => `${entry.fecha} ${entry.horas} ${entry.dia}`),
    [
      "09/11/2026 8 lunes",
      "10/11/2026 8 martes",
      "11/11/2026 8 miércoles",
      "12/11/2026 8 jueves",
      "13/11/2026 4 viernes",
    ]
  );
  assert.equal(plan.submittable[0].descripcion, "Trabajo del lunes (09/11/2026), 8 h.");
  assert.equal(plan.submittable[1].descripcion, "Inventario del 10/11/2026");
  assert.equal(plan.submittable[0].observaciones, "Sin observaciones");
  assert.equal(plan.entries.filter((entry) => entry.skipped).length, 2);
});

test("sends decimal hours with a comma", () => {
  assert.equal(formatHours("7.5", true), "7,5");
  assert.equal(formatHours("8", true), "8");
  assert.equal(formatHours("7,5", false), "7.5");
});

test("requires a description and rejects an inverted range", () => {
  const empty = buildPlan({
    ...defaultSettings(new Date(2026, 10, 11)),
    start: "2026-11-11",
    end: "2026-11-11",
    descripcion: "   ",
  });
  assert.equal(empty.submittable.length, 1);
  assert.match(empty.errors[0], /descripción/i);

  const inverted = buildPlan({
    ...defaultSettings(new Date(2026, 10, 11)),
    start: "2026-11-12",
    end: "2026-11-11",
    descripcion: "Algo",
  });
  assert.equal(inverted.entries.length, 0);
  assert.match(inverted.errors[0], /posterior/i);
});

test("uses calendar hours by day type and always skips festivos and vacaciones", () => {
  const plan = buildPlan({
    ...defaultSettings(new Date(2026, 9, 1)),
    start: "2026-10-12",
    end: "2026-10-16",
    descripcion: "Trabajo",
    skipZero: false,
    hourOverrides: { "2026-10-14": "2" },
    calendar: {
      days: {
        "2026-10-12": "festivo",
        "2026-10-13": "vacaciones",
        "2026-10-14": "vacaciones",
        "2026-10-15": "t2",
        "2026-10-16": "t4",
      },
      hours: { t1: "4", t2: "8", t3: "7", t4: "3" },
    },
  });

  assert.deepEqual(
    plan.submittable.map((entry) => `${entry.fecha} ${entry.horas}`),
    ["14/10/2026 2", "15/10/2026 8", "16/10/2026 3"]
  );
  assert.deepEqual(
    plan.entries.filter((entry) => entry.skipped).map((entry) => entry.calKind),
    ["festivo", "vacaciones"]
  );
});

test("parses pasted dates and hours", () => {
  const parsed = parseHoursPaste(`
    10/11/2026 8
    2026-11-11 6,5
    12-11-2026 4
    not a date
  `);
  assert.deepEqual(parsed.overrides, {
    "2026-11-10": "8",
    "2026-11-11": "6,5",
    "2026-11-12": "4",
  });
  assert.deepEqual(parsed.ignored, ["not a date"]);
});
