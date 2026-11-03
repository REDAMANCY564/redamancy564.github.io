/*
 * Homepage script (moved out of index.html so the page can have a strict CSP without 'unsafe-inline').
 * 1. Fills in the profile, directory, papers and patents in the current language.
 * 2. "Leave a message" form: sent to Web3Forms with fetch only when the visitor clicks Send.
 *    Nothing is requested from api.web3forms.com while the page loads.
 */
(async function () {
  const version = new URL(document.currentScript.src).search;   // "?v=..." of this script, reused for profile.json
  let profile = {};
  try {
    profile = await (await fetch("assets/profile.json" + version)).json();
  } catch (e) {
    console.error("Could not load profile.json", e);
  }
  await I18N.ready;
  const esc = SITE.esc;

  function render() {
    const t = I18N.t;
    document.title = t("home.page_title");
    document.getElementById("role").textContent = I18N.pick(profile.role) || "";
    // bio, with the part named in profile.bio_link linking to the research overview
    const bioEl = document.getElementById("bio"), bio = I18N.pick(profile.bio) || "";
    const link = profile.bio_link ? I18N.pick(profile.bio_link) : "";
    const at = link ? bio.indexOf(link) : -1;
    bioEl.textContent = at < 0 ? bio : bio.slice(0, at);
    if (at >= 0) {
      const a = document.createElement("a");
      a.href = "research/";
      a.textContent = link;
      bioEl.append(a, bio.slice(at + link.length));
    }

    // One contact line: Email / CV (PDF) / GitHub
    const links = [];
    if (profile.email) links.push('<a href="mailto:' + esc(profile.email) + '">' + esc(t("home.email")) + "</a>");
    if (profile.cv_pdf) links.push('<a href="' + esc(profile.cv_pdf) + '" target="_blank" rel="noopener">' + esc(t("home.cv_pdf")) + "</a>");
    if (profile.github) links.push('<a href="' + esc(profile.github) + '" target="_blank" rel="noopener">GitHub</a>');
    if (profile.linkedin) links.push('<a href="' + esc(profile.linkedin) + '" target="_blank" rel="noopener">LinkedIn</a>');
    document.getElementById("contact").innerHTML = links.join("");

    SITE.renderDirectory(document.getElementById("dir-list"), "");

    document.getElementById("paper-list").innerHTML = (profile.papers || []).map(p =>
      "<li>" + esc(p.title) + '<br><span class="venue"><i>' + esc(p.venue) + "</i> · " + esc(t("home.first_author")) + "</span></li>"
    ).join("");
    document.getElementById("patent-list").innerHTML = (profile.patents || []).concat(profile.talks || []).map(p =>
      "<li>" + esc(I18N.pick(p.title)) + '<br><span class="venue">' + esc(I18N.pick(p.note)) + "</span></li>"
    ).join("");
    renderStatus();
  }

  // ---- Message form ----
  const form = document.getElementById("msg-form");
  const sendBtn = document.getElementById("msg-send");
  const status = document.getElementById("msg-status");
  const openBtn = document.getElementById("msg-open");
  let statusKey = "";   // "", "home.msg_ok" or "home.msg_fail"; re-translated on language change

  function renderStatus() {
    status.textContent = statusKey ? I18N.t(statusKey) : "";
    status.classList.toggle("err", statusKey === "home.msg_fail");
    sendBtn.textContent = I18N.t(sendBtn.disabled ? "home.msg_sending" : "home.msg_send");
  }

  // Collapsed by default (keeps the homepage within three screens); the button opens the form
  openBtn.addEventListener("click", function () {
    form.hidden = false;
    openBtn.parentElement.hidden = true;
    openBtn.setAttribute("aria-expanded", "true");
    document.getElementById("msg-body").focus();
  });

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (sendBtn.disabled) return;
    if (form.elements.botcheck.checked) return;   // filled in by a bot: drop silently
    sendBtn.disabled = true;
    statusKey = "";
    renderStatus();
    try {
      const data = Object.fromEntries(new FormData(form));
      delete data.botcheck;
      const res = await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        statusKey = "home.msg_ok";
        form.reset();
      } else {
        statusKey = "home.msg_fail";
      }
    } catch (e) {
      statusKey = "home.msg_fail";
    } finally {
      sendBtn.disabled = false;
      renderStatus();
    }
  });

  render();
  I18N.onChange(render);
})();
