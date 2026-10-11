/*
 * Menu manager: edit dishes and shared ingredients, see the activity log,
 * manage the team. A saved change is live for staff straight away.
 * Talks only to /api/manager/* (see netlify/functions/manager.mjs).
 * Built with Dom.h (no innerHTML); validation and safety checks come from
 * menu-schema.js so the page and the server always agree.
 */
(function () {
  "use strict";

  var h = Dom.h, icon = Dom.icon, replace = Dom.replace, R = AllergenRules, S = MenuSchema;
  var app = document.getElementById("app");
  var toastsEl = document.getElementById("toasts");

  var state = {
    session: null,
    menu: null,         // { dishes, shared, meta, appUpdates, oldChanges, updatedAt, updatedBy }
    dirty: false,       // unsaved edits in the dish editor
    pollTimer: null,
    dishFilter: { q: "", category: "", show: "all" },
    activityFilter: "all",
  };

  // ---------- API ----------

  function ApiError(status, body) {
    this.status = status;
    this.message = (body && body.error) || "Request failed.";
    this.body = body || {};
  }

  function api(method, path, body, opts) {
    opts = opts || {};
    var headers = { "x-requested-with": "manager" };
    var payload;
    if (opts.raw) {
      payload = opts.raw;
      headers["content-type"] = "application/octet-stream";
      if (opts.fileName) headers["x-file-name"] = encodeURIComponent(opts.fileName);
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    return fetch("/api/manager" + path, { method: method, headers: headers, body: payload, credentials: "same-origin", cache: "no-store" })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (res.status === 401 && !/^\/(login|setup|reset-owner)/.test(path)) {
            var wasSignedIn = !!state.session;
            stashUnsaved();
            state.session = null;
            showLogin(Object.assign({}, data || {}, { expired: wasSignedIn }));
          }
          if (!res.ok) throw new ApiError(res.status, data);
          return data;
        });
      }, function () {
        throw new ApiError(0, { error: "No connection. Check the internet and try again." });
      });
  }

  // Sessions end after an hour without activity. If that happens while a
  // dish has unsaved edits, they are kept in this tab and offered back
  // after signing in again, so nobody loses work after being called away.
  var STASH_KEY = "hr-manager-unsaved";

  function stashUnsaved() {
    if (!state.dirty || !state.stash || !state.session) return;
    try {
      sessionStorage.setItem(STASH_KEY, JSON.stringify(Object.assign({ user: state.session.username, at: Date.now() }, state.stash())));
    } catch (e) { /* storage blocked */ }
  }

  function hasStash() {
    try { return !!sessionStorage.getItem(STASH_KEY); } catch (e) { return false; }
  }

  function takeStash(id) {
    try {
      var s = JSON.parse(sessionStorage.getItem(STASH_KEY) || "null");
      if (!s || s.user !== state.session.username || s.id !== (id || "")) return null;
      sessionStorage.removeItem(STASH_KEY);
      return Date.now() - s.at < 24 * 3600e3 ? s : null;
    } catch (e) { return null; }
  }

  function refreshMenu() {
    return api("GET", "/menu").then(function (m) { state.menu = m; renderNav(); return m; });
  }

  // ---------- Small UI helpers ----------

  function toast(message, tone) {
    var el = h("div", { class: "toast " + (tone || "ok") }, message);
    toastsEl.appendChild(el);
    setTimeout(function () { el.classList.add("out"); }, 4300);
    setTimeout(function () { el.remove(); }, 4800);
  }

  function showError(err) {
    if (err && err.status === 401) return [];
    var problems = err && err.body && err.body.problems;
    toast((err && err.message) || "Something went wrong.", "error");
    return problems || [];
  }

  function problemList(problems) {
    if (!problems || !problems.length) return null;
    return h("ul", { class: "problems", role: "alert" }, problems.map(function (p) { return h("li", null, p); }));
  }

  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var mins = Math.round((Date.now() - d) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    if (mins < 60 * 24) return Math.round(mins / 60) + " h ago";
    return d.toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" }) + ", " +
      d.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
  }

  function exactTime(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" });
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }

  function button(label, onclick, cls, attrs) {
    var a = Object.assign({ type: "button", class: "btn " + (cls || ""), onclick: onclick }, attrs || {});
    return h("button", a, label);
  }

  function chipToggle(label, on, onclick, extraClass) {
    return h("button", { type: "button", class: "chip small" + (on ? " selected" : "") + (extraClass ? " " + extraClass : ""),
      "aria-pressed": on ? "true" : "false", onclick: onclick }, label);
  }

  /** What a recipe change does, in plain words: "takes out Egg, Gluten; makes it vegan". */
  function modEffect(resolves) {
    var allergens = resolves.filter(function (a) { return R.ALLERGENS.includes(a); });
    var diets = resolves.filter(function (a) { return R.DIETARY.includes(a); });
    return [allergens.length ? "takes out " + allergens.join(", ") : "",
      diets.length ? "makes it " + diets.join(" and ").toLowerCase() : ""].filter(Boolean).join("; ");
  }

  function orderAllergens(list) {
    return R.ALL_FILTERS.filter(function (a) { return list.includes(a); });
  }

  function toggleIn(list, value) {
    return list.includes(value) ? list.filter(function (v) { return v !== value; }) : orderAllergens(list.concat(value));
  }

  /** Allergen tags for detected ingredients; the tooltip names the word that was found. */
  function detectedTags(hits) {
    return hits.map(function (x) {
      var maybe = x.level === "possible";
      return h("span", { class: "tag " + (maybe ? "maybe" : "hit"), title: (maybe ? "May contain " : "Contains ") + x.allergen + ": “" + x.word + "”" },
        x.allergen + (maybe ? "?" : ""));
    });
  }

  function modal(title, body, actions) {
    var dlg = h("dialog", { class: "m-dialog", "aria-label": title },
      h("div", { class: "m-dialog-head" }, h("h2", null, title),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: function () { dlg.close(); } }, icon("close", 18))),
      h("div", { class: "m-dialog-body" }, body),
      actions ? h("div", { class: "m-dialog-actions" }, actions) : null);
    dlg.addEventListener("close", function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    return dlg;
  }

  function confirmDialog(title, message, confirmLabel, danger) {
    return new Promise(function (resolve) {
      var ok = false;
      var dlg = modal(title, typeof message === "string" ? h("p", null, message) : message, [
        button("Cancel", function () { dlg.close(); }, "secondary"),
        button(confirmLabel, function () { ok = true; dlg.close(); }, danger ? "danger" : "primary"),
      ]);
      dlg.addEventListener("close", function () { resolve(ok); });
    });
  }

  /** Split pasted text into ingredients: one per line, or commas outside brackets. */
  function splitIngredients(text) {
    var lines = text.split(/\n+/).map(function (l) { return l.replace(/^[\s\-*•·\d.)]+/, "").trim(); }).filter(Boolean);
    if (lines.length > 1) return lines;
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === "(" || ch === "[") depth++;
      if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      if ((ch === "," || ch === ";") && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    out.push(cur.trim());
    return out.filter(Boolean);
  }

  /** Grow a textarea to fit its text (CSS field-sizing where supported). */
  function autoGrow(el) {
    if (CSS.supports && CSS.supports("field-sizing", "content")) return el;
    requestAnimationFrame(function () { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; });
    return el;
  }

  function sharedList() {
    return state.menu ? state.menu.shared : [];
  }

  /** Ingredients used on other dishes (not shared ones), most used first. */
  function knownIngredients() {
    var count = new Map();
    (state.menu ? state.menu.dishes : []).forEach(function (d) {
      d.ingredients.forEach(function (i) {
        if (!S.linkedShared(i, sharedList())) count.set(i, (count.get(i) || 0) + 1);
      });
    });
    return Array.from(count.keys()).sort(function (a, b) { return count.get(b) - count.get(a) || a.localeCompare(b); });
  }

  /** Categories in menu order (the order staff see them in). */
  function categories() {
    var out = [];
    (state.menu ? state.menu.dishes : []).forEach(function (d) { if (d.category && out.indexOf(d.category) < 0) out.push(d.category); });
    return out;
  }

  // ---------- Sign in ----------
  // Steps: username + password → (new password) → (set up authenticator app
  // → save recovery codes) → 6-digit code. The server decides the next step.

  function rememberedUser() {
    try { return localStorage.getItem("hr-manager-user") || ""; } catch (e) { return ""; }
  }

  function loginCard(title, intro, fields, submitLabel, onSubmit, extra) {
    var errorEl = h("p", { class: "form-error", role: "alert" });
    var submit = h("button", { type: "submit", class: "btn primary wide" }, submitLabel);
    var form = h("form", { class: "login-card", onsubmit: function (e) {
      e.preventDefault();
      submit.disabled = true;
      errorEl.textContent = "";
      Promise.resolve(onSubmit()).catch(function (err) {
        if (err && err.body && err.body.restart) { showLogin(); return; }
        errorEl.textContent = (err && err.message) || "Something went wrong.";
      }).then(function () { submit.disabled = false; });
    } },
      h("img", { src: "../hard-rock-logo.png", alt: "Hard Rock Cafe", width: "163", height: "100", class: "login-logo" }),
      h("h1", null, title),
      intro ? h("p", { class: "muted" }, intro) : null,
      fields, errorEl, submit, extra || null,
      h("a", { class: "text-link", href: "../" }, "← Back to the staff guide"));
    stopPolling();
    state.dirty = false;
    replace(app, h("main", { class: "login-wrap" }, form));
    var first = form.querySelector("input:not([value]), input");
    if (first) first.focus();
    return form;
  }

  function field(id, label, attrs, hint) {
    var input = h("input", Object.assign({ id: id, required: true, maxlength: "200" }, attrs));
    return { input: input, nodes: [h("label", { for: id }, label), input, hint ? h("p", { class: "hint" }, hint) : null] };
  }

  function codeField() {
    return field("login-code", "6-digit code from your authenticator app",
      { inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9 ]{6,7}", maxlength: "7" });
  }

  // Ends a half-finished sign-in, e.g. to use a different account.
  function startAgain() {
    return h("button", { type: "button", class: "text-link", onclick: function () {
      api("POST", "/logout", {}).catch(function () { /* the sign-in screen shows anyway */ }).then(function () { showLogin(); });
    } }, "Not you? Start again");
  }

  function afterStep(res) {
    if (res.next === "password") return newPasswordScreen(res.name);
    if (res.next === "enroll") return enrollScreen();
    if (res.next === "code") return codeScreen(res.name);
    return start();
  }

  function showLogin(info) {
    info = info || {};
    state.session = null;
    if (info.setupNeeded) return setupNeededScreen(info.missing && info.missing.length ? info.missing : ["SESSION_SECRET", "DATA_ENCRYPTION_KEY"]);
    if (info.firstRun && info.missing && info.missing.length) return setupNeededScreen(info.missing);
    if (info.firstRun) return setupScreen();
    // A sign-in was under way (the phone reloaded the page while the
    // authenticator app was open): carry on at the same step.
    if (info.resume && !info.expired) return afterStep(info.resume);
    var user = field("login-user", "Username", { autocomplete: "username", maxlength: "80", value: rememberedUser(), autocapitalize: "none", spellcheck: "false" });
    var pw = field("login-pw", "Password", { type: "password", autocomplete: "current-password" });
    loginCard("Menu manager", "Sign in with your own account.",
      [info.expired ? h("div", { class: "notice" }, icon("info", 18),
        h("p", null, "You were signed out after a period without activity. Sign in again to carry on." +
          (hasStash() ? " Your unsaved changes are kept." : ""))) : null,
       user.nodes, pw.nodes],
      "Continue", function () {
        return api("POST", "/login", { username: user.input.value, password: pw.input.value }).then(function (res) {
          try { localStorage.setItem("hr-manager-user", user.input.value.trim().toLowerCase()); } catch (e) { /* private mode */ }
          return afterStep(res);
        }, function (err) { pw.input.value = ""; throw err; });
      }, [h("p", { class: "hint" }, "Forgotten your password, or locked out? Ask an owner to reset it on the Team page."),
        info.ownerReset ? h("button", { type: "button", class: "text-link", onclick: ownerResetScreen }, "No owner can sign in? Use the emergency reset") : null]);
    if (user.input.value) pw.input.focus();
  }

  // Emergency owner reset: only offered while OWNER_RESET_CODE is set in Netlify.
  function ownerResetScreen() {
    var code = field("reset-code", "Emergency reset code", { type: "password", autocomplete: "off" }, "The value you added in Netlify as OWNER_RESET_CODE. It works once.");
    var name = field("reset-name", "Your name", { autocomplete: "name", maxlength: "40" });
    var user = field("reset-user", "Username", { autocomplete: "username", maxlength: "32", autocapitalize: "none", spellcheck: "false" },
      "Your old username, or a new one. 3-32 letters, numbers, dots or dashes, no @. E.g. aoife.m");
    var pw = field("reset-pw", "New password", { type: "password", autocomplete: "new-password", minlength: "12" }, "At least 12 characters. A few random words works well.");
    loginCard("Emergency owner reset", "Use this only when no owner can sign in. You'll be an owner with this password, and you'll set up the authenticator app again.",
      [code.nodes, name.nodes, user.nodes, pw.nodes], "Reset and continue", function () {
        return api("POST", "/reset-owner", { resetCode: code.input.value, name: name.input.value, username: user.input.value, password: pw.input.value }).then(function (res) {
          try { localStorage.setItem("hr-manager-user", user.input.value.trim().toLowerCase()); } catch (e) { /* private mode */ }
          toast("Done. Now remove OWNER_RESET_CODE in Netlify.");
          return afterStep(res);
        });
      }, h("button", { type: "button", class: "text-link", onclick: function () { start(); } }, "Cancel"));
  }

  // ---------- First-time setup ----------
  // Shown until the Netlify settings exist. The values are made in this
  // browser with crypto.getRandomValues and never sent anywhere; the owner
  // copies them into Netlify.

  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function randomSetupCode() {
    var letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, so b % 32 is unbiased
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, function (b) { return letters[b % 32]; }).join("").match(/.{4}/g).join("-");
  }

  var SETTINGS = {
    SESSION_SECRET: { make: function () { return randomHex(32); }, about: "Keeps sign-ins secure." },
    DATA_ENCRYPTION_KEY: { make: function () { return randomHex(32); },
      about: "Protects the two-step sign-in keys. Also keep a copy somewhere safe, such as a password manager." },
    MANAGER_SETUP_CODE: { make: randomSetupCode, about: "A one-off code. You type it on the next screen to create the owner account." },
  };

  function copyButton(getText) {
    var label = h("span", null, "Copy");
    var failed = function () { toast("Copying didn't work here. Select the text and copy it instead.", "error"); };
    return button([icon("copy", 15), label], function () {
      var text = getText();
      if (!text) return;
      if (!navigator.clipboard) return failed();
      navigator.clipboard.writeText(text).then(function () {
        label.textContent = "Copied";
        setTimeout(function () { label.textContent = "Copy"; }, 2000);
      }, failed);
    }, "small");
  }

  function setupNeededScreen(missing) {
    var rows = missing.filter(function (name) { return SETTINGS[name]; }).map(function (name) {
      var value = h("code", { class: "secret setting-value" }, "Press “Create the values” below");
      return { name: name, value: value, el: h("div", { class: "setting" },
        h("div", { class: "setting-head" }, h("strong", null, name), copyButton(function () { return value.dataset.made ? value.textContent : ""; })),
        h("p", { class: "hint" }, SETTINGS[name].about), value) };
    });
    var makeBtn = button([icon("lock", 16), "Create the values"], function () {
      rows.forEach(function (r) { r.value.textContent = SETTINGS[r.name].make(); r.value.dataset.made = "1"; });
      makeBtn.hidden = true;
    }, "primary wide");
    stopPolling();
    state.dirty = false;
    replace(app, h("main", { class: "login-wrap" }, h("div", { class: "login-card setup-card" },
      h("img", { src: "../hard-rock-logo.png", alt: "Hard Rock Cafe", width: "163", height: "100", class: "login-logo" }),
      h("h1", null, "Finish the setup in Netlify"),
      h("p", { class: "muted" }, "Before anyone can sign in, Netlify needs " + (rows.length === 1 ? "one setting" : "these settings") +
        ". This is done once, by the person who looks after the Netlify account."),
      h("ol", { class: "steps" },
        h("li", null, "Press ", h("strong", null, "Create the values"), ". They are made on this computer and not sent anywhere."),
        h("li", null, "In Netlify, open this project, then ", h("strong", null, "Project configuration → Environment variables → Add a variable"),
          ". Add each name below with its value."),
        h("li", null, "Open ", h("strong", null, "Deploys → Trigger deploy → Deploy project"), ". When the deploy shows ", h("strong", null, "Published"), ", reload this page.")),
      rows.map(function (r) { return r.el; }),
      makeBtn,
      missing.indexOf("DATA_ENCRYPTION_KEY") >= 0 ? h("div", { class: "warning" }, icon("alert", 18),
        h("p", null, "Set these up before? Use the values you saved then, not new ones. A new DATA_ENCRYPTION_KEY means everyone sets up two-step sign-in again.")) : null,
      h("a", { class: "text-link", href: "../" }, "← Back to the staff guide"))));
  }

  function setupScreen() {
    var code = field("setup-code", "Setup code", { type: "password", autocomplete: "off" }, "The code you added in Netlify as MANAGER_SETUP_CODE. Only needed this once.");
    var name = field("setup-name", "Your name", { autocomplete: "name", maxlength: "40" });
    var user = field("setup-user", "Choose a username", { autocomplete: "username", maxlength: "32", autocapitalize: "none", spellcheck: "false" }, "3-32 letters, numbers, dots or dashes, e.g. aoife.m");
    var pw = field("setup-pw", "Choose a password", { type: "password", autocomplete: "new-password", minlength: "12" }, "At least 12 characters. A few random words works well.");
    loginCard("Create the owner account", "This is the first sign-in. The owner adds everyone else from the Team page.",
      [code.nodes, name.nodes, user.nodes, pw.nodes], "Create account", function () {
        return api("POST", "/setup", { setupCode: code.input.value, name: name.input.value, username: user.input.value, password: pw.input.value }).then(function (res) {
          try { localStorage.setItem("hr-manager-user", user.input.value.trim().toLowerCase()); } catch (e) { /* private mode */ }
          return afterStep(res);
        });
      });
  }

  function newPasswordScreen(name) {
    var pw = field("new-pw", "New password", { type: "password", autocomplete: "new-password", minlength: "12" }, "At least 12 characters. Don't reuse the temporary one or a password from another site.");
    var again = field("new-pw2", "Type it again", { type: "password", autocomplete: "new-password" });
    loginCard("Choose your password", "Welcome" + (name ? ", " + name : "") + ". Replace the temporary password you were given.",
      [pw.nodes, again.nodes], "Save password", function () {
        if (pw.input.value !== again.input.value) return Promise.reject(new ApiError(400, { error: "The two passwords don't match." }));
        return api("POST", "/login/password", { password: pw.input.value }).then(afterStep);
      }, startAgain());
  }

  function qrSvg(qr) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    var n = qr.size + 8;
    svg.setAttribute("viewBox", "0 0 " + n + " " + n);
    svg.setAttribute("class", "qr");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "QR code for your authenticator app");
    svg.setAttribute("shape-rendering", "crispEdges");
    var bg = document.createElementNS(NS, "rect");
    bg.setAttribute("width", n); bg.setAttribute("height", n); bg.setAttribute("fill", "#fff");
    svg.appendChild(bg);
    var d = "";
    for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++) {
      if (qr.bits[y * qr.size + x] === "1") d += "M" + (x + 4) + " " + (y + 4) + "h1v1h-1z";
    }
    var path = document.createElementNS(NS, "path");
    path.setAttribute("d", d); path.setAttribute("fill", "#000");
    svg.appendChild(path);
    return svg;
  }

  function enrollScreen() {
    replace(app, h("main", { class: "login-wrap" }, h("div", { class: "login-card" }, h("p", { class: "muted" }, "Preparing two-step sign-in…"))));
    api("POST", "/login/enroll", {}).then(function (setup) {
      var code = codeField();
      var key = setup.secret.replace(/(.{4})/g, "$1 ").trim();
      loginCard("Set up two-step sign-in",
        "Each time you sign in, you also type a code from an app on your phone. This keeps the allergen guide safe even if someone learns your password.",
        [h("ol", { class: "steps" },
           h("li", null, "On your phone, install a free authenticator app, such as ", h("strong", null, "Microsoft Authenticator"), " or ",
             h("strong", null, "Google Authenticator"), " (App Store or Google Play)."),
           h("li", null, "Open the app, tap ", h("strong", null, "+"), " and choose ", h("strong", null, "Scan a QR code"), "."),
           h("li", null, "Point the phone's camera at this square."),
           h("li", null, "The app now shows ", h("strong", null, "HRC Dublin Allergens"), " with a 6-digit code. Type it below and press ", h("strong", null, "Confirm"), ".")),
         h("div", { class: "qr-wrap" }, qrSvg(setup.qr)),
         h("details", { class: "qr-manual" }, h("summary", null, "Using this phone, or can't scan? Type a key instead"),
           h("p", { class: "hint" }, "In the app choose “Enter a setup key” (or “Enter code manually”), give it any name, and type or paste this key:"),
           h("code", { class: "secret" }, key),
           copyButton(function () { return setup.secret; })),
         code.nodes,
         h("p", { class: "hint" }, "The code changes every 30 seconds. If it is not accepted, wait for the next one.")],
        "Confirm", function () {
          return api("POST", "/login/enroll/confirm", { code: code.input.value }).then(function (res) { recoveryScreen(res.recoveryCodes, start); });
        }, startAgain());
    }).catch(function (err) {
      if (err.body && err.body.restart) return showLogin();
      toast(err.message, "error");
    });
  }

  function recoveryList(codes) {
    return h("ol", { class: "recovery-codes" }, codes.map(function (c) { return h("li", null, h("code", null, c)); }));
  }

  function downloadText(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    var a = h("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function recoveryScreen(codes, done) {
    var saved = h("input", { type: "checkbox", id: "codes-saved" });
    loginCard("Save your recovery codes",
      "If you lose your phone, type one of these codes instead of the 6-digit code. Each one works once. Download or print them and keep them somewhere safe, not on your phone. They won't be shown again.",
      [recoveryList(codes),
       h("div", { class: "head-actions" },
         button([icon("download", 16), "Download"], function () {
           downloadText("allergen-guide-recovery-codes.txt", "Hard Rock Cafe Dublin allergen guide: recovery codes\nEach code works once.\n\n" + codes.join("\n") + "\n");
         }, "secondary small"),
         button([icon("printer", 16), "Print"], function () { window.print(); }, "secondary small")),
       h("label", { class: "check-row", for: "codes-saved" }, saved, " I've saved these codes")],
      "Continue", function () {
        if (!saved.checked) return Promise.reject(new ApiError(400, { error: "Tick the box once you've saved the codes." }));
        return done();
      });
  }

  function codeScreen(name) {
    var useRecovery = false;
    var code = codeField();
    var rec = field("login-recovery", "Recovery code", { autocomplete: "off", maxlength: "20", autocapitalize: "none", spellcheck: "false" });
    var codeBox = h("div", { class: "stack" }, code.nodes);
    var recBox = h("div", { class: "stack", hidden: true }, rec.nodes);
    rec.input.required = false;
    var toggle = h("button", { type: "button", class: "text-link", onclick: function () {
      useRecovery = !useRecovery;
      codeBox.hidden = useRecovery; recBox.hidden = !useRecovery;
      code.input.required = !useRecovery; rec.input.required = useRecovery;
      toggle.textContent = useRecovery ? "Use the authenticator app instead" : "Lost your phone? Use a recovery code";
      (useRecovery ? rec.input : code.input).focus();
    } }, "Lost your phone? Use a recovery code");
    loginCard("Enter your code", (name ? name + ", open" : "Open") + " your authenticator app and type the 6-digit code for the allergen guide.",
      [codeBox, recBox], "Sign in", function () {
        var body = useRecovery ? { recoveryCode: rec.input.value } : { code: code.input.value };
        return api("POST", "/login/verify", body).then(function (res) {
          if (res.recoveryCodesLeft !== undefined) toast("Recovery code used. " + res.recoveryCodesLeft + " left. Make new ones in My account.", "error");
          return start();
        });
      }, [toggle, startAgain()]);
  }

  // ---------- Shell ----------

  // [hash, label, icon, permission needed]
  var NAV = [
    ["#/dishes", "Dishes", "list", "view"],
    ["#/shared", "Shared ingredients", "layers", "view"],
    ["#/activity", "Activity", "history", "view"],
    ["#/team", "Team", "users", "admin"],
    ["#/help", "Help", "help", "view"],
  ];

  function can(permission) {
    return !!(state.session && state.session.can && state.session.can.indexOf(permission) >= 0);
  }

  var navEl, mainEl;

  function renderShell() {
    navEl = h("nav", { class: "m-nav", "aria-label": "Manager sections" });
    mainEl = h("main", { class: "m-main", id: "main", tabindex: "-1" });
    replace(app,
      h("header", { class: "topbar" },
        h("div", { class: "topbar-inner" },
          h("a", { class: "brand", href: "#/dishes" },
            h("img", { src: "../hard-rock-logo.png", alt: "Hard Rock Cafe", width: "163", height: "100" }),
            h("span", { class: "brand-text" }, "DUBLIN", h("small", null, "Menu manager"))),
          h("div", { class: "m-user" },
            h("a", { class: "btn ghost small", href: "../", target: "_blank", rel: "noopener", "aria-label": "Open the staff guide" }, icon("eye", 16), h("span", { class: "lbl" }, "Staff guide")),
            h("a", { class: "m-name", href: "#/account", title: "My account" }, icon("user", 15), state.session.name,
              h("span", { class: "role-badge" }, state.session.roleLabel)),
            h("button", { type: "button", class: "btn ghost small", onclick: signOut, "aria-label": "Sign out" }, icon("logout", 16), h("span", { class: "lbl" }, "Sign out"))))),
      navEl, mainEl);
    renderNav();
  }

  function renderNav() {
    if (!navEl) return;
    var current = "#/" + (location.hash.split("/")[1] || "dishes");
    if (current === "#/dish" || current === "#/new" || current === "#/old") current = "#/dishes";
    if (current === "#/import") current = "#/help";
    replace(navEl, h("div", { class: "m-nav-inner" }, NAV.filter(function (n) { return can(n[3]); }).map(function (n) {
      return h("a", { href: n[0], class: current === n[0] ? "active" : "", "aria-current": current === n[0] ? "page" : null },
        icon(n[2], 16), n[1]);
    })));
  }

  function signOut() {
    api("POST", "/logout", {}).catch(function () {}).then(function () { state.session = null; showLogin(); });
  }

  // ---------- Router ----------

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  var lastHash = location.hash;

  function onRoute() {
    if (state.dirty && location.hash !== lastHash) {
      if (!window.confirm("You have unsaved changes to this dish. Leave without saving?")) {
        history.replaceState(null, "", lastHash);
        return;
      }
      state.dirty = false;
    }
    lastHash = location.hash;
    stopPolling();
    state.stash = null;
    if (!state.session) return;
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    var view = parts[0] || "dishes";
    renderNav();
    window.scrollTo(0, 0);
    if (view === "dish" && parts[1]) return editorView(decodeURIComponent(parts[1]));
    if (view === "new") return editorView(null);
    if (view === "old" && parts[1]) return oldChangeView(decodeURIComponent(parts[1]));
    if (view === "import" && parts[1]) return importJobView(parts[1]);
    if (view === "shared") return sharedView(parts[1] ? decodeURIComponent(parts[1]) : null);
    if (view === "activity") return activityView();
    if (view === "account") return accountView();
    if (view === "help") return helpView(parts[1]);
    if (view === "team" && can("admin")) return teamView();
    return dishesView();
  }

  window.addEventListener("hashchange", onRoute);
  window.addEventListener("beforeunload", function (e) {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  function setMain() {
    var args = Array.prototype.slice.call(arguments);
    replace.apply(null, [mainEl].concat(args));
  }

  // ---------- Dishes list ----------

  function needsAttention(d) {
    return S.openDangers(d).length > 0;
  }

  /** Corrections that came with an app update, offered once. */
  function appUpdatesBanner() {
    var list = state.menu.appUpdates || [];
    if (!list.length || !can("edit")) return null;
    return h("div", { class: "banner" }, icon("info", 18),
      h("div", null,
        h("p", null, h("strong", null, "The app has updated information for " + plural(list.length, "dish", "dishes") + ": "),
          list.slice(0, 4).map(function (u) { return u.name; }).join(", ") + (list.length > 4 ? " and " + (list.length - 4) + " more." : ".")),
        button("Review", reviewAppUpdates, "small primary")));
  }

  function reviewAppUpdates() {
    var list = state.menu.appUpdates || [];
    var choice = {};
    list.forEach(function (u) { choice[u.id] = "apply"; });
    var rows = list.map(function (u) {
      var name = "app-update-" + u.id;
      return h("div", { class: "update-row" },
        h("strong", null, u.name),
        h("ul", { class: "change-lines" }, (u.changes.length ? u.changes : ["Wording only"]).map(function (c) { return h("li", null, c); })),
        h("div", { class: "seg", role: "radiogroup", "aria-label": u.name },
          [["apply", "Use the update"], ["keep", "Keep mine"]].map(function (opt) {
            var b = h("button", { type: "button", role: "radio", class: "seg-btn" + (opt[0] === "apply" ? " on choice" : ""), "aria-checked": opt[0] === "apply" ? "true" : "false", name: name,
              onclick: function () {
                choice[u.id] = opt[0];
                b.parentNode.querySelectorAll("button").forEach(function (x) { x.classList.remove("on", "choice"); x.setAttribute("aria-checked", "false"); });
                b.classList.add("on", "choice");
                b.setAttribute("aria-checked", "true");
              } }, opt[1]);
            return b;
          })));
    });
    var dlg = modal("Updates from the app", [
      h("p", { class: "muted" }, "These dishes were corrected in the app. Choose which updates to use. Staff see them as soon as you save."),
      rows,
    ], [
      button("Not now", function () { dlg.close(); }, "secondary"),
      button("Save", function () {
        var apply = list.filter(function (u) { return choice[u.id] === "apply"; }).map(function (u) { return u.id; });
        var keep = list.filter(function (u) { return choice[u.id] === "keep"; }).map(function (u) { return u.id; });
        api("POST", "/app-updates", { apply: apply, keep: keep }).then(function (res) {
          dlg.close();
          toast(res.applied ? plural(res.applied, "dish", "dishes") + " updated." : "Saved. Your versions are kept.");
          return refreshMenu().then(dishesView);
        }).catch(showError);
      }, "primary"),
    ]);
  }

  /** Changes saved before saving went live directly, which never reached staff. */
  function oldChangesBanner() {
    var list = state.menu.oldChanges || [];
    if (!list.length || !can("edit")) return null;
    return h("div", { class: "banner caution" }, icon("alert", 18),
      h("div", null,
        h("p", null, h("strong", null, plural(list.length, "dish", "dishes") + (list.length === 1 ? " has" : " have") + " changes saved before this update that staff never saw. "),
          "Open each one to check it and press Save, or remove them."),
        h("p", { class: "old-list" }, list.map(function (c, i) {
          return [i ? ", " : "", h("a", { href: "#/old/" + encodeURIComponent(c.id) }, c.name), c.kind === "deleted" ? " (deleted)" : c.kind === "new" ? " (new)" : ""];
        })),
        button("Remove these changes", function () {
          confirmDialog("Remove the older changes?", "They were never shown to staff. The menu stays exactly as it is now.", "Remove", true).then(function (ok) {
            if (!ok) return;
            api("POST", "/old-changes/discard", {}).then(function () { toast("Removed."); return refreshMenu().then(dishesView); }).catch(showError);
          });
        }, "small secondary")));
  }

  function dishesView() {
    var dishes = state.menu.dishes;
    var attention = new Set(dishes.filter(needsAttention).map(function (d) { return d.id; }));
    var archivedCount = dishes.filter(function (d) { return d.archived; }).length;
    var f = state.dishFilter;
    if (f.show === "attention" && !attention.size) f.show = "all";
    if (f.show === "archived" && !archivedCount) f.show = "all";
    var listEl = h("div", { class: "dish-list", role: "list" });
    var countEl = h("p", { class: "muted", "aria-live": "polite" });

    function matches(d) {
      if (f.category && d.category !== f.category) return false;
      if (f.show === "attention" && !attention.has(d.id)) return false;
      if (f.show === "archived" && !d.archived) return false;
      if (f.q) {
        var hay = R.normalise(d.name + " " + d.category + " " + d.ingredients.join(" "));
        return R.normalise(f.q).split(" ").every(function (w) { return hay.includes(w); });
      }
      return true;
    }

    function drawList() {
      var shown = dishes.filter(matches);
      countEl.textContent = shown.length === dishes.length ? plural(dishes.length, "dish", "dishes") : shown.length + " of " + dishes.length + " dishes";
      replace(listEl, shown.length ? shown.map(function (d) {
        var bad = attention.has(d.id);
        return h("a", { class: "dish-row" + (bad ? " has-danger" : "") + (d.archived ? " is-archived" : ""), href: "#/dish/" + encodeURIComponent(d.id), role: "listitem" },
          h("div", { class: "dish-row-main" },
            h("span", { class: "category" }, d.category),
            h("strong", null, d.name),
            h("div", { class: "tags" },
              d.vegan ? h("span", { class: "tag diet" }, "Vegan") : d.vegetarian ? h("span", { class: "tag diet" }, "Vegetarian") : null,
              d.contains.map(function (a) { return h("span", { class: "tag" }, a); }),
              d.possible.map(function (a) { return h("span", { class: "tag maybe" }, a + "?"); }))),
          h("div", { class: "dish-row-status" },
            d.archived ? h("span", { class: "status neutral" }, icon("archive", 13), "Archived") : null,
            bad ? h("span", { class: "status danger" }, icon("alert", 13), "Needs attention") : null,
            icon("chevron", 18)));
      }) : h("p", { class: "empty" }, "No dishes match these filters."));
    }

    function showChip(key, label) {
      return chipToggle(label, f.show === key, function () { f.show = f.show === key ? "all" : key; dishesView(); });
    }

    var search = h("input", { type: "search", placeholder: "Search dishes or ingredients…", value: f.q, "aria-label": "Search dishes",
      oninput: function () { f.q = search.value; drawList(); } });
    var catSelect = h("select", { "aria-label": "Category", onchange: function () { f.category = catSelect.value; drawList(); } },
      h("option", { value: "" }, "All categories"),
      categories().map(function (c) { return h("option", { value: c, selected: c === f.category }, c); }));

    setMain(
      h("div", { class: "m-head" },
        h("div", null, h("h1", null, "Dishes")),
        can("edit") ? h("a", { class: "btn primary", href: "#/new" }, icon("plus", 16), "Add dish") : null),
      oldChangesBanner(),
      appUpdatesBanner(),
      h("div", { class: "m-filters" },
        h("div", { class: "input-wrap" }, icon("search", 18), search), catSelect,
        attention.size || archivedCount ? h("div", { class: "chips filter-chips" },
          attention.size ? showChip("attention", "Needs attention (" + attention.size + ")") : null,
          archivedCount ? showChip("archived", "Archived (" + archivedCount + ")") : null) : null),
      countEl, listEl);
    drawList();
  }

  // ---------- Dish editor ----------

  function blankDish() {
    return { id: "", name: "", category: "", description: "", vegan: false, vegetarian: false, contains: [], possible: [], crossContact: [],
      crossContactNote: "", ingredients: [], modifications: [], chefChecks: [], noChangesFor: [], evidence: "", notes: "", archived: false, confirmedFree: [] };
  }

  /** Opens a dish with the change that was saved before the update (never shown to staff). */
  function oldChangeView(id) {
    var info = (state.menu.oldChanges || []).find(function (c) { return c.id === id; });
    if (!info) { location.hash = "#/dishes"; return; }
    if (info.kind === "deleted") return editorView(id, { oldId: id, oldDeleted: true });
    setMain(h("p", { class: "muted" }, "Loading…"));
    api("GET", "/old-changes/" + encodeURIComponent(id)).then(function (res) {
      editorView(info.kind === "new" ? null : id, { oldId: id, oldDish: res.dish });
    }).catch(function (err) { showError(err); location.hash = "#/dishes"; });
  }

  function editorView(id, opts) {
    opts = opts || {};
    var original = id ? state.menu.dishes.find(function (d) { return d.id === id; }) : null;
    if (id && !original) {
      setMain(h("div", { class: "empty" }, h("p", null, "That dish is not on the menu any more."), h("a", { class: "btn", href: "#/dishes" }, "Back to dishes")));
      return;
    }
    var ed = structuredClone(opts.oldDish || original || blankDish());
    if (!id) ed.id = "";
    ed.confirmedFree = ed.confirmedFree || [];
    var baseStamp = id && state.menu.meta[id] ? state.menu.meta[id].at : null;
    var restored = opts.oldDish ? null : takeStash(id);
    if (restored) { ed = restored.dish; baseStamp = restored.baseStamp; }
    ed.modifications.forEach(function (m) { trackAdds(m); });
    state.stash = function () { return { id: id || "", dish: currentDish(), baseStamp: baseStamp }; };

    var categoryTouched = !!id || !!ed.category;
    var categoryNote = "";
    var autoAdded = [];
    var problemsEl = h("div");
    var liveEls = { checks: h("div", { class: "warnings" }), preview: h("div", { class: "staff-card" }), rowTags: [], allergenHints: {}, catSelect: null, catCustom: null, catHint: null, autoNote: null };
    var bodyEl = h("div", { class: "editor-main" });
    var saveBtn;
    var mSave = h("button", { type: "button", class: "btn primary", onclick: function () {
      if (mSave.classList.contains("blocked")) { liveEls.checks.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      save();
    } }, "Save");

    function markDirty() {
      state.dirty = true;
      refreshLive();
    }

    // Live panels update on every keystroke without rebuilding the form.
    var liveTimer = null;
    function refreshLive() {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(drawLive, 120);
    }

    /** A recipe change keeps what the swap brings in separately from what's left over. */
    function trackAdds(m) {
      var recorded = ed.contains.concat(ed.possible);
      m.adds = m.adds || m.remaining.filter(function (a) { return !recorded.includes(a) && !m.resolves.includes(a); });
    }

    function syncRemaining(m) {
      var recorded = ed.contains.concat(ed.possible);
      m.remaining = R.ALL_FILTERS.filter(function (a) {
        return !m.resolves.includes(a) && (recorded.includes(a) || (m.adds || []).includes(a));
      });
    }

    function currentDish() {
      var d = structuredClone(ed);
      d.ingredients = d.ingredients.map(function (i) { return i.trim(); }).filter(Boolean);
      d.modifications.forEach(function (m) { syncRemaining(m); delete m.adds; });
      return d;
    }

    /** After ingredients change: link shared ingredients and record what they bring in. */
    function ingredientsChanged(before) {
      ed.ingredients = ed.ingredients.map(function (i) { return i.replace(/\s+/g, " ").trim(); }).filter(Boolean);
      var res = S.applyShared(ed, sharedList(), { beforeIngredients: before });
      res.added.forEach(function (a) {
        if (!autoAdded.some(function (x) { return x.allergen === a.allergen && x.diet === a.diet; })) autoAdded.push(a);
      });
      state.dirty = true;
      autoCategory();
      drawForm();
    }

    function autoCategory() {
      if (categoryTouched || id) return;
      var suggestion = S.suggestCategory(ed, state.menu.dishes);
      if (suggestion && suggestion !== ed.category) {
        ed.category = suggestion;
        categoryNote = "Picked from the dish. Change it if it's wrong.";
        if (liveEls.catSelect) {
          liveEls.catSelect.value = suggestion;
          liveEls.catCustom.hidden = true;
          liveEls.catHint.textContent = categoryNote;
        }
      }
    }

    function fixButton(w) {
      var f = w.fix;
      if (!f) return null;
      if (f.action === "contains") return button("Record " + f.allergen, function () { record(f.allergen, "contains"); }, "small");
      if (f.action === "possible") return button("Mark as may contain", function () { record(f.allergen, "possible"); }, "small");
      if (f.action === "notVegan") return button("Not vegan", function () { ed.vegan = false; state.dirty = true; drawForm(); }, "small");
      if (f.action === "notVegetarian") return button("Not vegetarian", function () { ed.vegetarian = false; ed.vegan = false; state.dirty = true; drawForm(); }, "small");
      return null;
    }

    function record(allergen, level) {
      ed.contains = ed.contains.filter(function (x) { return x !== allergen; });
      ed.possible = ed.possible.filter(function (x) { return x !== allergen; });
      if (level === "contains") ed.contains = orderAllergens(ed.contains.concat(allergen));
      if (level === "possible") ed.possible = orderAllergens(ed.possible.concat(allergen));
      state.dirty = true;
      drawForm();
    }

    /** Recorded allergen with no ingredient carrying it: add the ingredient it comes from. */
    function askSource(allergen) {
      var possible = !ed.contains.includes(allergen);
      var input = h("input", { id: "allergen-source", maxlength: "120", placeholder: "e.g. Egg wash on the bun", autocomplete: "off" });
      function add() {
        var text = input.value.replace(/\s+/g, " ").trim();
        if (!text) { input.focus(); return; }
        var carries = R.detectAllergens([text]).some(function (x) { return x.allergen === allergen && (possible || x.level === "contains"); });
        var before = ed.ingredients.slice();
        ed.ingredients = ed.ingredients.concat(carries ? text : text + " (" + (possible ? "may contain " : "contains ") + allergen.toLowerCase() + ")");
        dlg.close();
        ingredientsChanged(before);
      }
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); add(); } });
      var dlg = modal("Where does the " + allergen.toLowerCase() + " come from?", [
        h("div", { class: "field" },
          h("label", { for: "allergen-source" }, "Ingredient"),
          input,
          h("p", { class: "hint" }, "Type the ingredient it comes from. It is added to the ingredients as “… (" + (possible ? "may contain " : "contains ") + allergen.toLowerCase() + ")”, so staff can see where it comes from.")),
      ], [button("Cancel", function () { dlg.close(); }), button("Add ingredient", add, "primary")]);
      input.focus();
    }

    function confirmFree(key, on) {
      ed.confirmedFree = on ? ed.confirmedFree.concat(key) : ed.confirmedFree.filter(function (k) { return k !== key; });
      state.dirty = true;
      drawForm();
    }

    function drawLive() {
      var d = currentDish();
      var warnings = S.reviewWarnings(d);
      var dangers = warnings.filter(function (w) { return w.level === "danger"; });
      var confirmed = warnings.filter(function (w) { return w.confirmed; });
      var notes = warnings.filter(function (w) { return w.level === "info" && !w.confirmed; });
      var shown = warnings.filter(function (w) { return w.level !== "info"; });

      replace(liveEls.checks,
        !shown.length ? h("p", { class: "all-clear" }, icon("check", 16), "No problems found.") : null,
        shown.map(function (w) {
          return h("div", { class: "warn " + w.level },
            icon(w.level === "danger" ? "alert" : "info", 16),
            h("div", null,
              h("p", null, w.message),
              h("div", { class: "warn-actions" },
                fixButton(w),
                w.key ? button(w.level === "danger" ? "Kitchen confirmed: not in this dish" : "Checked: not in this dish",
                  function () { confirmFree(w.key, true); }, "small link") : null)));
        }),
        confirmed.map(function (w) {
          return h("p", { class: "confirmed-line" }, icon("check", 14), h("span", null, w.message),
            button("Undo", function () { confirmFree(w.key, false); }, "small link"));
        }),
        notes.length ? h("details", { class: "infos" }, h("summary", null, plural(notes.length, "note")),
          notes.map(function (w) { return h("p", { class: "muted" }, w.message); })) : null);

      // Ingredient row tags.
      liveEls.rowTags.forEach(function (el, i) {
        replace(el, detectedTags(R.detectAllergens([ed.ingredients[i] || ""])));
      });

      // "Found in" column of the allergen grid.
      var detected = R.detectedAllergenMap(d.ingredients);
      Object.keys(liveEls.allergenHints).forEach(function (a) {
        var el = liveEls.allergenHints[a];
        var hit = detected[a];
        var recorded = d.contains.includes(a) || d.possible.includes(a);
        el.className = "hint-src" + (hit && !recorded && hit.level === "contains" && !d.confirmedFree.some(function (k) { return k.indexOf(a + "|") === 0; }) ? " missing" : "");
        if (hit) replace(el, (hit.level === "possible" ? "maybe in " : "in ") + S.baseName(hit.ingredients[0]) + (hit.ingredients.length > 1 ? " +" + (hit.ingredients.length - 1) : ""));
        else if (recorded) replace(el, h("button", { type: "button", class: "small-link where-from", onclick: function () { askSource(a); } }, icon("plus", 13), "Where from?"));
        else replace(el);
      });

      drawPreview(d);
      autoCategory();

      [saveBtn, mSave].forEach(function (b) {
        if (!b) return;
        b.textContent = state.dirty || !id ? "Save" : "Saved";
        b.disabled = (!!id && !state.dirty) || dangers.length > 0;
        b.title = dangers.length ? "Fix the red items first" : "";
      });
      // On a phone the checks are further down the page: say why Save is blocked.
      if (dangers.length) {
        mSave.disabled = false;
        mSave.textContent = "Fix " + plural(dangers.length, "red item") + " first";
        mSave.classList.add("blocked");
      } else mSave.classList.remove("blocked");
    }

    /** What staff see for this dish, in brief. */
    function drawPreview(d) {
      function row(label, content) {
        return h("div", { class: "staff-row" }, h("span", { class: "staff-label" }, label), h("div", null, content));
      }
      replace(liveEls.preview,
        d.archived ? h("p", { class: "warn-inline" }, icon("archive", 15), "Archived: staff don't see this dish.") : null,
        row("Contains", d.contains.length ? h("div", { class: "tags" }, d.contains.map(function (a) { return h("span", { class: "tag hit" }, a); })) : h("span", { class: "muted" }, "Nothing recorded")),
        d.possible.length ? row("May contain", h("div", { class: "tags" }, d.possible.map(function (a) { return h("span", { class: "tag maybe" }, a); }))) : null,
        d.crossContact.length ? row("Cross-contact", [h("div", { class: "tags" }, d.crossContact.map(function (a) { return h("span", { class: "tag" }, a); })),
          d.crossContactNote ? h("p", { class: "muted small" }, d.crossContactNote) : null]) : null,
        row("Diet", d.vegan ? "Vegan" : d.vegetarian ? "Vegetarian" : h("span", { class: "muted" }, "Not vegetarian")),
        d.modifications.length ? row("Changes", h("ul", { class: "staff-list" }, d.modifications.map(function (m) {
          return h("li", null, m.instruction || "…", h("span", { class: "muted" }, m.resolves.length ? " (" + modEffect(m.resolves) + ")" : ""));
        }))) : null,
        d.chefChecks.length ? row("Chef checks", h("ul", { class: "staff-list" }, d.chefChecks.map(function (c) {
          return h("li", null, h("strong", null, c.allergens.join(", ") + ": "), c.note || "…");
        }))) : null);
    }

    function fieldWrap(label, input, hint) {
      return h("div", { class: "field" }, h("label", { for: input.id }, label), input, hint ? h("p", { class: "hint" }, hint) : null);
    }

    function textInput(key, attrs) {
      return h("input", Object.assign({ id: "f-" + key, value: ed[key] || "", oninput: function (e) { ed[key] = e.target.value; markDirty(); } }, attrs || {}));
    }

    function textArea(key, rows, attrs) {
      return h("textarea", Object.assign({ id: "f-" + key, rows: String(rows), value: ed[key] || "", oninput: function (e) { ed[key] = e.target.value; markDirty(); } }, attrs || {}));
    }

    function section(title, sub, content, extra) {
      return h("section", { class: "ed-section" }, h("div", { class: "ed-section-head" }, h("h2", null, title), extra || null), sub ? h("p", { class: "muted" }, sub) : null, content);
    }

    function categoryField() {
      var cats = categories();
      var known = !ed.category || cats.includes(ed.category);
      var custom = h("input", { id: "f-category-new", value: known ? "" : ed.category, placeholder: "Name of the new category", hidden: known,
        maxlength: String(S.LIMITS.category), "aria-label": "New category name",
        oninput: function (e) { ed.category = e.target.value; categoryTouched = true; markDirty(); } });
      var hint = h("p", { class: "hint" }, categoryNote);
      var select = h("select", { id: "f-category", onchange: function () {
        categoryTouched = true;
        hint.textContent = "";
        if (select.value === "__new") { custom.hidden = false; ed.category = custom.value; custom.focus(); }
        else { custom.hidden = true; ed.category = select.value; }
        markDirty();
      } },
        !ed.category ? h("option", { value: "", selected: true, disabled: true }, "Choose a category") : null,
        cats.map(function (c) { return h("option", { value: c, selected: c === ed.category }, c); }),
        h("option", { value: "__new", selected: !known }, "New category…"));
      liveEls.catSelect = select;
      liveEls.catCustom = custom;
      liveEls.catHint = hint;
      return h("div", { class: "field" }, h("label", { for: "f-category" }, "Category"), select, custom, hint);
    }

    function drawIngredients() {
      liveEls.rowTags = [];
      var list = h("ol", { class: "ing-list" }, ed.ingredients.map(function (ing, i) {
        var shared = S.linkedShared(ing, sharedList());
        var tags = h("span", { class: "ing-tags" });
        liveEls.rowTags.push(tags);
        var before = null;
        var text = shared
          ? h("div", { class: "ing-shared" },
              h("span", { class: "ing-shared-name" }, h("span", { class: "shared-badge", title: "Shared ingredient" }, icon("layers", 13), "Shared"), shared.name),
              shared.recipe ? h("span", { class: "ing-shared-recipe" }, shared.recipe) : null,
              h("a", { class: "small-link", href: "#/shared/" + encodeURIComponent(shared.id) }, "Change it for every dish"))
          : autoGrow(h("textarea", { rows: "1", value: ing, "aria-label": "Ingredient " + (i + 1), class: "ing-text",
              onfocus: function () { before = ed.ingredients.slice(); },
              onkeydown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
              oninput: function (e) { ed.ingredients[i] = e.target.value.replace(/\n/g, " "); autoGrow(e.target); markDirty(); },
              onchange: function () { ingredientsChanged(before || ed.ingredients.slice()); } }));
        return h("li", { class: "ing-row" + (shared ? " is-shared" : "") },
          text, tags,
          h("span", { class: "ing-btns" },
            h("button", { type: "button", class: "icon-btn", "aria-label": "Move up", disabled: i === 0,
              onclick: function () { var t = ed.ingredients[i - 1]; ed.ingredients[i - 1] = ed.ingredients[i]; ed.ingredients[i] = t; state.dirty = true; drawForm(); } }, icon("up", 16)),
            h("button", { type: "button", class: "icon-btn", "aria-label": "Move down", disabled: i === ed.ingredients.length - 1,
              onclick: function () { var t = ed.ingredients[i + 1]; ed.ingredients[i + 1] = ed.ingredients[i]; ed.ingredients[i] = t; state.dirty = true; drawForm(); } }, icon("down", 16)),
            h("button", { type: "button", class: "icon-btn danger", "aria-label": "Remove " + (shared ? shared.name : ing),
              onclick: function () { ed.ingredients.splice(i, 1); state.dirty = true; drawForm(); } }, icon("trash", 16))));
      }));
      var addInput = h("input", { id: "add-ingredient", list: "known-ingredients", placeholder: "Type an ingredient or a shared sauce, then Enter",
        onkeydown: function (e) {
          if (e.key === "Enter") { e.preventDefault(); addFrom(addInput.value); }
        } });
      function addFrom(text) {
        var items = splitIngredients(text);
        if (!items.length) return;
        var before = ed.ingredients.slice();
        ed.ingredients = ed.ingredients.concat(items);
        ingredientsChanged(before);
        var again = document.getElementById("add-ingredient");
        if (again) again.focus();
      }
      return [
        list,
        h("div", { class: "ing-add" }, addInput, button([icon("plus", 16), "Add"], function () { addFrom(addInput.value); }, "small")),
        h("p", { class: "hint" }, "Paste a whole list at once (one per line, or separated by commas). Shared sauces are filled in with their full recipe."),
        h("datalist", { id: "known-ingredients" },
          sharedList().map(function (s) { return h("option", { value: s.name }); }),
          knownIngredients().slice(0, 400).map(function (i) { return h("option", { value: i }); })),
      ];
    }

    function drawAllergens() {
      liveEls.allergenHints = {};
      return h("div", { class: "allergen-grid", role: "group", "aria-label": "Allergens" },
        h("div", { class: "ag-head" }, h("span", null, "Allergen"), h("span", null, "In this dish"), h("span", null, "Cross-contact"), h("span", null, "Found in")),
        R.ALLERGENS.map(function (a) {
          var level = ed.contains.includes(a) ? "contains" : ed.possible.includes(a) ? "possible" : "none";
          var hint = h("span", { class: "hint-src" });
          liveEls.allergenHints[a] = hint;
          return h("div", { class: "ag-row" + (level !== "none" ? " on" : "") },
            h("span", { class: "ag-name" }, a),
            h("span", { class: "seg", role: "radiogroup", "aria-label": a },
              [["none", "No"], ["contains", "Contains"], ["possible", "May contain"]].map(function (opt) {
                return h("button", { type: "button", role: "radio", "aria-checked": level === opt[0] ? "true" : "false",
                  class: "seg-btn " + opt[0] + (level === opt[0] ? " on" : ""), onclick: function () { record(a, opt[0]); } }, opt[1]);
              })),
            h("label", { class: "cc" }, h("input", { type: "checkbox", checked: ed.crossContact.includes(a), "aria-label": a + " cross-contact",
              onchange: function () { ed.crossContact = toggleIn(ed.crossContact, a).filter(function (x) { return R.ALLERGENS.includes(x); }); state.dirty = true; drawForm(); } })),
            hint);
        }));
    }

    function autoAddedNote() {
      if (!autoAdded.length) return null;
      var parts = autoAdded.map(function (a) {
        if (a.diet) return "no longer " + a.diet.toLowerCase();
        return a.allergen + (a.level === "possible" ? " (may contain)" : "") + (a.ingredient ? ", from " + a.ingredient : "");
      });
      return h("div", { class: "auto-note" }, icon("check", 15),
        h("p", null, h("strong", null, "Filled in from the ingredients: "), parts.join("; ") + ". Change anything the kitchen says is different."));
    }

    function drawDiet() {
      return h("div", { class: "diet-row" },
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: ed.vegetarian, onchange: function (e) {
          ed.vegetarian = e.target.checked; if (!ed.vegetarian) ed.vegan = false; state.dirty = true; drawForm();
        } }), "Vegetarian"),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: ed.vegan, onchange: function (e) {
          ed.vegan = e.target.checked; if (ed.vegan) ed.vegetarian = true; state.dirty = true; drawForm();
        } }), "Vegan"));
    }

    function drawMods() {
      var recorded = orderAllergens(ed.contains.concat(ed.possible));
      var takeOut = R.ALLERGENS.filter(function (a) { return recorded.includes(a); });
      return [
        ed.modifications.map(function (m, i) {
          trackAdds(m);
          syncRemaining(m);
          var addsOpen = m.adds.length > 0 || m.showAdds;
          var left = m.remaining;
          // Diets the dish doesn't meet yet (plus any already chosen, so they can be cleared).
          var diets = R.DIETARY.filter(function (x) {
            var already = x === "Vegan" ? ed.vegan : ed.vegetarian || ed.vegan;
            return !already || m.resolves.includes(x);
          });
          return h("div", { class: "card-edit" },
            h("div", { class: "card-edit-head" }, h("strong", null, "Change " + (i + 1)),
              h("button", { type: "button", class: "icon-btn danger", "aria-label": "Remove change " + (i + 1),
                onclick: function () { ed.modifications.splice(i, 1); state.dirty = true; drawForm(); } }, icon("trash", 16))),
            h("label", { for: "mod-" + i }, "What staff ask the kitchen for"),
            h("textarea", { id: "mod-" + i, rows: "2", value: m.instruction, placeholder: "e.g. No Legendary Sauce",
              oninput: function (e) { m.instruction = e.target.value; markDirty(); } }),
            h("p", { class: "mini-label" }, "This takes out"),
            takeOut.length
              ? h("div", { class: "chips" }, takeOut.map(function (a) {
                  return chipToggle(a, m.resolves.includes(a), function () {
                    m.resolves = toggleIn(m.resolves, a);
                    m.adds = m.adds.filter(function (x) { return !m.resolves.includes(x); });
                    state.dirty = true; drawForm();
                  });
                }))
              : h("p", { class: "muted small" }, "No allergens are recorded on this dish."),
            diets.length
              ? [h("p", { class: "mini-label" }, "Makes it suitable for"),
                 h("div", { class: "chips" }, diets.map(function (x) {
                   return chipToggle(x === "Vegan" ? "Vegans" : "Vegetarians", m.resolves.includes(x), function () {
                     m.resolves = toggleIn(m.resolves, x); state.dirty = true; drawForm();
                   });
                 }))]
              : null,
            addsOpen
              ? [h("p", { class: "mini-label" }, "The swap brings in"),
                 h("div", { class: "chips" }, R.ALLERGENS.filter(function (a) { return !recorded.includes(a); }).map(function (a) {
                   return chipToggle(a, m.adds.includes(a), function () { m.adds = toggleIn(m.adds, a); state.dirty = true; drawForm(); }, "danger-when-on");
                 }))]
              : button("The swap brings in another allergen…", function () { m.showAdds = true; drawForm(); }, "small link"),
            h("p", { class: "muted small mod-left" }, left.length
              ? "After the change it still contains: " + left.join(", ") + "."
              : "After the change: no recorded allergens left."));
        }),
        button([icon("plus", 16), "Add a recipe change"], function () {
          ed.modifications.push({ instruction: "", resolves: [], remaining: [], adds: [] });
          state.dirty = true; drawForm();
        }, "small"),
      ];
    }

    function drawChefChecks() {
      return [
        ed.chefChecks.map(function (c, i) {
          return h("div", { class: "card-edit" },
            h("div", { class: "card-edit-head" }, h("strong", null, "Chef check " + (i + 1)),
              h("span", null,
                id ? button("Copy to other dishes…", function () { copyChefCheck(c); }, "small link") : null,
                h("button", { type: "button", class: "icon-btn danger", "aria-label": "Remove chef check " + (i + 1),
                  onclick: function () { ed.chefChecks.splice(i, 1); state.dirty = true; drawForm(); } }, icon("trash", 16)))),
            h("p", { class: "mini-label" }, "Show it when staff check for"),
            h("div", { class: "chips" }, R.ALL_FILTERS.map(function (a) {
              return chipToggle(a, c.allergens.includes(a), function () { c.allergens = toggleIn(c.allergens, a); state.dirty = true; drawForm(); });
            })),
            h("label", { for: "cc-" + i }, "Note for staff"),
            h("textarea", { id: "cc-" + i, rows: "2", value: c.note, placeholder: "e.g. Check with the chef that the bun is the vegan bun.",
              oninput: function (e) { c.note = e.target.value; markDirty(); } }),
            h("label", { class: "check" }, h("input", { type: "checkbox", checked: c.showInSubstitutes, onchange: function (e) { c.showInSubstitutes = e.target.checked; markDirty(); } }),
              "Also suggest this dish as an alternative, with this note"));
        }),
        button([icon("plus", 16), "Add a chef check"], function () {
          ed.chefChecks.push({ allergens: [], note: "", showInSubstitutes: false });
          state.dirty = true; drawForm();
        }, "small"),
      ];
    }

    function oldNotice() {
      if (opts.oldDeleted) {
        return h("div", { class: "banner caution" }, icon("alert", 18), h("div", null,
          h("p", null, h("strong", null, "This dish was deleted in the changes saved before the update. "), "Staff still see it."),
          h("div", { class: "head-actions" },
            button("Delete it now", removeDish, "small danger"),
            button("Keep it", function () {
              api("POST", "/old-changes/discard", { id: opts.oldId }).then(function () { return refreshMenu(); }).then(function () { toast("Kept."); location.hash = "#/dishes"; }).catch(showError);
            }, "small secondary"))));
      }
      if (!opts.oldDish) return null;
      return h("div", { class: "banner caution" }, icon("info", 18), h("div", null,
        h("p", null, h("strong", null, "These changes were saved before the update and staff haven't seen them. "), "Check them and press Save to make them live."),
        button("Discard them", function () {
          api("POST", "/old-changes/discard", { id: opts.oldId }).then(function () {
            state.dirty = false;
            return refreshMenu();
          }).then(function () { toast("Discarded."); location.hash = id ? "#/dish/" + encodeURIComponent(id) : "#/dishes"; }).catch(showError);
        }, "small secondary")));
    }

    function drawForm() {
      var meta = id && state.menu.meta[id];
      saveBtn = h("button", { type: "button", class: "btn primary wide", onclick: function () { save(); } }, "Save");
      replace(bodyEl,
        problemsEl,
        oldNotice(),
        section("Details", null, h("div", { class: "grid-2" },
          fieldWrap("Dish name", textInput("name", { maxlength: String(S.LIMITS.name), required: true, placeholder: "e.g. Bacon Cheeseburger" })),
          categoryField(),
          h("div", { class: "span-2" }, fieldWrap("Menu description", textArea("description", 2, { maxlength: String(S.LIMITS.description) }))))),
        section("Ingredients", "Include sauces, garnishes and sides served with it.", [
          h("ul", { class: "legend-line" },
            h("li", null, h("span", { class: "tag hit" }, "Egg"), " contains"),
            h("li", null, h("span", { class: "tag maybe" }, "Sulphites?"), " may contain, check the label"),
            h("li", null, "Found from the words in each ingredient, for example “flour” → Gluten. Hover over a tag to see the word.")),
          drawIngredients()]),
        section("Allergens", null, [
          autoAddedNote(),
          drawAllergens(),
          fieldWrap("Cross-contact details (shown to staff)", textArea("crossContactNote", 2, { maxlength: String(S.LIMITS.crossContactNote),
            placeholder: "e.g. Cooked in its own fryer, next to the fryers used for breaded food." })),
          drawDiet()]),
        section("Recipe changes", "Swaps staff can offer a guest, for example “no cheese”.", drawMods()),
        section("Chef checks", "Something staff must confirm with the chef for a given allergy.", drawChefChecks()),
        h("details", { class: "ed-section more" }, h("summary", null, "More options"),
          h("p", { class: "mini-label" }, "Never offer recipe changes for"),
          h("div", { class: "chips" }, R.ALL_FILTERS.map(function (a) {
            return chipToggle(a, ed.noChangesFor.includes(a), function () { ed.noChangesFor = toggleIn(ed.noChangesFor, a); state.dirty = true; drawForm(); });
          })),
          fieldWrap("Where the allergens come from (shown to staff)", textArea("evidence", 3, { maxlength: String(S.LIMITS.evidence),
            placeholder: "e.g. Egg: Legendary Sauce. Milk: cheddar. Gluten: bun." })),
          fieldWrap("Kitchen notes (shown to staff)", textArea("notes", 2, { maxlength: String(S.LIMITS.notes) }))),
        id && !opts.oldDeleted ? section("Archive or delete", ed.archived
            ? "Archived: staff don't see this dish. Put it back to show it again."
            : "Archive a dish that is off the menu for now. Staff stop seeing it straight away, and you can put it back at any time.",
          h("div", { class: "row-actions" },
            ed.archived
              ? button([icon("archive", 16), "Put back on the menu"], function () { setArchived(false); }, "small")
              : button([icon("archive", 16), "Archive"], function () { setArchived(true); }, "small"),
            button([icon("trash", 16), "Delete"], removeDish, "danger small"))) : null);
      replace(sideEl,
        h("div", { class: "side-card" },
          saveBtn,
          meta ? h("p", { class: "muted small side-meta" }, "Last changed by " + meta.by + ", " + when(meta.at)) : null,
          h("h3", null, "Checks"),
          liveEls.checks),
        h("div", { class: "side-card" }, h("h3", null, "How staff see it"), liveEls.preview));
      drawLive();
    }

    function saveSummary(before, after) {
      var lines = S.diffDish(before, after).filter(function (d) { return d.safety; }).map(function (d) {
        if (d.added || d.removed) {
          var name = function (x) { return d.field === "ingredients" ? S.baseName(x) || x : x; };
          var parts = (d.added || []).map(function (x) { return "+ " + name(x); }).concat((d.removed || []).map(function (x) { return "− " + name(x); }));
          return [d.label, parts];
        }
        if (d.field === "vegan" || d.field === "vegetarian") return [d.label, [d.before + " → " + d.after]];
        return [d.label, ["changed"]];
      });
      return lines;
    }

    function save() {
      var dish = currentDish();
      if (S.openDangers(dish).length) { toast("Fix the red items in Checks first.", "error"); return; }
      if (!dish.name.trim() || !dish.category.trim()) {
        replace(problemsEl, problemList([!dish.name.trim() ? "Give the dish a name." : null, !dish.category.trim() ? "Choose a category." : null].filter(Boolean)));
        problemsEl.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      var lines = original ? saveSummary(original, dish) : null;
      var question;
      if (!original) {
        question = [h("p", null, "Staff can see it as soon as you save."),
          h("ul", { class: "change-lines" },
            h("li", null, "Contains: " + (dish.contains.join(", ") || "nothing recorded")),
            dish.possible.length ? h("li", null, "May contain: " + dish.possible.join(", ")) : null,
            dish.crossContact.length ? h("li", null, "Cross-contact: " + dish.crossContact.join(", ")) : null,
            h("li", null, dish.vegan ? "Vegan" : dish.vegetarian ? "Vegetarian" : "Not vegetarian"))];
      } else if (lines.length || opts.oldDish) {
        question = [h("p", null, "Staff see the new allergen information as soon as you save."),
          lines ? h("ul", { class: "change-lines" }, lines.map(function (l) { return h("li", null, h("strong", null, l[0] + ": "), l[1].join(", ")); })) : null];
      }
      var go = function () {
        [saveBtn, mSave].forEach(function (b) { if (b) b.disabled = true; });
        var req = id
          ? api("PUT", "/dishes/" + encodeURIComponent(id), { dish: dish, baseStamp: baseStamp })
          : api("POST", "/dishes", { dish: Object.assign(dish, { id: undefined }) });
        return req.then(function (res) {
          state.dirty = false;
          replace(problemsEl);
          var extra = (res.added || []).filter(function (a) { return a.allergen; }).map(function (a) { return a.allergen; });
          toast(extra.length ? "Saved. Also recorded " + extra.join(", ") + " from a shared ingredient." : "Saved. Staff see the change now.");
          var tidy = opts.oldId && !id ? api("POST", "/old-changes/discard", { id: opts.oldId }).catch(function () {}) : Promise.resolve();
          return tidy.then(refreshMenu).then(function () {
            if (!id) location.hash = "#/dish/" + encodeURIComponent(res.dish.id);
            else if (location.hash !== "#/dish/" + encodeURIComponent(id)) location.hash = "#/dish/" + encodeURIComponent(id);
            else editorView(id);
          });
        }).catch(function (err) {
          if (err.status === 409 && err.body.current) return conflict(err);
          replace(problemsEl, problemList(showError(err)));
          problemsEl.scrollIntoView({ behavior: "smooth", block: "center" });
          drawLive();
        });
      };
      if (!question) return go();
      confirmDialog(original ? "Update the staff guide?" : "Add " + dish.name + " to the staff guide?", question, "Save").then(function (ok) { if (ok) go(); });
    }

    function conflict(err) {
      var who = err.body.meta ? err.body.meta.by + " (" + when(err.body.meta.at) + ")" : "another manager";
      var dlg = modal("Someone else changed this dish",
        h("p", null, "This dish was saved by " + who + " while you were editing. Load their version to continue (your unsaved edits on this dish will be lost)."),
        [button("Keep editing", function () { dlg.close(); drawLive(); }, "secondary"),
         button("Load their version", function () { dlg.close(); state.dirty = false; refreshMenu().then(function () { editorView(id); }); }, "primary")]);
    }

    function setArchived(archived) {
      var go = function () {
        api("POST", "/dishes/" + encodeURIComponent(id) + "/archive", { archived: archived }).then(function () {
          state.dirty = false;
          toast(archived ? "Archived. Staff no longer see it." : "Back on the menu. Staff see it again.");
          return refreshMenu().then(function () { editorView(id); });
        }).catch(showError);
      };
      if (!state.dirty) return go();
      confirmDialog("Discard unsaved edits?", "Archiving reloads the dish, so edits you haven't saved will be lost.", archived ? "Archive" : "Put back", false)
        .then(function (ok) { if (ok) go(); });
    }

    function removeDish() {
      confirmDialog("Delete " + (ed.name || "this dish") + "?", "Staff stop seeing it straight away. You can bring it back from Activity with Undo. If the dish may return, archive it instead.", "Delete", true)
        .then(function (ok) {
          if (!ok) return;
          api("DELETE", "/dishes/" + encodeURIComponent(id)).then(function () {
            state.dirty = false;
            toast("Deleted.");
            return refreshMenu().then(function () { location.hash = "#/dishes"; });
          }).catch(showError);
        });
    }

    function copyChefCheck(check) {
      var others = state.menu.dishes.filter(function (d) { return d.id !== id; });
      var chosen = new Set();
      var q = h("input", { type: "search", placeholder: "Filter dishes…", "aria-label": "Filter dishes", oninput: draw });
      var listEl = h("div", { class: "pick-list" });
      function draw() {
        var words = R.normalise(q.value);
        replace(listEl, others.filter(function (d) { return !words || R.normalise(d.name + " " + d.category + " " + d.ingredients.join(" ")).includes(words); })
          .map(function (d) {
            return h("label", { class: "check" }, h("input", { type: "checkbox", checked: chosen.has(d.id), onchange: function (e) {
              if (e.target.checked) chosen.add(d.id); else chosen.delete(d.id);
            } }), d.name, h("span", { class: "muted" }, " · " + d.category));
          }));
      }
      draw();
      var dlg = modal("Copy chef check to other dishes", [
        h("p", { class: "muted" }, "“" + check.note + "”"),
        h("p", { class: "hint" }, "Type “bun” to find every dish with a bun. Staff see the note on the chosen dishes straight away."),
        q, listEl,
      ], [
        button("Cancel", function () { dlg.close(); }, "secondary"),
        button("Copy", function () {
          var targets = others.filter(function (d) { return chosen.has(d.id); }).map(function (d) {
            var copy = structuredClone(d);
            if (!copy.chefChecks.some(function (c) { return c.note === check.note; })) copy.chefChecks.push(structuredClone(check));
            return copy;
          });
          if (!targets.length) { dlg.close(); return; }
          api("POST", "/bulk", { dishes: targets, label: "Copied a chef check to " + plural(targets.length, "dish", "dishes") }).then(function (res) {
            dlg.close();
            toast("Chef check copied to " + plural(res.saved, "dish", "dishes") + ".");
            return refreshMenu();
          }).catch(showError);
        }, "primary"),
      ]);
    }

    var sideEl = h("aside", { class: "editor-side" });
    setMain(
      h("div", { class: "m-head" },
        h("div", null,
          h("a", { class: "text-link", href: "#/dishes" }, icon("back", 16), "All dishes"),
          h("h1", null, original ? original.name : opts.oldDish ? opts.oldDish.name : "New dish")),
        null),
      h("div", { class: "editor" }, bodyEl, sideEl),
      h("div", { class: "mobile-bar" }, mSave));
    drawForm();
    state.dirty = !!opts.oldDish;
    if (restored) {
      state.dirty = true;
      replace(problemsEl, h("div", { class: "notice" }, icon("info", 18),
        h("p", null, h("strong", null, "Your unsaved changes are back. "), "You were signed out before saving them. Check them and press Save.")));
    }
    drawLive();
    if (!id && !opts.oldDish) { var nameEl = document.getElementById("f-name"); if (nameEl) nameEl.focus(); }

    mainEl.onkeydown = function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!saveBtn.disabled) save(); }
    };
  }

  // ---------- Shared ingredients ----------

  function sharedView(openId) {
    var q = h("input", { type: "search", placeholder: "Find a sauce or ingredient…", "aria-label": "Find a shared ingredient", oninput: draw });
    var listEl = h("div", { class: "shared-list", role: "list" });
    var byId = new Map(state.menu.dishes.map(function (d) { return [d.id, d]; }));

    function draw() {
      var words = R.normalise(q.value);
      var shown = state.menu.shared.filter(function (s) { return !words || R.normalise(s.name + " " + s.recipe).includes(words); });
      replace(listEl, shown.length ? shown.map(function (s) {
        return h("button", { type: "button", class: "shared-row", role: "listitem", onclick: function () { openShared(s); } },
          h("div", { class: "shared-main" },
            h("strong", null, s.name),
            h("span", { class: "muted small shared-recipe" }, s.recipe || "No recipe written yet"),
            h("div", { class: "tags" }, detectedTags(R.detectAllergens([S.sharedText(s)])))),
          h("span", { class: "muted small shared-uses" }, s.dishes.length ? "Used in " + plural(s.dishes.length, "dish", "dishes") : "Not used yet"),
          icon("chevron", 18));
      }) : h("p", { class: "empty" }, words ? "Nothing matches." : "No shared ingredients yet."));
    }

    function openShared(entry) {
      var name = h("input", { id: "sh-name", value: entry ? entry.name : "", maxlength: String(S.LIMITS.sharedName), placeholder: "e.g. Chipotle mayo" });
      var recipe = autoGrow(h("textarea", { id: "sh-recipe", rows: "3", value: entry ? entry.recipe : "", maxlength: String(S.LIMITS.recipe),
        placeholder: "e.g. Mayonnaise (egg), Chipotle paste, Lime juice, Salt" }));
      var tagsEl = h("div", { class: "tags" });
      var err = h("div");
      function drawTags() {
        replace(tagsEl, detectedTags(R.detectAllergens([S.sharedText({ name: name.value.trim(), recipe: recipe.value.trim() })])));
      }
      name.addEventListener("input", drawTags);
      recipe.addEventListener("input", function () { autoGrow(recipe); drawTags(); });
      drawTags();
      var used = entry ? entry.dishes.map(function (id) { return byId.get(id); }).filter(Boolean) : [];
      var dlg = modal(entry ? entry.name : "Add a shared ingredient", [
        err,
        h("div", { class: "field" }, h("label", { for: "sh-name" }, "Name"), name),
        h("div", { class: "field" }, h("label", { for: "sh-recipe" }, "Recipe"), recipe,
          h("p", { class: "hint" }, "Separate the ingredients with commas. Put what they contain in brackets, for example “Mayonnaise (egg)”.")),
        h("p", { class: "mini-label" }, "Allergens found"), tagsEl,
        entry ? h("div", null, h("p", { class: "mini-label" }, used.length ? "Used in" : "Not used on any dish yet"),
          used.length ? h("p", { class: "used-in" }, used.map(function (d, i) { return [i ? ", " : "", h("a", { href: "#/dish/" + encodeURIComponent(d.id), onclick: function () { dlg.close(); } }, d.name)]; })) : null)
          : h("p", { class: "hint" }, "Dishes that already list an ingredient with this name are linked to it automatically. To use it on another dish, type its name in that dish's ingredients."),
      ], [
        entry ? button([icon("trash", 16), "Remove"], function () {
          confirmDialog("Remove " + entry.name + " from the shared list?", "Dishes keep their ingredient text. It just stops being updated for all of them at once.", "Remove", true).then(function (ok) {
            if (!ok) return;
            api("DELETE", "/shared/" + encodeURIComponent(entry.id)).then(function () {
              dlg.close(); toast("Removed from the shared list."); return refreshMenu().then(function () { location.hash = "#/shared"; sharedView(); });
            }).catch(showError);
          });
        }, "ghost danger-text left") : null,
        button("Cancel", function () { dlg.close(); }, "secondary"),
        button("Save", function () {
          var body = { name: name.value, recipe: recipe.value };
          var changed = !entry || entry.name !== body.name.trim() || entry.recipe !== body.recipe.trim();
          if (!changed) { dlg.close(); return; }
          var go = function () {
            api(entry ? "PUT" : "POST", entry ? "/shared/" + encodeURIComponent(entry.id) : "/shared", body).then(function (res) {
              dlg.close();
              var n = res.updated.length;
              toast(n ? "Saved. Updated on " + plural(n, "dish", "dishes") + "." : "Saved.");
              var withAdds = res.updated.filter(function (u) { return u.added.length; });
              if (withAdds.length) {
                modal("Allergens added", [
                  h("p", null, "The new recipe brings in allergens that weren't recorded on these dishes, so they were added:"),
                  h("ul", { class: "change-lines" }, withAdds.map(function (u) {
                    return h("li", null, h("strong", null, u.name + ": "), u.added.map(function (a) {
                      return a.diet ? "no longer " + a.diet.toLowerCase() : a.allergen + (a.level === "possible" ? " (may contain)" : "");
                    }).join(", "));
                  })),
                  h("p", { class: "muted" }, "If any of these is wrong, open the dish and change it."),
                ], [button("OK", function (e) { e.currentTarget.closest("dialog").close(); }, "primary")]);
              }
              return refreshMenu().then(function () { if (location.hash !== "#/shared") location.hash = "#/shared"; else sharedView(); });
            }).catch(function (e) { replace(err, problemList(showError(e))); });
          };
          if (entry && used.length) {
            confirmDialog("Update " + plural(used.length, "dish", "dishes") + "?",
              "Staff see the new recipe on " + used.slice(0, 6).map(function (d) { return d.name; }).join(", ") + (used.length > 6 ? " and " + (used.length - 6) + " more" : "") +
              " straight away. Any allergen it brings in is added to those dishes.", "Update").then(function (ok) { if (ok) go(); });
          } else go();
        }, "primary"),
      ]);
      name.focus();
    }

    setMain(
      h("div", { class: "m-head" },
        h("div", null, h("h1", null, "Shared ingredients"),
          h("p", { class: "muted" }, "Sauces and components used on more than one dish. Change one here and every dish that uses it is updated.")),
        can("edit") ? button([icon("plus", 16), "Add shared ingredient"], function () { openShared(null); }, "primary") : null),
      h("div", { class: "m-filters" }, h("div", { class: "input-wrap" }, icon("search", 18), q)),
      listEl);
    draw();
    if (openId) {
      var entry = state.menu.shared.find(function (s) { return s.id === openId; });
      if (entry) openShared(entry);
    }
  }

  // ---------- Activity ----------

  function detailLines(e) {
    var d = e.detail || {};
    var lines = [];
    if (typeof d.name === "string" && d.name && (e.action || "").indexOf(d.name) < 0) lines.push(d.name);
    if (Array.isArray(d.changes)) lines = lines.concat(d.changes.filter(function (c) { return c !== "New dish" && c !== "Deleted"; }));
    if (Array.isArray(d.dishes) && d.dishes.length) {
      lines.push(d.dishes.slice(0, 8).join(", ") + (d.dishes.length > 8 ? " and " + (d.dishes.length - 8) + " more" : ""));
    }
    if (Array.isArray(d.added) && d.added.length) lines.push("Allergens added: " + d.added.join("; "));
    if (d.file) lines.push(d.file);
    if (e.kind === "security" && d.username && (!e.who || e.action.indexOf(d.username) < 0)) lines.push("Account: " + d.username);
    return lines;
  }

  function activityView() {
    var owner = can("admin");
    var f = owner ? state.activityFilter : "menu";
    var listEl = h("div", null, h("p", { class: "muted" }, "Loading…"));
    var chips = owner ? h("div", { class: "chips filter-chips" },
      [["all", "Everything"], ["menu", "Menu changes"], ["security", "Sign-ins and security"]].map(function (o) {
        return chipToggle(o[1], f === o[0], function () { state.activityFilter = o[0]; activityView(); });
      })) : null;
    setMain(h("div", { class: "m-head" }, h("div", null, h("h1", null, "Activity"),
      h("p", { class: "muted" }, owner ? "Every change to the menu, and every sign-in and account change. Kept for 13 months."
        : "Every change to the menu. Kept for 13 months."))), chips, listEl);

    api("GET", "/activity").then(function (res) {
      var entries = res.entries.filter(function (e) { return f === "all" || e.kind === f; });
      replace(listEl, entries.length ? h("table", { class: "log activity" },
        h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Who"), h("th", null, "What"), h("th", null, ""))),
        h("tbody", null, entries.map(function (e) {
          var lines = detailLines(e);
          var tone = e.severity === "critical" ? "danger" : e.severity === "warning" ? "caution" : null;
          return h("tr", { class: e.kind === "security" ? "is-security" : "" },
            h("td", { title: exactTime(e.at) }, when(e.at)),
            h("td", null, e.who || "System"),
            h("td", null,
              h("div", { class: "act-what" }, tone ? h("span", { class: "status " + tone }, e.severity === "critical" ? "Important" : "Warning") : null, h("span", null, e.action)),
              lines.length ? h("ul", { class: "act-detail" }, lines.map(function (l) { return h("li", null, l); })) : null),
            h("td", { class: "act-undo" }, e.undoable && can("edit") ? button([icon("history", 15), "Undo"], function () { undo(e); }, "small") : null));
        }))) : h("p", { class: "muted" }, "Nothing here yet."));
    }).catch(function (err) { showError(err); replace(listEl); });

    function undo(e) {
      confirmDialog("Undo this change?", h("div", null,
        h("p", null, h("strong", null, e.action)),
        h("p", { class: "muted" }, "It is put back exactly as it was before. Staff see that straight away. You can undo the undo from this page too.")), "Undo").then(function (ok) {
        if (!ok) return;
        api("POST", "/activity/undo", { key: e.key }).then(function () {
          toast("Undone.");
          return refreshMenu().then(activityView);
        }).catch(function (err) { showError(err); activityView(); });
      });
    }
  }

  // ---------- My account ----------

  function accountView() {
    var bodyEl = h("div", null, h("p", { class: "muted" }, "Loading…"));
    setMain(h("div", { class: "m-head" }, h("div", null, h("h1", null, "My account"),
      h("p", { class: "muted" }, "Signed in as " + state.session.username + " · " + state.session.roleLabel))), bodyEl);

    function inp(id, label, attrs) {
      var input = h("input", Object.assign({ id: id, required: true, maxlength: "200" }, attrs));
      return { input: input, nodes: h("div", { class: "field" }, h("label", { for: id }, label), input) };
    }

    api("GET", "/account").then(function (me) {
      var cur = inp("acc-cur", "Current password", { type: "password", autocomplete: "current-password" });
      var pw = inp("acc-new", "New password (12+ characters)", { type: "password", autocomplete: "new-password", minlength: "12" });
      var code = inp("acc-code", "Code from your authenticator app", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7" });
      var err1 = h("p", { class: "form-error", role: "alert" });
      var code2 = inp("acc-code2", "Code from your authenticator app", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7" });
      var codesEl = h("div");
      replace(bodyEl,
        h("section", { class: "side-card" },
          h("h2", null, "Sign-in"),
          h("p", null, icon("check", 15), " Two-step sign-in is on. ", h("span", { class: "muted" }, me.recoveryCodesLeft + " recovery codes left.")),
          h("p", { class: "muted small" }, "Last sign-in " + when(me.lastSignInAt) + ". Account created " + when(me.createdAt) + ".")),
        h("form", { class: "side-card", onsubmit: function (e) {
          e.preventDefault(); err1.textContent = "";
          api("POST", "/account/password", { current: cur.input.value, password: pw.input.value, code: code.input.value })
            .then(function () { toast("Password changed. Other devices were signed out."); accountView(); })
            .catch(function (err) { err1.textContent = err.message; });
        } }, h("h2", null, "Change password"), cur.nodes, pw.nodes, code.nodes, err1,
          h("button", { type: "submit", class: "btn primary" }, "Change password")),
        h("form", { class: "side-card", onsubmit: function (e) {
          e.preventDefault();
          api("POST", "/account/recovery-codes", { code: code2.input.value }).then(function (res) {
            code2.input.value = "";
            replace(codesEl, h("div", { class: "warning" }, icon("info", 18), h("div", null,
              h("p", null, h("strong", null, "Your new recovery codes. "), "The old ones no longer work. Save these now; they won't be shown again."),
              recoveryList(res.recoveryCodes),
              button([icon("download", 16), "Download"], function () { downloadText("allergen-guide-recovery-codes.txt", res.recoveryCodes.join("\n") + "\n"); }, "small"))));
          }).catch(showError);
        } }, h("h2", null, "Recovery codes"), h("p", { class: "muted" }, "Make a fresh set if you've used some or think someone saw them."),
          code2.nodes, h("button", { type: "submit", class: "btn" }, "Make new recovery codes"), codesEl),
        h("section", { class: "side-card" }, h("h2", null, "Devices"),
          h("p", { class: "muted" }, "Lost a phone or left yourself signed in somewhere? This ends every other session."),
          button([icon("logout", 16), "Sign out all other devices"], function () {
            api("POST", "/account/signout-others", {}).then(function () { toast("All other devices were signed out."); }).catch(showError);
          })),
        h("p", { class: "hint" }, "Lost your authenticator app and your recovery codes? Ask an owner to reset your two-step sign-in."));
    }).catch(showError);
  }

  // ---------- Team (owners) ----------

  function teamView() {
    var listEl = h("div", null, h("p", { class: "muted" }, "Loading…"));
    var roleHelp = h("ul", { class: "plain role-help" },
      h("li", null, h("strong", null, "Manager: "), "changes dishes and shared ingredients, imports recipes and sees the menu activity."),
      h("li", null, h("strong", null, "Owner: "), "everything a manager does, plus the team, password resets and sign-in activity."));
    setMain(h("div", { class: "m-head" }, h("div", null, h("h1", null, "Team"), h("p", { class: "muted" }, "Everyone signs in with their own account and two-step sign-in.")),
      button([icon("plus", 16), "Add person"], addPerson, "primary")), roleHelp, listEl);

    function showTemp(title, user, temp) {
      modal(title, [
        h("p", null, "Give " + user.name + " these details in person or by phone, not by email or group chat:"),
        h("dl", { class: "temp-creds" }, h("dt", null, "Sign-in page"), h("dd", null, location.origin + "/manager/"),
          h("dt", null, "Username"), h("dd", null, h("code", null, user.username)),
          h("dt", null, "Temporary password"), h("dd", null, h("code", { class: "secret" }, temp))),
        h("p", { class: "muted" }, "At their first sign-in they choose their own password and set up their authenticator app. This password is shown only once."),
      ], [button("Done", function (e) { e.currentTarget.closest("dialog").close(); draw(); }, "primary")]);
    }

    function addPerson() {
      var name = h("input", { id: "np-name", required: true, maxlength: "40", autocomplete: "off" });
      var user = h("input", { id: "np-user", required: true, maxlength: "32", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "e.g. ciara.b" });
      var role = h("select", { id: "np-role" }, h("option", { value: "manager", selected: true }, "Manager"), h("option", { value: "owner" }, "Owner"));
      var err = h("p", { class: "form-error", role: "alert" });
      var dlg = modal("Add person", [h("div", { class: "field" }, h("label", { for: "np-name" }, "Name"), name),
        h("div", { class: "field" }, h("label", { for: "np-user" }, "Username"), user),
        h("div", { class: "field" }, h("label", { for: "np-role" }, "Role"), role), err], [
        button("Cancel", function () { dlg.close(); }, "secondary"),
        button("Create account", function () {
          err.textContent = "";
          api("POST", "/users", { name: name.value, username: user.value, role: role.value }).then(function (res) {
            dlg.close(); showTemp("Account created", res.user, res.temporaryPassword);
          }).catch(function (e) { err.textContent = e.message; });
        }, "primary")]);
      name.focus();
    }

    function draw() {
      api("GET", "/users").then(function (res) {
        replace(listEl, h("table", { class: "log team" },
          h("thead", null, h("tr", null, h("th", null, "Person"), h("th", null, "Role"), h("th", null, "Status"), h("th", null, "Last sign-in"), h("th", null, ""))),
          h("tbody", null, res.users.map(function (u) {
            var me = u.username === state.session.username;
            var roleSel = h("select", { "aria-label": "Role for " + u.name, disabled: me, onchange: function () {
              var label = res.roles[roleSel.value];
              confirmDialog("Make " + u.name + " " + (/^[AEIOU]/.test(label) ? "an " : "a ") + label + "?",
                "They are signed out and use the new role at their next sign-in.", "Change role").then(function (ok) {
                if (!ok) { roleSel.value = u.role; return; }
                api("PUT", "/users/" + u.username, { role: roleSel.value }).then(function () { toast(u.name + " is now " + label + "."); draw(); })
                  .catch(function (e) { showError(e); draw(); });
              });
            } }, Object.keys(res.roles).map(function (r) { return h("option", { value: r, selected: r === u.role }, res.roles[r]); }));
            var status = u.disabled ? h("span", { class: "status danger" }, "Disabled")
              : u.mustChangePassword || !u.mfa ? h("span", { class: "status caution" }, "Setup pending")
              : h("span", { class: "status ok" }, icon("check", 13), "Active");
            return h("tr", null,
              h("td", null, h("strong", null, u.name), h("br"), h("span", { class: "muted small" }, u.username + (me ? " (you)" : ""))),
              h("td", null, roleSel), h("td", null, status), h("td", null, u.lastSignInAt ? when(u.lastSignInAt) : "Never"),
              h("td", null, me ? null : h("div", { class: "row-actions" }, [
                button("Reset password", function () {
                  confirmDialog("Reset " + u.name + "'s password?", "They get a temporary password and must choose a new one. Their sessions end now.", "Reset password").then(function (ok) {
                    if (ok) api("POST", "/users/" + u.username + "/reset", { password: true }).then(function (r) { showTemp("Password reset", r.user, r.temporaryPassword); }).catch(showError);
                  });
                }, "small link"),
                button("Reset two-step sign-in", function () {
                  confirmDialog("Reset " + u.name + "'s two-step sign-in?", "Use this when they lost their phone. They set up the authenticator app again at their next sign-in. Their sessions end now.", "Reset").then(function (ok) {
                    if (ok) api("POST", "/users/" + u.username + "/reset", { mfa: true }).then(function () { toast("Two-step sign-in reset for " + u.name + "."); draw(); }).catch(showError);
                  });
                }, "small link"),
                button(u.disabled ? "Enable" : "Disable", function () {
                  var change = function () {
                    api("PUT", "/users/" + u.username, { disabled: !u.disabled }).then(function () { toast(u.name + (u.disabled ? " can sign in again." : " can no longer sign in.")); draw(); }).catch(showError);
                  };
                  if (u.disabled) return change();
                  confirmDialog("Disable " + u.name + "?", "They are signed out straight away and can't sign in until an owner enables them again. Use this when someone leaves.", "Disable", true)
                    .then(function (ok) { if (ok) change(); });
                }, "small link" + (u.disabled ? "" : " danger-text")),
              ])));
          }))));
      }).catch(showError);
    }
    draw();
  }

  // ---------- Help ----------

  function helpView(anchor) {
    function topic(title, steps, extra) {
      return h("details", { class: "help-topic" }, h("summary", null, title),
        h("ol", { class: "steps" }, steps.map(function (s) { return h("li", null, s); })),
        extra ? h("p", { class: "muted small" }, extra) : null);
    }
    function link(hash, text) { return h("a", { href: hash }, text); }
    function b(text) { return h("strong", null, text); }
    var owner = can("admin");
    var importEl = h("section", { class: "help-import", id: "import" });

    setMain(
      h("div", { class: "m-head" }, h("div", null, h("h1", null, "Help"))),

      h("section", { class: "how" },
        h("h2", null, "How it works"),
        h("ul", { class: "how-points" },
          h("li", null, "Open a dish from ", link("#/dishes", "Dishes"), ", change it and press ", b("Save"), ". Staff see the change straight away."),
          h("li", null, "Allergens are filled in from the ingredients. Check them, and change anything the kitchen says is different."),
          h("li", null, "Sauces used on several dishes are kept in ", link("#/shared", "Shared ingredients"), ". Change one there and every dish that uses it is updated."),
          h("li", null, "Made a mistake? Open ", link("#/activity", "Activity"), " and press ", b("Undo"), " next to the change."))),

      h("h2", { class: "sub-head" }, "How do I…"),
      h("div", { class: "help-list" },
        topic("Change an ingredient or an allergen", [
          ["Go to ", link("#/dishes", "Dishes"), " and type the dish name in the search box. Click the dish."],
          ["Change the ingredients, or press ", b("No"), ", ", b("Contains"), " or ", b("May contain"), " next to an allergen."],
          ["Look at ", b("Checks"), " on the right. Anything in red must be fixed first; most items have a button that fixes it."],
          ["Press ", b("Save"), " and confirm. Staff see it straight away."],
        ]),
        topic("Add a new dish", [
          ["Go to ", link("#/dishes", "Dishes"), " and press ", b("Add dish"), "."],
          "Type the name. The category is picked for you; change it if it's wrong.",
          "Add every ingredient, including sauces, garnishes and sides. The allergens are filled in as you go.",
          ["Check the allergens, then press ", b("Save"), "."],
        ]),
        topic("Change a sauce used on several dishes", [
          ["Open ", link("#/shared", "Shared ingredients"), " and click the sauce."],
          ["Change the recipe and press ", b("Save"), ". Every dish that uses it is updated, and any allergen the new recipe brings in is added to those dishes."],
          ["To add a new one, press ", b("Add shared ingredient"), ". Then type its name in a dish's ingredients to use it there."],
        ]),
        topic("Take a dish off the menu for a while", [
          ["Open the dish and press ", b("Archive"), " at the bottom. Staff stop seeing it."],
          ["To bring it back, open it (use the ", b("Archived"), " filter on the Dishes page) and press ", b("Put back on the menu"), "."],
        ], "Archive keeps the dish. Delete only dishes that will never come back."),
        topic("What the coloured tags on ingredients mean", [
          "Each ingredient is checked for words that point to an allergen: “flour” or “bun” means gluten, “cheddar” means milk, “mayonnaise” means egg.",
          [h("span", { class: "tag hit" }, "Egg"), " means the ingredient contains it."],
          [h("span", { class: "tag maybe" }, "Sulphites?"), " means it often contains it (wine, vinegar, chocolate…). Check the label."],
          "Hover over a tag to see the word that was found.",
        ], "The tags help you; they don't replace the recipe and the product labels."),
        topic("Say where an allergen comes from", [
          "If you set an allergen to Contains or May contain and none of the ingredients explains it, the Found in column shows Where from?.",
          ["Press ", b("Where from?"), " and type the ingredient, for example “Egg wash on the bun”, then press ", b("Add ingredient"), "."],
          "It is added to the ingredients with the allergen in brackets, for example “Egg wash on the bun (contains egg)”, and staff see it next to the allergen.",
        ]),
        topic("Fix a red warning", [
          "Read the warning in Checks. It names the ingredient that caused it.",
          ["If the warning is right, press its button (for example ", b("Record Egg"), ")."],
          ["If the kitchen confirms the allergen isn't in the dish, press ", b("Kitchen confirmed: not in this dish"), "."],
        ], "A dish can't be saved while a red warning is open."),
        topic("Undo a mistake", [
          ["Open ", link("#/activity", "Activity"), "."],
          ["Find the change and press ", b("Undo"), ". The dish goes back to how it was, and staff see that straight away."],
        ], "You can only undo the latest change to a dish. To go further back, undo the newer changes first."),
        topic("Use corrections that come with an app update", [
          ["When the app has corrected information for a dish, a message appears on the ", link("#/dishes", "Dishes"), " page. Press ", b("Review"), "."],
          ["For each dish choose ", b("Use the update"), " or ", b("Keep mine"), ", then press ", b("Save"), "."],
        ]),
        owner ? topic("Add a new person (owners)", [
          ["Open ", link("#/team", "Team"), " and press ", b("Add person"), "."],
          ["Type their name and a username (for example ", h("code", null, "ciara.b"), "), choose a role and press ", b("Create account"), "."],
          "Give them the username and temporary password in person or by phone. It is shown only once.",
          "At their first sign-in they choose their own password and set up the authenticator app on their phone.",
        ]) : null,
        owner ? topic("Someone lost their phone or forgot their password (owners)", [
          ["Open ", link("#/team", "Team"), "."],
          ["Forgotten password: press ", b("Reset password"), " and give them the new temporary password in person."],
          ["Lost phone: press ", b("Reset two-step sign-in"), ". At their next sign-in they scan a new QR code."],
          ["Someone leaves: press ", b("Disable"), ". They are signed out straight away."],
        ]) : null),

      h("h2", { class: "sub-head" }, "Words used here"),
      h("dl", { class: "glossary" },
        h("dt", null, "Contains"), h("dd", null, "The allergen is in the dish."),
        h("dt", null, "May contain"), h("dd", null, "It may be in an ingredient, for example the label says “may contain”. Staff are told to check."),
        h("dt", null, "Cross-contact"), h("dd", null, "Not in the recipe, but it could get in while cooking or prepping, for example a fryer next to the breaded-food fryers."),
        h("dt", null, "Recipe change"), h("dd", null, "A swap staff can offer, for example “no Legendary Sauce”. Only suggested when it takes out every allergen the guest avoids."),
        h("dt", null, "Chef check"), h("dd", null, "Something staff must confirm with the chef for a given allergy, for example that the bun is the vegan bun."),
        h("dt", null, "Shared ingredient"), h("dd", null, "A sauce or component used on several dishes. Changing it updates all of them."),
        h("dt", null, "Archive"), h("dd", null, "Hide a dish from staff but keep it, for seasonal or paused dishes.")),

      importEl);
    drawImport(importEl);
    if (anchor === "import") importEl.scrollIntoView();
  }

  // ---------- Recipe import (end of Help) ----------

  var ACCEPT = ".pdf,.docx,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/*,text/plain,text/csv";

  function drawImport(el) {
    var fileInput = h("input", { type: "file", id: "import-file", accept: ACCEPT, class: "sr-only", onchange: function () { if (fileInput.files[0]) upload(fileInput.files[0]); } });
    var paste = h("textarea", { id: "import-text", rows: "5", placeholder: "Or paste one or more recipes here…" });
    var statusLine = h("p", { class: "muted", "aria-live": "polite" });
    var listEl = h("div", { class: "import-list" }, h("p", { class: "muted" }, "Loading imports…"));
    var drop = h("label", { class: "dropzone", for: "import-file" },
      icon("upload", 28),
      h("strong", null, "Drop a menu or recipe file here"),
      h("span", { class: "muted" }, "PDF, Word, Excel, CSV, text or a photo of a recipe card. Up to 4 MB."),
      h("span", { class: "btn small" }, "Choose a file"));
    ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
    drop.addEventListener("drop", function (e) { var f = e.dataTransfer.files[0]; if (f) upload(f); });

    function started(res) {
      toast("Reading started. You can leave this page; the results appear here.");
      location.hash = "#/import/" + res.id;
    }

    function upload(file) {
      if (file.size > 4 * 1024 * 1024) { toast("Files must be 4 MB or smaller. Split the file or export it as PDF.", "error"); return; }
      statusLine.textContent = "Uploading " + file.name + "…";
      file.arrayBuffer().then(function (buf) {
        return api("POST", "/imports", undefined, { raw: buf, fileName: file.name });
      }).then(started).catch(function (err) { statusLine.textContent = ""; showError(err); });
    }

    replace(el,
      h("h2", { class: "sub-head" }, "Import recipes with AI"),
      h("p", { class: "muted import-intro" }, "AI reads a menu or recipe file and suggests new dishes and updates. Every allergen is checked again by the app's allergen rules, and nothing changes until you accept it. Only names of ingredients are kept: no quantities, methods or prep notes."),
      h("p", { class: "import-privacy" }, icon("check", 15),
        h("span", null, "Your file is safe: the AI reads it, suggests dishes, and then it is deleted. It is never used to train the AI or sold.")),
      can("edit") ? h("div", { class: "import-grid" },
        h("div", { class: "side-card" }, fileInput, drop, statusLine),
        h("div", { class: "side-card" },
          h("label", { for: "import-text" }, "Paste recipes"), paste,
          button("Read these recipes", function () {
            if (paste.value.trim().length < 20) { toast("Paste at least one full recipe.", "error"); return; }
            api("POST", "/imports", { text: paste.value }).then(started).catch(showError);
          }, "primary"),
          h("p", { class: "hint" }, "Reading usually takes a few minutes, and up to an hour when the service is busy."))) : null,
      h("h3", { class: "mini-head" }, "Recent imports"), listEl);

    api("GET", "/imports").then(function (res) {
      replace(listEl, res.imports.length ? res.imports.map(function (j) {
        var label = j.status === "reading" ? "Reading…" : j.pending ? j.pending + " to review" : "Done";
        return h("a", { class: "dish-row", href: "#/import/" + j.id },
          h("div", { class: "dish-row-main" }, h("strong", null, j.fileName),
            h("span", { class: "muted small" }, "by " + j.createdBy + ", " + when(j.createdAt))),
          h("div", { class: "dish-row-status" }, h("span", { class: "status " + (j.status === "reading" ? "caution" : j.pending ? "change" : "ok") }, label), icon("chevron", 18)));
      }) : h("p", { class: "muted" }, "No imports yet."));
    }).catch(function (err) { replace(listEl, h("p", { class: "muted" }, err.message)); });
  }

  function importJobView(jobId) {
    setMain(h("p", { class: "muted" }, "Loading…"));
    var back = h("a", { class: "text-link", href: "#/help/import" }, icon("back", 16), "Back to Help");
    api("GET", "/imports/" + encodeURIComponent(jobId)).then(function (job) {
      if (job.status === "reading") return drawReading(job);
      drawProposals(job);
    }).catch(function (err) {
      showError(err);
      setMain(back);
    });

    function drawReading(job) {
      var c = job.progress || {};
      var done = (c.succeeded || 0) + (c.errored || 0) + (c.canceled || 0) + (c.expired || 0);
      setMain(
        back,
        h("div", { class: "reading" },
          h("div", { class: "spinner", "aria-hidden": "true" }),
          h("h1", null, "Reading " + job.fileName + "…"),
          h("p", { class: "muted" }, done + " of " + job.pieces + " part" + (job.pieces === 1 ? "" : "s") + " read. This page checks again every 20 seconds, and you can leave and come back."),
          h("progress", { max: String(job.pieces), value: String(done) })));
      state.pollTimer = setTimeout(function () { if (location.hash === "#/import/" + jobId) importJobView(jobId); }, 20000);
    }

    function drawProposals(job) {
      var removeChoices = {};
      var pending = job.proposals.filter(function (p) { return p.state === "pending"; });
      var safe = pending.filter(function (p) { return !p.flags.some(function (f) { return f.level === "danger"; }); });
      var current = new Map(state.menu.dishes.map(function (d) { return [d.id, d]; }));

      function decide(decisions) {
        return api("POST", "/imports/" + encodeURIComponent(job.id) + "/decide", { decisions: decisions }).then(function (res) {
          if (res.accepted) toast(plural(res.accepted, "dish", "dishes") + " added to the staff guide.");
          if (res.stale && res.stale.length) toast(res.stale.join(", ") + " changed after the file was read. Import the file again to update " + (res.stale.length === 1 ? "it." : "them."), "error");
          if (!res.accepted && !(res.stale && res.stale.length)) toast("Saved.");
          return refreshMenu().then(function () { drawProposals(res.job); });
        }).catch(showError);
      }

      function card(p) {
        var match = p.matchId ? current.get(p.matchId) : null;
        var diff = match ? S.diffDish(match, p.dish) : [];
        removeChoices[p.index] = removeChoices[p.index] || [];
        var typeLabel = { "new": "New dish", update: "Update", same: "No change" }[p.type];
        return h("article", { class: "proposal " + p.state },
          h("div", { class: "proposal-head" },
            h("span", { class: "status " + (p.type === "new" ? "change" : p.type === "update" ? "caution" : "neutral") }, typeLabel),
            h("h3", null, p.dish.name), h("span", { class: "muted small" }, p.dish.category + (p.source ? " · " + p.source : "")),
            p.state !== "pending" && p.state !== "same" ? h("span", { class: "status " + (p.state === "accepted" ? "ok" : "neutral") }, p.state === "accepted" ? "Accepted" : "Rejected") : null),
          p.flags.map(function (f) { return h("div", { class: "warn " + f.level }, icon(f.level === "info" ? "info" : "alert", 15), h("p", null, f.message)); }),
          p.removedAllergens.length && p.state === "pending" ? h("div", { class: "remove-box" },
            h("p", { class: "mini-label" }, "Recorded now but not in the new recipe. Tick only if you are sure it is gone:"),
            p.removedAllergens.map(function (a) {
              return h("label", { class: "check" }, h("input", { type: "checkbox", onchange: function (e) {
                removeChoices[p.index] = e.target.checked ? removeChoices[p.index].concat(a) : removeChoices[p.index].filter(function (x) { return x !== a; });
              } }), "Remove " + a);
            })) : null,
          diff.length ? h("table", { class: "diff" }, h("tbody", null, diff.map(function (d) {
            return h("tr", null, h("th", null, d.label),
              h("td", null, d.added || d.removed ? [
                (d.added || []).map(function (x) { return h("span", { class: "add" }, "+ " + x); }),
                (d.removed || []).map(function (x) { return h("span", { class: "del" }, "− " + x); }),
              ] : [h("span", { class: "del" }, d.before), " → ", h("span", { class: "add" }, d.after)]));
          }))) : null,
          p.type === "new" ? h("div", null,
            h("div", { class: "tags" }, p.dish.contains.map(function (a) { return h("span", { class: "tag hit" }, a); }), p.dish.possible.map(function (a) { return h("span", { class: "tag maybe" }, a + "?"); })),
            h("ul", { class: "ingredient-list" }, p.dish.ingredients.map(function (i) { return h("li", null, i); }))) : null,
          p.state === "pending" ? h("div", { class: "warn-actions" },
            button([icon("check", 16), "Accept"], function () { decide([{ index: p.index, accept: true, removeAllergens: removeChoices[p.index] }]); }, "ok small"),
            button("Reject", function () { decide([{ index: p.index, accept: false }]); }, "small secondary")) : null);
      }

      setMain(
        back,
        h("div", { class: "m-head" },
          h("div", null, h("h1", null, job.fileName),
            h("p", { class: "muted" }, plural(job.proposals.length, "item") + " found · " + pending.length + " to review · read " + when(job.finishedAt) +
              ". Accepted dishes go straight into the staff guide.")),
          h("div", { class: "head-actions" },
            safe.length > 1 ? button("Accept all " + safe.length + " without red flags", function () {
              confirmDialog("Accept " + plural(safe.length, "item") + "?", "They go into the staff guide straight away. You can undo this from Activity.", "Accept").then(function (ok) {
                if (ok) decide(safe.map(function (p) { return { index: p.index, accept: true }; }));
              });
            }, "ok") : null,
            button([icon("trash", 16), "Delete import"], function () {
              confirmDialog("Delete this import?", "Dishes you accepted stay on the menu.", "Delete", true).then(function (ok) {
                if (ok) api("DELETE", "/imports/" + encodeURIComponent(job.id)).then(function () { location.hash = "#/help/import"; }).catch(showError);
              });
            }, "small ghost"))),
        job.problems.length ? h("details", { class: "infos", open: true }, h("summary", null, "Notes from reading (" + job.problems.length + ")"),
          job.problems.map(function (p) { return h("p", { class: "muted" }, p); })) : null,
        job.proposals.length ? job.proposals.filter(function (p) { return p.state !== "same"; }).map(card)
          : h("p", { class: "empty" }, "No recipes were found in this file."),
        job.proposals.some(function (p) { return p.state === "same"; })
          ? h("p", { class: "muted" }, plural(job.proposals.filter(function (p) { return p.state === "same"; }).length, "item") + " already match the menu exactly.") : null);
    }
  }

  // ---------- Start ----------

  function start() {
    api("GET", "/session").then(function (session) {
      state.session = session;
      return refreshMenu().then(function () {
        renderShell();
        if (!location.hash) history.replaceState(null, "", "#/dishes");
        lastHash = location.hash;
        onRoute();
      });
    }).catch(function (err) {
      if (err.status !== 401) replace(app, h("main", { class: "login-wrap" }, h("div", { class: "login-card" },
        h("p", null, err.message), button("Try again", start, "primary"))));
    });
  }

  start();
})();
