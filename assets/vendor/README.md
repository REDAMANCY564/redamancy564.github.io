# Third-party libraries hosted on this site

Self-hosted (not loaded from a CDN): every page loads scripts only from this site, pages such as
gcms-interpreter can run offline, and the Content-Security-Policy only allows connections to this site
(plus the PubChem / Europe PMC data lookups some tools make). Files are copied unchanged from the
source; check them with `sha256sum` (PowerShell: `Get-FileHash`).

Used by: RDKit (structures, fingerprints): ingredient-finder, odor-predictor, taste-predictor, odor-map, flavor-kb,
flavor-improver (own-data mode); ONNX Runtime Web (odor and taste models): odor-predictor, taste-predictor,
ingredient-finder, flavor-improver; Chart.js: odor-predictor, taste-predictor, flavor-improver; d3 modules: odor-map;
SheetJS: gcms-interpreter.

| Library | Version | License | Source | File sha256 |
|---|---|---|---|---|
| SheetJS Community Edition | 0.20.3 | Apache-2.0 (`sheetjs/LICENSE`) | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz | `sheetjs/xlsx.full.min.js` cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41 |
| RDKit.js (`@rdkit/rdkit`) | 2026.3.6 | BSD-3-Clause (`rdkit/LICENSE`, from rdkit/rdkit tag Release_2026_03_6) | https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2026.3.6/dist/ | `rdkit/RDKit_minimal.js` 25ea1529b8eeb106ac1f3acb7c5d338a90533248c6223614574fefd14fee772f<br>`rdkit/RDKit_minimal.wasm` f5981af4cf5bdcef861ffdf7410330bf9887f1195e39fbf9901b3a2f134ace2e |
| ONNX Runtime Web (`onnxruntime-web`) | 1.30.0 | MIT (`onnxruntime/LICENSE`, from microsoft/onnxruntime tag v1.30.0) | https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ | `onnxruntime/ort.wasm.min.js` faece07e84faa9001f5104bbe4e5c70861d06cb2376a0dea1fa0ad33a67adc81<br>`onnxruntime/ort-wasm-simd-threaded.mjs` e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b<br>`onnxruntime/ort-wasm-simd-threaded.wasm` 3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2 |
| Chart.js | 4.5.1 | MIT (`chartjs/LICENSE.md`) | https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js (identical to npm chart.js@4.5.1) | `chartjs/chart.umd.min.js` 48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a |
| d3-dispatch | 3.0.1 | ISC (`d3/LICENSE-d3-dispatch`) | https://cdn.jsdelivr.net/npm/d3-dispatch@3.0.1/dist/d3-dispatch.min.js | `d3/d3-dispatch.min.js` 94b3bbdb6b98dc1325a15762b051013e8253999b0e0436b27d1da17b952ba0af |
| d3-selection | 3.0.0 | ISC (`d3/LICENSE-d3-selection`) | https://cdn.jsdelivr.net/npm/d3-selection@3.0.0/dist/d3-selection.min.js | `d3/d3-selection.min.js` 45daab9cf677901bcae102f3f23ca2930db3c0fb8ff9e3dbed087d9c4de921ca |
| d3-color | 3.1.0 | ISC (`d3/LICENSE-d3-color`) | https://cdn.jsdelivr.net/npm/d3-color@3.1.0/dist/d3-color.min.js | `d3/d3-color.min.js` a12639010163230b8c130fbeb92a3a49bb5f6989a566d3664d759522db458489 |
| d3-interpolate | 3.0.1 | ISC (`d3/LICENSE-d3-interpolate`) | https://cdn.jsdelivr.net/npm/d3-interpolate@3.0.1/dist/d3-interpolate.min.js | `d3/d3-interpolate.min.js` bfc321e4c3f3b3aadc88cfe15ccb5e443abfeadef8b75c65b41c33a4d78a98ae |
| d3-ease | 3.0.1 | ISC (`d3/LICENSE-d3-ease`) | https://cdn.jsdelivr.net/npm/d3-ease@3.0.1/dist/d3-ease.min.js | `d3/d3-ease.min.js` e60a1ed750a1ad138dd18e8d3f463238113cfbf7d89685a13d19bd4e048dc3ce |
| d3-timer | 3.0.1 | ISC (`d3/LICENSE-d3-timer`) | https://cdn.jsdelivr.net/npm/d3-timer@3.0.1/dist/d3-timer.min.js | `d3/d3-timer.min.js` 911ceda305f014b6b53ca68d5c896a9a387da120cfd56a421a2c60cca2fc9b36 |
| d3-transition | 3.0.1 | ISC (`d3/LICENSE-d3-transition`) | https://cdn.jsdelivr.net/npm/d3-transition@3.0.1/dist/d3-transition.min.js | `d3/d3-transition.min.js` c248d97f6c131af7f4a12a3ff1f2ed83f1cc6c0e17fc764a198b6ee452e6621b |
| d3-drag | 3.0.0 | ISC (`d3/LICENSE-d3-drag`) | https://cdn.jsdelivr.net/npm/d3-drag@3.0.0/dist/d3-drag.min.js | `d3/d3-drag.min.js` 158499fa8cdeef459e2ab9d01af22babd003c423a212fb24088c0f838864012b |
| d3-zoom | 3.0.0 | ISC (`d3/LICENSE-d3-zoom`) | https://cdn.jsdelivr.net/npm/d3-zoom@3.0.0/dist/d3-zoom.min.js | `d3/d3-zoom.min.js` 4fdce9b830b78225c58e27258296084253c41a5eaf8cad9bd9ccfe3025daf1cf |
| d3-quadtree | 3.0.1 | ISC (`d3/LICENSE-d3-quadtree`) | https://cdn.jsdelivr.net/npm/d3-quadtree@3.0.1/dist/d3-quadtree.min.js | `d3/d3-quadtree.min.js` 57e2ad12824ed82893ba447523f2a2fb9beeb9222aafb2c778a9f5b313348b0e |

To update a library: download the new version from the source above into the same folder, update
the version in the page or script that loads it and in this table (with the new sha256), and run the
tool's tests page (`tests/`).
