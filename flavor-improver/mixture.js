/*
 * Virtual evaluation function for flavor-improver, the browser twin of training/flavor_improver/mixture.py.
 * Parameters come from data/mixture_spec.json; tests/parity.html checks agreement with Python.
 *
 *   OAV_i = conc_i / threshold_i ;  I_i = log10(OAV_i) if OAV_i > 1 else 0
 *   profile = normalize( sum_i I_i * lift_i )                      (L1 normalization)
 *   target  = normalize( clip(base_profile + alpha * direction, 0) )
 *   score   = cos(profile, target) - lambda1 * max(0, n_added - K) - lambda2 * log10(1 + sum added OAV)
 * Search variable per candidate additive: x = log10(added OAV); x < x_not_added_below means "not added".
 */
(function () {
  function normalize(v) {
    let s = 0;
    for (const a of v) s += a;
    return s > 0 ? v.map(a => a / s) : v.slice();
  }

  function cosine(a, b) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa > 0 && bb > 0 ? ab / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
  }

  /*
   * palette: palette.json; base: one entry of bases.json; direction: {dim: -1|0|1};
   * spec: mixture_spec.json; thresholdsUg: {compound: threshold in ug/kg} (defaults from palette if omitted).
   */
  class Problem {
    constructor({ palette, base, direction, spec, thresholdsUg }) {
      const comps = palette.compounds;
      this.spec = spec;
      this.dims = palette.profile_dims;
      this.base = base;
      this.candidates = Object.keys(comps).filter(n => comps[n].role === "palette");
      this.names = Array.from(new Set([...Object.keys(base.composition_ug_kg), ...this.candidates])).sort(pyCompare);
      this.thr = this.names.map(n => (thresholdsUg && thresholdsUg[n] != null ? thresholdsUg[n] : comps[n].threshold_mg_kg * 1000));
      this.lift = this.names.map(n => comps[n].lift);
      this.baseConc = this.names.map(n => base.composition_ug_kg[n] || 0);
      this.candIdx = this.candidates.map(n => this.names.indexOf(n));
      this.dim = this.candidates.length;
      this.baseProfile = this.profile(this.baseConc);
      const d = this.dims.map(k => Number((direction || {})[k] || 0));
      this.target = normalize(this.baseProfile.map((v, i) => Math.max(0, v + spec.alpha * d[i])));
    }

    addedOav(x) {
      return x.map(v => (v < this.spec.x_not_added_below ? 0 : Math.pow(10, v)));
    }

    concentrations(x) {
      const conc = this.baseConc.slice();
      const add = this.addedOav(x);
      this.candIdx.forEach((i, j) => { conc[i] += add[j] * this.thr[i]; });
      return conc;
    }

    profile(conc) {
      const nd = this.dims.length;
      const out = new Array(nd).fill(0);
      for (let i = 0; i < conc.length; i++) {
        const oav = conc[i] / this.thr[i];
        if (!(oav > 1)) continue;
        const inten = Math.log10(oav);
        const l = this.lift[i];
        for (let k = 0; k < nd; k++) out[k] += inten * l[k];
      }
      return normalize(out);
    }

    evaluate(x) {
      const add = this.addedOav(x);
      const prof = this.profile(this.concentrations(x));
      const cos = cosine(prof, this.target);
      let nAdded = 0, sum = 0;
      for (const a of add) { if (a > 0) nAdded++; sum += a; }
      const penCount = this.spec.lambda1 * Math.max(0, nAdded - this.spec.K);
      const penAmount = this.spec.lambda2 * Math.log10(1 + sum);
      return { score: cos - penCount - penAmount, cos, nAdded, penCount, penAmount, profile: prof };
    }

    /* Additions as [{compound, added_ug_kg, added_oav, oav_after}], largest added OAV first. */
    recipe(x) {
      const add = this.addedOav(x);
      const conc = this.concentrations(x);
      const out = [];
      this.candidates.forEach((n, j) => {
        if (add[j] > 0) {
          const i = this.candIdx[j];
          out.push({ compound: n, added_ug_kg: add[j] * this.thr[i], added_oav: add[j], oav_after: conc[i] / this.thr[i] });
        }
      });
      return out.sort((a, b) => b.added_oav - a.added_oav);
    }
  }

  // Python's sorted() on str compares code points; localeCompare would order differently.
  function pyCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  window.Mixture = { Problem, normalize, cosine };
})();
