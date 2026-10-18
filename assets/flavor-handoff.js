/*
 * Hand-off of one sample's GC-MS flavor result from gcms-interpreter to flavor-improver
 * (PLAN-userdata.md). Kept in this browser's localStorage (same site, both pages), never sent
 * anywhere. Two slots: "sample" (the product to improve) and "target" (the reference to approach).
 *
 * Record: {
 *   name, savedAt (ISO time), source: "gcms" | "csv",
 *   mode: "oav" (value = amount in ug/kg) | "roav" (value = area, relative content or amount:
 *         anything proportional to concentration within this sample),
 *   basis: "conc" | "area" | "rel",
 *   compounds: [{label, cas, kbId, value, thr_mg_kg (null = none), thrSource}],
 *   notFound:  [{label, cas, kbId}]   targets of the standard file not detected in this sample
 * }
 */
(function () {
  const KEY = "flavor-handoff-v1";
  const SLOTS = ["sample", "target"];

  function empty() { return { version: 1, slots: {} }; }

  function read() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || "null");
      return d && d.version === 1 && d.slots ? d : empty();
    } catch (e) {
      return empty();
    }
  }

  /** Problems of a record (empty list = usable). */
  function validate(rec) {
    const err = [];
    if (!rec || typeof rec !== "object") return ["not_object"];
    if (!["oav", "roav"].includes(rec.mode)) err.push("mode");
    if (!Array.isArray(rec.compounds) || !rec.compounds.length) err.push("no_compounds");
    else if (rec.compounds.some(c => !c || !c.label || !(typeof c.value === "number" && c.value >= 0))) err.push("bad_compound");
    return err;
  }

  /** Save a record into a slot. Returns true when stored. */
  function save(slot, rec) {
    if (!SLOTS.includes(slot) || validate(rec).length) return false;
    const d = read();
    d.slots[slot] = rec;
    try {
      localStorage.setItem(KEY, JSON.stringify(d));
      return true;
    } catch (e) {
      return false;
    }
  }

  function get(slot) {
    const r = read().slots[slot];
    return r && !validate(r).length ? r : null;
  }

  function clear(slot) {
    const d = read();
    if (slot) delete d.slots[slot]; else d.slots = {};
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* storage off */ }
  }

  window.FlavorHandoff = { KEY, SLOTS, read, get, save, clear, validate };
})();
