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

  function objectDict(str, objAt) {
    const open = str.indexOf("<<", objAt);
    if (objAt < 0 || open < 0) return null;
    const close = dictEnd(str, open);
    return close < 0 ? null : { open, close, dict: str.slice(open, close) };
  }

  function objectStream(str, bytes, objAt) {
    const found = objectDict(str, objAt);
    if (!found) return null;
    const { close, dict } = found;
    const after = /^\s*stream\r?\n/.exec(str.slice(close, close + 32));
    if (!after) return null;
    const begin = close + after[0].length;
    let length = streamLength(str, dict);
    if (length == null) {
      const end = str.indexOf("endstream", begin);
      if (end < 0) return null;
      length = end - begin;
      while (length > 0 && (bytes[begin + length - 1] === 0x0a || bytes[begin + length - 1] === 0x0d)) length -= 1;
    }
    const filter = /\/Filter\s*\[?\s*\/(\w+)/.exec(dict);
    return { dict, filter: filter ? filter[1] : "", data: bytes.subarray(begin, begin + length) };
  }

  function findPdfImages(bytes) {
    const str = binaryString(bytes);
    const images = [];
    const re = /\/Subtype\s*\/Image/g;
    let match;
    while ((match = re.exec(str))) {
      const objAt = str.lastIndexOf("obj", match.index);
      const stream = objectStream(str, bytes, objAt);
      if (!stream || str.indexOf("<<", objAt) > match.index) continue;
      const { dict, filter, data } = stream;
      images.push({
        width: dictNumber(dict, "Width"),
        height: dictNumber(dict, "Height"),
        bpc: dictNumber(dict, "BitsPerComponent") || 8,
        filter,
        predictor: dictNumber(dict, "Predictor") || 1,
        data,
      });
    }
    return images.filter((img) => img.width > 0 && img.height > 0);
  }

  // Páginas dibujadas con vectores (p. ej. exportadas desde Excel): sin imagen que extraer.
  function findPdfPages(bytes) {
    const str = binaryString(bytes);
    const pages = [];
    const re = /\/Type\s*\/Page(?![\w])/g;
    let match;
    while ((match = re.exec(str))) {
      const found = objectDict(str, str.lastIndexOf("obj", match.index));
      if (!found || found.open > match.index) continue;
      const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(found.dict);
      if (!contents) continue;
      const box = /\/MediaBox\s*\[([^\]]+)\]/.exec(found.dict) || /\/MediaBox\s*\[([^\]]+)\]/.exec(str);
      const mediaBox = box ? box[1].trim().split(/\s+/).map(Number) : [0, 0, 612, 792];
      const streams = [];
      for (const ref of contents[1].matchAll(/(\d+)\s+(\d+)\s+R/g)) {
        const obj = new RegExp(`(?:^|[\\s>])${ref[1]}\\s+${ref[2]}\\s+obj`).exec(str);
        const stream = obj && objectStream(str, bytes, obj.index + obj[0].length - 3);
        if (stream) streams.push(stream);
      }
      if (streams.length) pages.push({ mediaBox, streams });
    }
    return pages;
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

  const PDF_ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

  function* pdfTokens(src) {
    const delimiter = /[\s()<>[\]{}/%]/;
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) {
        i += 1;
      } else if (ch === "%") {
        while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i += 1;
      } else if (ch === "(") {
        let depth = 1;
        let out = "";
        i += 1;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === "\\") {
            const next = src[i + 1];
            const octal = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4));
            if (octal) {
              out += String.fromCharCode(parseInt(octal[0], 8) & 0xff);
              i += 1 + octal[0].length;
              continue;
            }
            if (next !== "\n" && next !== "\r") out += PDF_ESCAPES[next] || next;
            i += 2;
            continue;
          }
          if (c === "(") depth += 1;
          if (c === ")") depth -= 1;
          if (depth > 0) out += c;
          i += 1;
        }
        yield { value: out };
      } else if (ch === "<" && src[i + 1] === "<") {
        yield { open: true };
        i += 2;
      } else if (ch === ">" && src[i + 1] === ">") {
        yield { close: true };
        i += 2;
      } else if (ch === "<") {
        const end = src.indexOf(">", i);
        const hex = src.slice(i + 1, end < 0 ? src.length : end).replace(/\s/g, "");
        // Sin leer la fuente no sabemos qué glifo es; basta con que se vea algo oscuro.
        yield { value: "0".repeat(Math.max(1, Math.round(hex.length / 4))) };
        i = end < 0 ? src.length : end + 1;
      } else if (ch === "[" || ch === "{") {
        yield { open: true };
        i += 1;
      } else if (ch === "]" || ch === "}") {
        yield { close: true };
        i += 1;
      } else {
        let end = i + 1;
        while (end < src.length && !delimiter.test(src[end])) end += 1;
        const word = src.slice(i, end);
        i = end;
        if (ch === "/") yield { value: word };
        else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) yield { value: Number(word) };
        else if (word === "ID") {
          const ei = /\sEI(?=[\s]|$)/g;
          ei.lastIndex = i;
          const found = ei.exec(src);
          i = found ? found.index + found[0].length : src.length;
        } else yield { op: word };
      }
    }
  }

  function multiply(m, n) {
    return [
      m[0] * n[0] + m[1] * n[2],
      m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2],
      m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4],
      m[4] * n[1] + m[5] * n[3] + n[5],
    ];
  }

  function pdfColor(args) {
    const v = args.map((n) => Math.max(0, Math.min(1, Number(n) || 0)));
    let rgb;
    if (v.length >= 4) rgb = v.slice(0, 3).map((c) => (1 - c) * (1 - v[3]));
    else if (v.length === 3) rgb = v;
    else rgb = [v[0] || 0, v[0] || 0, v[0] || 0];
    return `rgb(${rgb.map((c) => Math.round(c * 255)).join(",")})`;
  }

  function drawPdfContent(ctx, src) {
    const IDENTITY = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const nested = [];
    const saved = [];
    let text = { size: 1, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0 };
    let tm = IDENTITY;
    let lm = IDENTITY;
    let pendingClip = null;

    const endPath = () => {
      if (pendingClip) ctx.clip(pendingClip);
      pendingClip = null;
      ctx.beginPath();
    };
    const moveText = (tx, ty) => {
      lm = multiply([1, 0, 0, 1, tx, ty], lm);
      tm = lm;
    };
    const show = (value) => {
      if (typeof value !== "string" || !value) return;
      ctx.save();
      ctx.transform(...tm);
      ctx.translate(0, text.rise);
      ctx.scale(text.scale, -1);
      ctx.font = `${text.size}px sans-serif`;
      ctx.fillText(value, 0, 0);
      const width = ctx.measureText(value).width;
      ctx.restore();
      const spaces = value.split(" ").length - 1;
      const advance = (width + text.charSpace * value.length + text.wordSpace * spaces) * text.scale;
      tm = multiply([1, 0, 0, 1, advance, 0], tm);
    };

    for (const token of pdfTokens(src)) {
      if (token.open) {
        nested.push(stack.length);
        continue;
      }
      if (token.close) {
        const start = nested.pop();
        if (start != null) stack.push(stack.splice(start));
        continue;
      }
      if (!token.op) {
        stack.push(token.value);
        continue;
      }
      const a = stack.splice(0);
      const n = a.map(Number);
      switch (token.op) {
        case "q":
          ctx.save();
          saved.push({ ...text });
          break;
        case "Q":
          ctx.restore();
          if (saved.length) text = saved.pop();
          break;
        case "cm":
          ctx.transform(...n.slice(0, 6));
          break;
        case "w":
          ctx.lineWidth = n[0];
          break;
        case "g":
        case "rg":
        case "k":
        case "sc":
        case "scn":
          ctx.fillStyle = pdfColor(a.filter((x) => typeof x === "number"));
          break;
        case "G":
        case "RG":
        case "K":
        case "SC":
        case "SCN":
          ctx.strokeStyle = pdfColor(a.filter((x) => typeof x === "number"));
          break;
        case "m":
          ctx.moveTo(n[0], n[1]);
          break;
        case "l":
          ctx.lineTo(n[0], n[1]);
          break;
        case "c":
          ctx.bezierCurveTo(...n.slice(0, 6));
          break;
        case "v":
        case "y":
          ctx.quadraticCurveTo(n[0], n[1], n[2], n[3]);
          break;
        case "h":
          ctx.closePath();
          break;
        case "re":
          ctx.rect(n[0], n[1], n[2], n[3]);
          break;
        case "f":
        case "F":
          ctx.fill("nonzero");
          endPath();
          break;
        case "f*":
          ctx.fill("evenodd");
          endPath();
          break;
        case "B":
        case "b":
        case "B*":
        case "b*":
          ctx.fill(token.op.endsWith("*") ? "evenodd" : "nonzero");
          ctx.stroke();
          endPath();
          break;
        case "S":
        case "s":
          ctx.stroke();
          endPath();
          break;
        case "n":
          endPath();
          break;
        case "W":
          pendingClip = "nonzero";
          break;
        case "W*":
          pendingClip = "evenodd";
          break;
        case "BT":
          tm = IDENTITY;
          lm = IDENTITY;
          break;
        case "Tf":
          text.size = n[1] || text.size;
          break;
        case "Tc":
          text.charSpace = n[0];
          break;
        case "Tw":
          text.wordSpace = n[0];
          break;
        case "Tz":
          text.scale = n[0] / 100;
          break;
        case "TL":
          text.leading = n[0];
          break;
        case "Ts":
          text.rise = n[0];
          break;
        case "Td":
          moveText(n[0], n[1]);
          break;
        case "TD":
          text.leading = -n[1];
          moveText(n[0], n[1]);
          break;
        case "Tm":
          lm = n.slice(0, 6);
          tm = lm;
          break;
        case "T*":
          moveText(0, -text.leading);
          break;
        case "Tj":
          show(a[0]);
          break;
        case "'":
          moveText(0, -text.leading);
          show(a[0]);
          break;
        case '"':
          text.wordSpace = n[0];
          text.charSpace = n[1];
          moveText(0, -text.leading);
          show(a[2]);
          break;
        case "TJ":
          for (const part of a[0] || []) {
            if (typeof part === "number") tm = multiply([1, 0, 0, 1, (-part / 1000) * text.size * text.scale, 0], tm);
            else show(part);
          }
          break;
        default:
          break;
      }
    }
  }

  async function renderPdfPage(page) {
    const [x0, y0, x1, y1] = page.mediaBox;
    // Las líneas de la cuadrícula miden 0,6 pt: a 3 px/pt siguen siendo líneas enteras.
    const scale = 3;
    const width = Math.round((x1 - x0) * scale);
    const height = Math.round((y1 - y0) * scale);
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, -scale, -x0 * scale, y1 * scale);
    ctx.fillStyle = "#000";
    ctx.strokeStyle = "#000";
    for (const stream of page.streams) {
      let data = stream.data;
      if (stream.filter === "FlateDecode") data = await inflate(data);
      else if (stream.filter) continue;
      ctx.save();
      drawPdfContent(ctx, binaryString(data));
      ctx.restore();
    }
    return { width, height, channels: 4, data: ctx.getImageData(0, 0, width, height).data };
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
    for (const page of findPdfPages(bytes)) {
      try {
        return analysePixels(await renderPdfPage(page), now);
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
