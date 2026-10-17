/*
 * Atom contribution view shared by the odor and taste pages: colors atoms of an RDKit.js
 * drawing by their occlusion contribution, plus a label picker and a color legend.
 * contrib: array (one value per atom, in the atom order of the drawn SMILES) of
 * probability changes, p(full) - p(without the atom). Needs I18N (assets/i18n.js).
 */
(function () {
  const POS = [0.91, 0.35, 0.05];  // raises the probability: orange
  const NEG = [0.11, 0.49, 0.84];  // lowers the probability: blue
  const MIN_SHOWN = 0.005;         // contributions below 0.5 percentage points stay uncolored
  const css = c => "rgb(" + c.map(v => Math.round(v * 255)).join(",") + ")";
  const maxAbs = contrib => (contrib ? contrib.reduce((m, v) => Math.max(m, Math.abs(v)), 0) : 0);

  function atomColors(contrib) {
    const top = maxAbs(contrib);
    const colors = {};
    if (top < MIN_SHOWN) return colors;
    contrib.forEach((v, i) => {
      if (Math.abs(v) < MIN_SHOWN) return;
      const base = v > 0 ? POS : NEG;
      const t = 0.25 + 0.75 * Math.abs(v) / top;  // keep weak but shown atoms visible
      colors[i] = base.map(c => 1 - t + t * c);
    });
    return colors;
  }

  /** SVG of the molecule; atoms colored by contrib if given. Returns null if unparsable. */
  function drawSvg(rdkit, smiles, contrib) {
    const mol = rdkit.get_mol(smiles);
    if (!mol) return null;
    try {
      const opts = { width: 360, height: 270, bondLineWidth: 1.6, clearBackground: false, addStereoAnnotation: false };
      const colors = contrib && contrib.length === mol.get_num_atoms() ? atomColors(contrib) : {};
      const atoms = Object.keys(colors).map(Number);
      if (atoms.length) {
        Object.assign(opts, {
          atoms, bonds: [], highlightAtomColors: colors,
          highlightAtomRadii: Object.fromEntries(atoms.map(i => [i, 0.42])),
        });
      }
      return mol.get_svg_with_highlights(JSON.stringify(opts));
    } finally {
      mol.delete();
    }
  }

  /** Row of buttons, one per label id; onPick(id) when clicked. */
  function renderPicker(el, ids, selected, nameFn, onPick) {
    el.innerHTML = "";
    const head = document.createElement("span");
    head.className = "muted";
    head.textContent = I18N.t("contrib.pick");
    el.appendChild(head);
    ids.forEach(id => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip-btn" + (id === selected ? " active" : "");
      b.setAttribute("aria-pressed", id === selected ? "true" : "false");
      b.textContent = nameFn(id);
      b.addEventListener("click", () => onPick(id));
      el.appendChild(b);
    });
  }

  function renderLegend(el, contrib, labelText) {
    el.innerHTML = "";
    const top = maxAbs(contrib);
    const title = document.createElement("div");
    title.className = "contrib-title";
    title.textContent = I18N.t("contrib.title", { label: labelText });
    el.appendChild(title);
    if (!contrib || top < MIN_SHOWN) {
      const p = document.createElement("div");
      p.className = "small muted";
      p.textContent = I18N.t(contrib ? "contrib.none" : "contrib.unavailable");
      el.appendChild(p);
    } else {
      const bar = document.createElement("div");
      bar.className = "contrib-bar";
      bar.style.background = "linear-gradient(90deg, " + css(NEG) + ", #fff 50%, " + css(POS) + ")";
      const x = (top * 100).toFixed(1);
      const scale = document.createElement("div");
      scale.className = "contrib-scale small";
      [["−" + x, "contrib.lower"], ["0", null], ["+" + x, "contrib.raise"]].forEach(([v, key]) => {
        const s = document.createElement("span");
        s.textContent = key ? v + " " + I18N.t(key) : v;
        scale.appendChild(s);
      });
      el.append(bar, scale);
    }
    const note = document.createElement("p");
    note.className = "small muted contrib-note";
    note.textContent = I18N.t("contrib.note");
    el.appendChild(note);
  }

  window.ContribView = { drawSvg, renderPicker, renderLegend, atomColors };
})();
