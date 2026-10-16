/*
 * Small Bayesian optimization in the browser (used when visitors change thresholds).
 * Simplified compared with the Python study (training/flavor_improver/bo.py, botorch):
 *   - Gaussian process with an isotropic RBF kernel on inputs scaled to [0, 1]^D, outputs standardized;
 *     length scale and noise picked from a small grid by marginal likelihood at every step.
 *   - Expected Improvement maximized over random candidates: sparse random recipes (1 to K additives)
 *     plus local changes of the best recipes so far.
 *   - Initial design: nInit sparse random recipes, as in the Python "bo_sparse_init" method.
 * Also provides the random sparse search used as the baseline.
 */
(function () {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const uniform = (rng, a, b) => a + (b - a) * rng();
  const randint = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));   // inclusive
  function choice(rng, n, k) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < k; i++) { const j = i + Math.floor(rng() * (n - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx.slice(0, k);
  }

  function sparseRecipe(problem, rng) {
    const [lo, hi] = problem.spec.x_bounds;
    const x = new Array(problem.dim).fill(lo);
    const k = randint(rng, 1, problem.spec.K);
    for (const i of choice(rng, problem.dim, k)) x[i] = uniform(rng, problem.spec.x_not_added_below, hi);
    return x;
  }

  function localChange(problem, x, rng) {
    const [lo, hi] = problem.spec.x_bounds;
    const cut = problem.spec.x_not_added_below;
    const y = x.slice();
    const m = randint(rng, 1, 2);
    for (const i of choice(rng, problem.dim, m)) {
      const r = rng();
      if (y[i] >= cut && r < 0.25) y[i] = lo;                                     // remove an additive
      else if (y[i] < cut && r < 0.5) y[i] = uniform(rng, cut, hi);              // add one
      else y[i] = Math.min(hi, Math.max(lo, y[i] + 0.5 * gauss(rng)));           // change the amount
    }
    return y;
  }
  function gauss(rng) {
    const u = Math.max(rng(), 1e-12), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---- Gaussian process ----
  function cholesky(A) {
    const n = A.length, L = A.map(() => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 0) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
      }
    }
    return L;
  }
  function solveL(L, b) {   // L y = b
    const n = b.length, y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
    return y;
  }
  function solveLT(L, y) {  // L^T x = y
    const n = y.length, x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
    return x;
  }
  function sqdist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; }

  const LENGTHSCALES = [0.2, 0.3, 0.45, 0.7, 1.0, 1.5, 2.2];
  const NOISES = [1e-6, 1e-3, 1e-2, 1e-1];

  function fitGP(U, y) {
    const n = y.length;
    const mean = y.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(y.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
    const z = y.map(v => (v - mean) / sd);
    const D2 = U.map(a => U.map(b => sqdist(a, b)));
    let best = null;
    for (const ls of LENGTHSCALES) {
      for (const noise of NOISES) {
        const K = D2.map((row, i) => row.map((d, j) => Math.exp(-0.5 * d / (ls * ls)) + (i === j ? noise : 0)));
        const L = cholesky(K);
        if (!L) continue;
        const alpha = solveLT(L, solveL(L, z));
        let logdet = 0; for (let i = 0; i < n; i++) logdet += Math.log(L[i][i]);
        const lml = -0.5 * z.reduce((s, v, i) => s + v * alpha[i], 0) - logdet;
        if (!best || lml > best.lml) best = { lml, ls, noise, L, alpha };
      }
    }
    return { ...best, U, mean, sd, zBest: Math.max(...z) };
  }

  function predict(gp, u) {
    const k = gp.U.map(a => Math.exp(-0.5 * sqdist(a, u) / (gp.ls * gp.ls)));
    let mu = 0; for (let i = 0; i < k.length; i++) mu += k[i] * gp.alpha[i];
    const v = solveL(gp.L, k);
    let vv = 0; for (const a of v) vv += a * a;
    return { mu, sigma: Math.sqrt(Math.max(1 + gp.noise - vv, 1e-12)) };
  }

  function normPdf(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
  function normCdf(z) {   // Abramowitz-Stegun 7.1.26 via erf
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? 0.5 * (1 + e) : 0.5 * (1 - e);
  }
  function expectedImprovement(mu, sigma, best) {
    const z = (mu - best) / sigma;
    return (mu - best) * normCdf(z) + sigma * normPdf(z);
  }

  /*
   * Run BO step by step. onStep({step, x, ev, best}) is called after every evaluation;
   * the loop yields to the browser between steps so the page stays responsive.
   * Returns the list of {x, ev}.
   */
  async function runBO(problem, { budget = 60, nInit = 10, seed = 0, nCandidates = 1500, onStep, shouldStop } = {}) {
    const rng = mulberry32(seed + 1);
    const [lo, hi] = problem.spec.x_bounds;
    const scale = x => x.map(v => (v - lo) / (hi - lo));
    const hist = [];
    const record = async x => {
      const ev = problem.evaluate(x);
      hist.push({ x, ev });
      if (onStep) onStep({ step: hist.length, x, ev, history: hist });
      await new Promise(r => setTimeout(r, 0));
    };
    for (let i = 0; i < nInit; i++) await record(sparseRecipe(problem, rng));
    while (hist.length < budget) {
      if (shouldStop && shouldStop()) break;
      const gp = fitGP(hist.map(h => scale(h.x)), hist.map(h => h.ev.score));
      const top = hist.slice().sort((a, b) => b.ev.score - a.ev.score).slice(0, 3);
      let bestX = null, bestEI = -Infinity;
      for (let c = 0; c < nCandidates; c++) {
        const x = c % 2 === 0 ? sparseRecipe(problem, rng) : localChange(problem, top[c % top.length].x, rng);
        const { mu, sigma } = predict(gp, scale(x));
        const ei = expectedImprovement(mu, sigma, gp.zBest);
        if (ei > bestEI) { bestEI = ei; bestX = x; }
      }
      await record(bestX);
    }
    return hist;
  }

  function runRandomSparse(problem, { budget = 60, seed = 0 } = {}) {
    const rng = mulberry32(10007 + seed);
    const hist = [];
    for (let i = 0; i < budget; i++) { const x = sparseRecipe(problem, rng); hist.push({ x, ev: problem.evaluate(x) }); }
    return hist;
  }

  function bestCurve(hist) {
    let b = -Infinity;
    return hist.map(h => (b = Math.max(b, h.ev.score)));
  }

  window.BO = { runBO, runRandomSparse, bestCurve };
})();
