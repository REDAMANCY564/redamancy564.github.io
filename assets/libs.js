/*
 * Third-party libraries, hosted on this site in assets/vendor/ (versions, licenses and checksums in
 * assets/vendor/README.md) and loaded only when a page first needs them, so they never hold up the
 * first screen:
 *   Libs.rdkit()  RDKit.js MinimalLib: structures, SMILES parsing, fingerprints
 *   Libs.ort()    ONNX Runtime Web (wasm): the odor and taste models
 *   Libs.chart()  Chart.js
 * Each returns a promise and loads at most once per page; a failed load can be retried.
 */
(function () {
  const base = new URL("vendor/", document.currentScript.src);
  const scripts = {};
  let rdkit = null;

  function script(path) {
    const url = new URL(path, base).href;
    if (!scripts[url]) {
      scripts[url] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.onload = resolve;
        s.onerror = () => { delete scripts[url]; s.remove(); reject(new Error("Failed to load " + url)); };
        document.head.appendChild(s);
      });
    }
    return scripts[url];
  }

  window.Libs = {
    rdkit() {
      if (!rdkit) {
        rdkit = script("rdkit/RDKit_minimal.js")
          .then(() => initRDKitModule({ locateFile: () => new URL("rdkit/RDKit_minimal.wasm", base).href }))
          .catch(err => { rdkit = null; throw err; });
      }
      return rdkit;
    },
    async ort() {
      await script("onnxruntime/ort.wasm.min.js");
      ort.env.wasm.wasmPaths = new URL("onnxruntime/", base).href;
      return ort;
    },
    chart() {
      return script("chartjs/chart.umd.min.js").then(() => window.Chart);
    },
  };
})();
