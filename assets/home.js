/*
 * Homepage script (moved out of index.html so the page can have a strict CSP without 'unsafe-inline').
 * 1. Fills in the profile, directory, papers and patents in the current language.
 * 2. "Leave a message" form: sent to Web3Forms with fetch only when the visitor clicks Send.
 *    Nothing is requested from api.web3forms.com while the page loads. The Send button shows a spinner
 *    while the request runs and a tick with "Sent" for 2 s after the service has confirmed it.
 * 3. Copy buttons (UI.copyButton, assets/i18n.js) after each paper's DOI and after the e-mail link.
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
    // bio, with the parts named in profile.bio_link linking to the research overview (same as tools/prerender.py)
    const bioEl = document.getElementById("bio");
    let rest = I18N.pick(profile.bio) || "";
    bioEl.textContent = "";
    for (const l of profile.bio_link || []) {
      const link = I18N.pick(l) || "", at = link ? rest.indexOf(link) : -1;
      if (at < 0) continue;
      const a = document.createElement("a");
      a.href = l.href;
      a.textContent = link;
      bioEl.append(rest.slice(0, at), a);
      rest = rest.slice(at + link.length);
    }
    bioEl.append(rest);
    I18N.nobr(bioEl);

    // One contact line: Email / CV (PDF) / GitHub
    const links = [];
    if (profile.email) links.push('<a href="mailto:' + esc(profile.email) + '">' + esc(t("home.email")) + "</a>");
    const cvPdf = (profile.cv_pdf_lang && I18N.pick(profile.cv_pdf_lang)) || profile.cv_pdf;   // one PDF per language
    if (cvPdf) links.push('<a href="' + esc(cvPdf) + '" target="_blank" rel="noopener">' + esc(t("home.cv_pdf")) + "</a>");
    if (profile.github) links.push('<a href="' + esc(profile.github) + '" target="_blank" rel="noopener">GitHub</a>');
    if (profile.linkedin) links.push('<a href="' + esc(profile.linkedin) + '" target="_blank" rel="noopener">LinkedIn</a>');
    const contact = document.getElementById("contact");
    contact.innerHTML = links.join("");
    const mail = contact.querySelector('a[href^="mailto:"]');
    if (mail) mail.after(UI.copyButton({ text: profile.email, label: "copy.email" }));   // not inside the link

    SITE.renderDirectory(document.getElementById("dir-list"), "");

    document.getElementById("paper-list").innerHTML = (profile.papers || []).map(p =>
      "<li>" + esc(p.title) + '<br><span class="venue"><i>' + esc(p.venue) + "</i>" + (p.year ? " " + esc(p.year) : "") +
        " · " + esc(t("home.first_author")) + SITE.doiLink(p) + "</span></li>"
    ).join("");
    // copy button after each DOI link (copies the DOI itself, without "doi:")
    document.querySelectorAll("#paper-list li").forEach((li, i) => {
      const p = (profile.papers || [])[i], a = li.querySelector('a[href^="https://doi.org/"]');
      if (p && p.doi && a) a.after(UI.copyButton({ text: p.doi, label: "copy.doi", select: a }));
    });
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
  let sendState = "";   // "", "sending" (request running) or "sent" (confirmed by the service, shown for 2 s)
  let sentTimer = 0;
  const OK_ICON = '<svg class="ok-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M3 8.5l3.2 3.1L13 4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderStatus() {
    status.textContent = statusKey ? I18N.t(statusKey) : "";
    status.classList.toggle("err", statusKey === "home.msg_fail");
    const label = esc(I18N.t(sendState === "sending" ? "home.msg_sending" : sendState === "sent" ? "home.msg_sent" : "home.msg_send"));
    sendBtn.innerHTML = sendState === "sending" ? '<span class="spin" aria-hidden="true"></span>' + label
      : sendState === "sent" ? OK_ICON + label : label;
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
    clearTimeout(sentTimer);
    sendState = "sending";
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
        sendState = "sent";
        form.reset();
      } else {
        statusKey = "home.msg_fail";
        sendState = "";
      }
    } catch (e) {
      statusKey = "home.msg_fail";
      sendState = "";
    } finally {
      sendBtn.disabled = false;
      renderStatus();
      // "Sent" goes back to "Send" after 2 s
      if (sendState === "sent") sentTimer = setTimeout(() => { sendState = ""; renderStatus(); }, 2000);
    }
  });

  render();
  I18N.onChange(render);
})();
