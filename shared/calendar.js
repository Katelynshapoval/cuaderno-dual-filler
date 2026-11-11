(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.CuadernoCalendar = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const WORK_KINDS = ["t1", "t2", "t3", "t4"];
  const OFF_KINDS = ["festivo", "vacaciones"];
  const DEFAULT_HOURS = { t1: "4", t2: "8", t3: "7", t4: "3" };
  const SWATCH = {
    t1: "#ffc000",
    t2: "#0070c0",
    t3: "#92d050",
    t4: "#ffff00",
    festivo: "#ff0000",
    vacaciones: "#7030a0",
  };
  // Colores de la plantilla "Calendario FP-DUAL" del Gobierno de Aragón.
  const PALETTE = [
    ["t1", [255, 192, 0]],
    ["t2", [0, 111, 192]],
    ["t3", [146, 208, 80]],
    ["t4", [255, 255, 0]],
    ["festivo", [255, 0, 0]],
    ["vacaciones", [112, 48, 160]],
    ["none", [255, 255, 255]],
    ["none", [225, 225, 225]],
    ["none", [192, 192, 192]],
    ["none", [255, 255, 153]],
  ];
  const DARK = 110;
  const WEEK_ROWS = 6;
  const LINES_PER_BAND = WEEK_ROWS + 3;
  const LINES_PER_BLOCK = 8;
  const NOT_FOUND = "No encuentro la cuadrícula del calendario. Sube el PDF original del calendario FP Dual.";

  function toISO(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function binaryString(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return out;
  }

  function dictEnd(str, start) {
    let depth = 0;
    for (let i = start; i < str.length - 1; i += 1) {
      if (str[i] === "<" && str[i + 1] === "<") {
        depth += 1;
        i += 1;
      } else if (str[i] === ">" && str[i + 1] === ">") {
        depth -= 1;
        i += 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  function dictNumber(dict, key) {
    const match = new RegExp(`/${key}\\s+(\\d+)(?!\\s+\\d+\\s+R)`).exec(dict);
    return match ? Number(match[1]) : null;
  }

  function streamLength(str, dict) {
    const direct = dictNumber(dict, "Length");
    if (direct != null) return direct;
    const ref = /\/Length\s+(\d+)\s+(\d+)\s+R/.exec(dict);
    if (!ref) return null;
    const target = new RegExp(`(?:^|[\\s>])${ref[1]}\\s+${ref[2]}\\s+obj\\s*(\\d+)`).exec(str);
    return target ? Number(target[1]) : null;
  }

  function findPdfImages(bytes) {
    const str = binaryString(bytes);
    const images = [];
    const re = /\/Subtype\s*\/Image/g;
    let match;
    while ((match = re.exec(str))) {
      const objAt = str.lastIndexOf("obj", match.index);
      const open = str.indexOf("<<", objAt);
      if (objAt < 0 || open < 0 || open > match.index) continue;
      const close = dictEnd(str, open);
      if (close < 0) continue;
      const dict = str.slice(open, close);
      const after = /^\s*stream\r?\n/.exec(str.slice(close, close + 32));
      if (!after) continue;
      const begin = close + after[0].length;
      let length = streamLength(str, dict);
      if (length == null) {
        const end = str.indexOf("endstream", begin);
        if (end < 0) continue;
        length = end - begin;
        while (length > 0 && (bytes[begin + length - 1] === 0x0a || bytes[begin + length - 1] === 0x0d)) length -= 1;
      }
      const filter = /\/Filter\s*\[?\s*\/(\w+)/.exec(dict);
      images.push({
        width: dictNumber(dict, "Width"),
        height: dictNumber(dict, "Height"),
        bpc: dictNumber(dict, "BitsPerComponent") || 8,
        filter: filter ? filter[1] : "",
        predictor: dictNumber(dict, "Predictor") || 1,
        data: bytes.subarray(begin, begin + length),
      });
    }
    return images.filter((img) => img.width > 0 && img.height > 0);
  }

  async function inflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function unpredict(raw, width, height, channels) {
    const stride = width * channels;
    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y += 1) {
      const type = raw[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const row = y * stride;
      for (let x = 0; x < stride; x += 1) {
        const a = x >= channels ? out[row + x - channels] : 0;
        const b = y > 0 ? out[row - stride + x] : 0;
        const c = y > 0 && x >= channels ? out[row - stride + x - channels] : 0;
        let value = raw[src + x];
        if (type === 1) value += a;
        else if (type === 2) value += b;
        else if (type === 3) value += (a + b) >> 1;
        else if (type === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        out[row + x] = value & 0xff;
      }
    }
    return out;
  }

  async function bitmapPixels(source) {
    const bitmap = await createImageBitmap(source);
    const { width, height } = bitmap;
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return { width, height, channels: 4, data: ctx.getImageData(0, 0, width, height).data };
  }

  async function decodePdfImage(img) {
    if (img.filter === "DCTDecode") {
      return bitmapPixels(new Blob([img.data], { type: "image/jpeg" }));
    }
    if (img.filter !== "FlateDecode" || img.bpc !== 8) return null;
    const raw = await inflate(img.data);
    const pixels = img.width * img.height;
    if (img.predictor >= 10) {
      const channels = Math.round((raw.length / img.height - 1) / img.width);
      if (channels !== 3 && channels !== 4) return null;
      return { width: img.width, height: img.height, channels, data: unpredict(raw, img.width, img.height, channels) };
    }
    const channels = raw.length / pixels;
    if (channels !== 3 && channels !== 4) return null;
    return { width: img.width, height: img.height, channels, data: raw };
  }

  function mergeLines(values) {
    const out = [];
    let group = [];
    for (const value of values) {
      if (group.length && value - group[group.length - 1] > 2) {
        out.push(Math.round((group[0] + group[group.length - 1]) / 2));
        group = [];
      }
      group.push(value);
    }
    if (group.length) out.push(Math.round((group[0] + group[group.length - 1]) / 2));
    return out;
  }

  function longestEvenRun(lines) {
    if (lines.length < 2) return lines;
    const steps = lines.slice(1).map((value, i) => value - lines[i]).sort((a, b) => a - b);
    const median = steps[Math.floor(steps.length / 2)];
    let best = [];
    let run = [lines[0]];
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] - lines[i - 1] <= median * 2) run.push(lines[i]);
      else run = [lines[i]];
      if (run.length > best.length) best = run.slice();
    }
    return best;
  }

  function classify(r, g, b) {
    let best = "none";
    let bestDistance = Infinity;
    for (const [kind, [pr, pg, pb]] of PALETTE) {
      const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = kind;
      }
    }
    return best;
  }

  function readGrid(img) {
    const { width: W, height: H, channels: C, data } = img;
    const dark = (x, y) => {
      const i = (y * W + x) * C;
      return Math.max(data[i], data[i + 1], data[i + 2]) < DARK;
    };

    const rows = [];
    for (let y = 0; y < H; y += 1) {
      let count = 0;
      for (let x = 0; x < W; x += 1) if (dark(x, y)) count += 1;
      if (count > W * 0.3) rows.push(y);
    }
    const hLines = longestEvenRun(mergeLines(rows));
    if (hLines.length < LINES_PER_BAND || hLines.length % LINES_PER_BAND) throw new Error(NOT_FOUND);

    const top = hLines[0];
    const bottom = hLines[hLines.length - 1];
    const cols = [];
    for (let x = 0; x < W; x += 1) {
      let count = 0;
      for (let y = top; y <= bottom; y += 1) if (dark(x, y)) count += 1;
      if (count > (bottom - top) * 0.5) cols.push(x);
    }
    const vLines = mergeLines(cols);
    if (vLines.length < LINES_PER_BLOCK || vLines.length % LINES_PER_BLOCK) throw new Error(NOT_FOUND);

    const bands = hLines.length / LINES_PER_BAND;
    const blocks = vLines.length / LINES_PER_BLOCK;
    const months = [];
    for (let band = 0; band < bands; band += 1) {
      for (let block = 0; block < blocks; block += 1) {
        const cells = [];
        for (let row = 0; row < WEEK_ROWS; row += 1) {
          for (let col = 0; col < 7; col += 1) {
            cells.push(
              readCell(img, dark, {
                x0: vLines[block * LINES_PER_BLOCK + col],
                x1: vLines[block * LINES_PER_BLOCK + col + 1],
                y0: hLines[band * LINES_PER_BAND + 2 + row],
                y1: hLines[band * LINES_PER_BAND + 3 + row],
              })
            );
          }
        }
        months.push(cells);
      }
    }
    return months;
  }

  function readCell(img, dark, { x0, x1, y0, y1 }) {
    const { width: W, channels: C, data } = img;
    const insetX = Math.max(2, Math.round((x1 - x0) * 0.08));
    const insetY = Math.max(2, Math.round((y1 - y0) * 0.12));
    const buckets = new Map();
    let darkCount = 0;
    let total = 0;
    for (let y = y0 + insetY; y < y1 - insetY; y += 1) {
      for (let x = x0 + insetX; x < x1 - insetX; x += 1) {
        total += 1;
        if (dark(x, y)) {
          darkCount += 1;
          continue;
        }
        const i = (y * W + x) * C;
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        const bucket = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        bucket.n += 1;
        bucket.r += data[i];
        bucket.g += data[i + 1];
        bucket.b += data[i + 2];
        buckets.set(key, bucket);
      }
    }
    let mode = null;
    for (const bucket of buckets.values()) if (!mode || bucket.n > mode.n) mode = bucket;
    const kind = mode ? classify(mode.r / mode.n, mode.g / mode.n, mode.b / mode.n) : "none";
    return { text: darkCount >= Math.max(2, total * 0.008), kind };
  }

  function monthLayout(year, month) {
    const first = new Date(year, month, 1, 12);
    return {
      year: first.getFullYear(),
      month: first.getMonth(),
      offset: (first.getDay() + 6) % 7,
      days: new Date(year, month + 1, 0, 12).getDate(),
    };
  }

  function locateMonths(months, now) {
    const total = months.length * WEEK_ROWS * 7;
    let best = null;
    for (let year = now.getFullYear() - 3; year <= now.getFullYear() + 1; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        let score = 0;
        months.forEach((cells, index) => {
          const layout = monthLayout(year, month + index);
          cells.forEach((cell, i) => {
            const expected = i >= layout.offset && i < layout.offset + layout.days;
            if (expected === cell.text) score += 1;
          });
        });
        if (!best || score > best.score) best = { year, month, score };
      }
    }
    if (!best || best.score < total * 0.95) {
      throw new Error("Encuentro la cuadrícula pero no sé a qué meses corresponde.");
    }
    return best;
  }

  function analysePixels(img, now) {
    const months = readGrid(img);
    const start = locateMonths(months, now instanceof Date ? now : new Date());
    const days = {};
    const counts = { t1: 0, t2: 0, t3: 0, t4: 0, festivo: 0, vacaciones: 0 };
    let firstWork = "";
    let lastWork = "";
    months.forEach((cells, index) => {
      const layout = monthLayout(start.year, start.month + index);
      for (let day = 1; day <= layout.days; day += 1) {
        const iso = toISO(new Date(layout.year, layout.month, day, 12));
        const kind = cells[layout.offset + day - 1].kind;
        days[iso] = kind;
        if (kind !== "none") counts[kind] += 1;
        if (WORK_KINDS.includes(kind)) {
          if (!firstWork) firstWork = iso;
          lastWork = iso;
        }
      }
    });
    const isos = Object.keys(days);
    if (!firstWork) throw new Error("El calendario no tiene días marcados con colores.");
    return { days, counts, start: isos[0], end: isos[isos.length - 1], firstWork, lastWork };
  }

  async function readCalendar(file, now) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPdf = binaryString(bytes.subarray(0, 5)) === "%PDF-";
    if (!isPdf) return analysePixels(await bitmapPixels(file), now);

    const images = findPdfImages(bytes).sort((a, b) => b.width * b.height - a.width * a.height);
    let lastError = new Error("El PDF no contiene la imagen del calendario.");
    for (const image of images) {
      try {
        const pixels = await decodePdfImage(image);
        if (pixels) return analysePixels(pixels, now);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  return {
    WORK_KINDS,
    OFF_KINDS,
    DEFAULT_HOURS,
    SWATCH,
    classify,
    analysePixels,
    readCalendar,
  };
});
