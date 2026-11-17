/* Minimal I18N for tests/intensity.html: returns the key and its variables, so texts can be checked without the dictionaries. */
window.I18N = {
  lang: "en",
  t: (k, v) => k + (v ? JSON.stringify(v) : ""),
};
