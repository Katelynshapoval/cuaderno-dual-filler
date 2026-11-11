const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { readCalendar } = require("../shared/calendar.js");

const CELL_W = 30;
const CELL_H = 16;
const COLORS = {
  t1: [255, 192, 0],
  t2: [0, 111, 192],
  t3: [146, 208, 80],
  t4: [255, 255, 0],
  festivo: [255, 0, 0],
  vacaciones: [112, 48, 160],
};

// Dibuja una cuadrícula como la de la plantilla: 4 x 4 meses, título, cabecera y 6 semanas.
function drawCalendar(startYear, startMonth, marks) {
  const blockW = CELL_W * 7;
  const gap = 20;
  const width = 20 + 4 * (blockW + gap);
  const bandH = CELL_H * 8;
  const height = 120 + 4 * (bandH + CELL_H);
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 3;
        rgb[i] = r;
        rgb[i + 1] = g;
        rgb[i + 2] = b;
      }
    }
  };

  for (let index = 0; index < 16; index += 1) {
    const x = 20 + (index % 4) * (blockW + gap);
    const y = 120 + Math.floor(index / 4) * (bandH + CELL_H);
    const first = new Date(startYear, startMonth + index, 1, 12);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    fill(x, y, x + blockW, y + CELL_H * 2, [225, 225, 225]);
    for (let day = 1; day <= days; day += 1) {
      const cell = offset + day - 1;
      const cx = x + (cell % 7) * CELL_W;
      const cy = y + CELL_H * 2 + Math.floor(cell / 7) * CELL_H;
      const iso = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (marks[iso]) fill(cx, cy, cx + CELL_W, cy + CELL_H, COLORS[marks[iso]]);
      fill(cx + 12, cy + 5, cx + 17, cy + 11, [0, 0, 0]);
    }
    const lines = [0, CELL_H, CELL_H * 2, ...[1, 2, 3, 4, 5, 6].map((row) => CELL_H * (2 + row))];
    for (const ly of lines) fill(x, y + ly, x + blockW + 1, y + ly + 1, [0, 0, 0]);
    for (let col = 0; col <= 7; col += 1) {
      const top = col === 0 || col === 7 ? 0 : CELL_H;
      fill(x + col * CELL_W, y + top, x + col * CELL_W + 1, y + bandH + 1, [0, 0, 0]);
    }
  }
  fill(0, 60, width, 61, [0, 0, 0]);
  return { width, height, rgb };
}

function toPdf({ width, height, rgb }) {
  const data = zlib.deflateSync(rgb);
  const head = Buffer.from(
    `%PDF-1.7\n1 0 obj\n<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}` +
      `/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode/Length ${data.length}>>\nstream\r\n`,
    "latin1"
  );
  return Buffer.concat([head, data, Buffer.from("\r\nendstream\nendobj\n%%EOF\n", "latin1")]);
}

function asFile(buffer) {
  return { arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) };
}

test("reads day types, festivos and vacaciones from a calendar PDF", async () => {
  const marks = {
    "2026-09-10": "t4",
    "2026-09-11": "t3",
    "2026-10-12": "festivo",
    "2026-10-13": "vacaciones",
    "2026-12-17": "t2",
    "2027-03-15": "t1",
    "2027-06-18": "t3",
  };
  const pdf = toPdf(drawCalendar(2026, 5, marks));
  const calendar = await readCalendar(asFile(pdf), new Date(2026, 10, 11));

  assert.equal(calendar.start, "2026-06-01");
  assert.equal(calendar.end, "2027-09-30");
  assert.equal(calendar.firstWork, "2026-09-10");
  assert.equal(calendar.lastWork, "2027-06-18");
  for (const [iso, kind] of Object.entries(marks)) assert.equal(calendar.days[iso], kind, iso);
  assert.equal(calendar.days["2026-10-14"], "none");
  assert.deepEqual(calendar.counts, { t1: 1, t2: 1, t3: 2, t4: 1, festivo: 1, vacaciones: 1 });
});

test("rejects a PDF without a calendar image", async () => {
  await assert.rejects(readCalendar(asFile(Buffer.from("%PDF-1.7\n%%EOF\n")), new Date()), /calendario/);
});
