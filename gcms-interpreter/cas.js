/*
 * CAS Registry Number normalization (PLAN-gcms.md section 5).
 *
 * normalizeCas(raw, isDateCell) -> {cas, status, original}
 *   status "ok"         normalized and the check digit is right: used for matching
 *          "suspicious" looks like a CAS number but the check digit is wrong: NOT used
 *          "date"       Excel turned it into a date: the number is lost, not used
 *          "invalid"    not a CAS number
 *          "empty"      no CAS given
 *   cas    normalized text (also for "suspicious", so the user can see it), else null
 *
 * Handled: spaces, leading zeros (000110-43-0 -> 110-43-0), numbers from Excel
 * (110430 or 110430.0 or 1.1043E+05 -> 110-43-0), "CAS 64-19-7" style prefixes.
 */
(function () {
  const HYPHENATED = /(\d{2,10})-(\d{2})-(\d)/;

  /** Check digit: sum of digits (right to left, excluding the check digit) times 1, 2, 3, ... mod 10. */
  function checkDigitOk(cas) {
    const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(cas);
    if (!m) return false;
    const body = (m[1] + m[2]).split("").reverse();
    return body.reduce((s, d, i) => s + (i + 1) * +d, 0) % 10 === +m[3];
  }

  /**
   * Text that looks like a date (Excel display formats), e.g. 2019-06-04, 2019/6/4, 6/4/2019,
   * 4-Jun, Jun-19. A CAS number always ends in ONE check digit, so "yyyy-mm-d" (e.g. the real
   * CAS 2548-87-0) is not taken as a date; hyphen dates need a two-digit last part.
   */
  function looksLikeDate(s) {
    return /^\d{4}[-.]\d{1,2}[-.]\d{2}$/.test(s) ||
      /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s) ||
      /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s) ||
      /^\d{1,2}[- ][A-Za-z]{3,9}([- ]\d{2,4})?$/.test(s) ||
      /^[A-Za-z]{3,9}[- ]\d{1,4}$/.test(s);
  }

  /** "110430" -> "110-43-0": last digit is the check digit, the two before it the middle block. */
  function fromDigits(digits) {
    const d = digits.replace(/^0+/, "");
    if (d.length < 5 || d.length > 10) return null;
    return d.slice(0, -3) + "-" + d.slice(-3, -1) + "-" + d.slice(-1);
  }

  function normalizeCas(raw, isDateCell) {
    const original = raw == null ? "" : String(raw);
    const s = original.normalize("NFKC").trim().replace(/[‐-―−]/g, "-");
    if (!s) return { cas: null, status: "empty", original };
    if (isDateCell) return { cas: null, status: "date", original };

    let cas = null;
    const compact = s.replace(/\s+/g, "");
    const hy = HYPHENATED.exec(compact);
    if (hy && !looksLikeDate(compact)) {
      cas = fromDigits(hy[1] + hy[2] + hy[3]) && (hy[1].replace(/^0+/, "") + "-" + hy[2] + "-" + hy[3]);
    } else if (/^\d+(\.0+)?$/.test(compact)) {
      cas = fromDigits(compact.split(".")[0]);
    } else if (/^\d+(\.\d+)?[eE]\+?\d+$/.test(compact)) {
      const n = Number(compact);
      if (Number.isInteger(n)) cas = fromDigits(String(n));
    } else if (looksLikeDate(compact)) {
      return { cas: null, status: "date", original };
    }
    if (!cas || !/^\d{2,7}-\d{2}-\d$/.test(cas)) return { cas: null, status: "invalid", original };
    return { cas, status: checkDigitOk(cas) ? "ok" : "suspicious", original };
  }

  window.GcmsCas = { normalizeCas, checkDigitOk, looksLikeDate };
})();
