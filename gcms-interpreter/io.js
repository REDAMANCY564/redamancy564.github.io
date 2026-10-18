/*
 * File reading for gcms-interpreter. Everything runs in the browser on the bytes of the
 * selected file; nothing is sent anywhere.
 *
 * readFile(file) -> {kind: "text" | "excel", fileName, sheets: [{name, rows, dates}],
 *                    encoding, delimiter, decimalComma}
 *   rows   string[][] (cell text as shown in the source)
 *   dates  Set of "r:c" for Excel cells stored as dates (a CAS number Excel turned into a date)
 */
(function () {
  const DELIMITERS = [",", "\t", ";", "|"];

  /** Decode bytes: BOM first, then strict UTF-8, then GB18030 (a superset of GBK). */
  function decode(bytes) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "UTF-8 (BOM)" };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "UTF-16 LE" };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "UTF-16 BE" };
    }
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
    } catch (e) {
      return { text: new TextDecoder("gb18030").decode(bytes), encoding: "GBK / GB18030" };
    }
  }

  /** RFC 4180 style parser: quoted fields may contain delimiters, quotes ("") and newlines. */
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = "", inQuotes = false, i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === "") { inQuotes = true; i++; continue; }
      if (ch === delim) { row.push(field); field = ""; i++; continue; }
      if (ch === "\r" || ch === "\n") {
        row.push(field); rows.push(row); row = []; field = "";
        i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      field += ch; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.map(r => r.map(c => c.trim()));
  }

  /**
   * Pick the delimiter whose split gives the most rows sharing the same (>1) field count,
   * i.e. the most table-like result. Instrument header lines usually have fewer fields.
   */
  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 80).join("\n");
    let best = { delim: ",", score: -1 };
    for (const d of DELIMITERS) {
      const counts = {};
      for (const r of parseDelimited(sample, d)) {
        if (r.length > 1) counts[r.length] = (counts[r.length] || 0) + 1;
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      const score = top ? top[1] * Math.log2(+top[0]) : 0;
      if (score > best.score) best = { delim: d, score };
    }
    return best.delim;
  }

  /**
   * Decimal comma: numbers like "12,5" or "1.234,56". Only possible when the delimiter is
   * not a comma. "1,234" alone is ambiguous (thousands separator) and is not counted.
   */
  function detectDecimalComma(rows, delim) {
    if (delim === ",") return false;
    let comma = 0, dot = 0;
    for (const r of rows) {
      for (const c of r) {
        if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(c) || /^-?\d+,(\d{1,2}|\d{4,})$/.test(c)) comma++;
        else if (/^-?\d+\.\d+$/.test(c)) dot++;
      }
    }
    return comma > dot;
  }

  /** Parse a number from cell text. Handles decimal comma, thousands separators, %, spaces. */
  function parseNumber(s, decimalComma) {
    if (s == null) return null;
    let t = String(s).trim().replace(/[\s %]/g, "");
    if (!t) return null;
    if (decimalComma) t = t.replace(/\./g, "").replace(",", ".");
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
    if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
    return Number(t);
  }

  function readExcel(buf) {
    if (typeof XLSX === "undefined") throw Object.assign(new Error("excel_lib"), { code: "excel_lib" });
    const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: false, cellNF: true });
    return wb.SheetNames.map(name => {
      const ws = wb.Sheets[name];
      const rows = [], dates = new Set();
      if (!ws["!ref"]) return { name, rows, dates };
      const range = XLSX.utils.decode_range(ws["!ref"]);
      for (let r = range.s.r; r <= range.e.r; r++) {
        const row = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          let text = "";
          if (cell) {
            const isDate = cell.t === "d" || (cell.t === "n" && cell.z && XLSX.SSF.is_date(cell.z));
            if (isDate) dates.add((r - range.s.r) + ":" + (c - range.s.c));
            // Numbers: the plain value (no display rounding); everything else: the shown text
            text = cell.t === "n" && !isDate ? String(cell.v) : (cell.w != null ? cell.w : String(cell.v));
          }
          row.push(text.trim());
        }
        rows.push(row);
      }
      return { name, rows, dates };
    });
  }

  async function readFile(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;               // xlsx
    const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11;  // xls
    if (isZip || isOle || /\.(xlsx|xls)$/i.test(file.name)) {
      return { kind: "excel", fileName: file.name, sheets: readExcel(buf), encoding: null, delimiter: null, decimalComma: false };
    }
    const { text, encoding } = decode(bytes);
    const delimiter = detectDelimiter(text);
    const rows = parseDelimited(text, delimiter);
    return {
      kind: "text", fileName: file.name, encoding, delimiter,
      decimalComma: detectDecimalComma(rows, delimiter),
      sheets: [{ name: file.name, rows, dates: new Set() }],
    };
  }

  window.GcmsIO = { decode, parseDelimited, detectDelimiter, detectDecimalComma, parseNumber, readFile };
})();
