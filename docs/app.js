(function () {
  "use strict";
 var $ = function (id) {
  return document.getElementById(id);
};

var themeToggle = $("theme-toggle");

function applyTheme(theme) {
  theme = theme === "light" ? "light" : "dark";

  document.documentElement.setAttribute("data-theme", theme);

  if (themeToggle) {
    themeToggle.textContent = theme === "dark" ? "☀" : "☾";
    themeToggle.title =
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    themeToggle.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );
  }

  try {
    localStorage.setItem("hmis_theme", theme);
  } catch (e) {}
}

var savedTheme = "dark";

try {
  savedTheme = localStorage.getItem("hmis_theme") || "dark";
} catch (e) {}

applyTheme(savedTheme);

if (themeToggle) {
  themeToggle.onclick = function () {
    var currentTheme =
      document.documentElement.getAttribute("data-theme") || "dark";

    applyTheme(currentTheme === "dark" ? "light" : "dark");
  };
}

var API = (window.HMIS_CONFIG || {}).API_URL;
  var sess = null, current = null, busy = false, timer;
  try { sess = JSON.parse(sessionStorage.getItem("hmis") || "null"); } catch (e) {}

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function show(id) { ["login", "list", "detail"].forEach(function (s) { $(s).hidden = s !== id; }); $("logout").hidden = !sess; }
  function msg(id, text, bad) { $(id).textContent = text || ""; $(id).className = "msg " + (bad ? "err" : "ok"); }
  function uuid() { return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random(); }

  // text/plain avoids a CORS preflight, which Apps Script cannot answer.
  // `data` may carry its own staff_id/pin (stock forms); browse calls use the signed-in session.
  function api(action, data, useSession) {
    if (!API || API.indexOf("PASTE_") === 0) return Promise.reject(new Error("API_URL is not configured in config.js."));
    var body = Object.assign({ action: action }, useSession && sess ? { staff_id: sess.staff_id, pin: sess.pin } : {}, data || {});
    return fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }, function () { throw new Error("Network error. Check your connection."); })
      .then(function (j) { if (!j.ok) { var e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.data; });
  }

  // ---- Optional sign-in (browse/search only) ----
  $("l-go").onclick = function () {
    var id = $("l-id").value.trim().toUpperCase(), pin = $("l-pin").value;
    if (!id || !pin) return msg("l-msg", "Enter staff ID and PIN.", true);
    sess = { staff_id: id, pin: pin }; $("l-go").disabled = true; msg("l-msg", "Signing in…");
    api("login", {}, true).then(function (u) { sess.name = u.name; sess.role = u.role; sessionStorage.setItem("hmis", JSON.stringify(sess)); $("l-pin").value = ""; show("list"); loadList(); })
      .catch(function (e) { sess = null; msg("l-msg", e.message, true); }).then(function () { $("l-go").disabled = false; });
  };
  $("logout").onclick = function () { sessionStorage.removeItem("hmis"); sess = null; show("login"); };

  // ---- Browse list (needs sign-in) ----
  function loadList() {
    msg("list-msg", "Loading…");
    api("list", { q: $("q").value }, true).then(function (items) {
      var box = $("items"); box.textContent = ""; msg("list-msg", "");
      if (!items.length) { box.appendChild(el("div", "empty", "No items found.")); return; }
      items.forEach(function (it) {
        var c = el("div", "card"); c.tabIndex = 0;
        if (it.image_url) { var im = el("img"); im.src = it.image_url; im.alt = ""; c.appendChild(im); }
        var t = el("div"); t.style.flex = "1";
        t.appendChild(el("div", "", it.item_id + " – " + it.item_name)); t.appendChild(el("small", "", it.location));
        c.appendChild(t);
        var b = el("div", "bal " + (it.low_stock ? "low" : ""), it.balance + " " + it.unit); c.appendChild(b);
        if (it.low_stock) { b.appendChild(el("br")); b.appendChild(el("small", "low", "LOW")); }
        c.onclick = function () { openItem(it.item_id); };
        box.appendChild(c);
      });
    }).catch(function (e) { msg("list-msg", e.message, true); if (e.code === "AUTH" || e.code === "LOCKED") { sess = null; sessionStorage.removeItem("hmis"); show("login"); } });
  }
  $("q").oninput = function () { clearTimeout(timer); timer = setTimeout(loadList, 300); };

  // ---- Item page (public view; this is what a QR scan opens) ----
  function openItem(id) {
    show("detail"); $("form").hidden = true; $("d-body").textContent = ""; msg("d-msg", "Loading…");
    api("item", { item_id: id }).then(function (it) { current = it; msg("d-msg", ""); renderItem(); loadHistory(); })
      .catch(function (e) { msg("d-msg", e.message, true); });
  }
  function renderItem() {
    var it = current, b = $("d-body"); b.textContent = ""; b.className = "detail";
    if (it.image_url) { var im = el("img"); im.src = it.image_url; im.alt = it.item_name; b.appendChild(im); }
    b.appendChild(el("h2", "", it.item_name));
    b.appendChild(el("p", "", "Item ID: " + it.item_id + " | " + it.category));
    b.appendChild(el("p", "bal " + (it.low_stock ? "low" : "ok"), "Balance: " + it.balance + " " + it.unit + (it.low_stock ? " ⚠ LOW STOCK" : "")));
    b.appendChild(el("p", "", "Minimum stock: " + it.min_stock + " | Location: " + it.location));
    // QR label: generate only when the print icon is clicked.
    // QR is never displayed in the item page.

    var qrActions = el("div", "item-tools");
    var qrBtn = el("button", "icon-button qr-print-btn");

    qrBtn.type = "button";
    qrBtn.title = "Print QR label";
    qrBtn.setAttribute("aria-label", "Print QR label");

    qrBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' +
      '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1"/>' +
      '<path d="M14 14h3v3h-3zM20 14v2M17 20h4M20 18v3"/>' +
      '</svg>';

    qrActions.appendChild(qrBtn);
    b.appendChild(qrActions);

    qrBtn.onclick = function () {
      if (typeof QRCode === "undefined") {
        alert("QR library unavailable. Check your internet connection.");
        return;
      }

      // Open the print window immediately to avoid popup blocking.
      var printWindow = window.open("", "_blank");

      if (!printWindow) {
        alert("Please allow pop-ups to print the QR label.");
        return;
      }

      // Generate the QR off-screen, not inside the visible page.
      var temp = document.createElement("div");
      temp.style.position = "fixed";
      temp.style.left = "-10000px";
      temp.style.top = "0";
      document.body.appendChild(temp);

      var itemUrl = new URL(window.location.href);
      itemUrl.search = "";
      itemUrl.hash = "";
      itemUrl.searchParams.set("item", it.item_id);

      new QRCode(temp, {
        text: itemUrl.toString(),
        width: 320,
        height: 320,
        correctLevel: QRCode.CorrectLevel.M
      });

      window.setTimeout(function () {
        var canvas = temp.querySelector("canvas");
        var image = temp.querySelector("img");

        var imageUrl = canvas
          ? canvas.toDataURL("image/png")
          : image
            ? image.src
            : "";

        temp.remove();

        if (!imageUrl) {
          printWindow.close();
          alert("QR Code could not be generated.");
          return;
        }

        function escapeHtml(value) {
          return String(value).replace(/[&<>"']/g, function (c) {
            return {
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;"
            }[c];
          });
        }

        printWindow.document.open();
        printWindow.document.write(
          "<!doctype html><html><head>" +
          "<meta charset='utf-8'>" +
          "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
          "<title>HMIS QR Label</title>" +
          "<style>" +
          "body{font-family:Arial,sans-serif;text-align:center;padding:20px;color:#111}" +
          ".label{width:280px;max-width:100%;margin:auto;padding:16px;border:1px solid #ccc;border-radius:10px}" +
          "img{display:block;width:220px;height:220px;margin:12px auto}" +
          "h2{font-size:20px;margin:6px 0}" +
          "p{font-size:13px;margin:5px 0;overflow-wrap:anywhere}" +
          "@media print{body{padding:0}.label{border:1px solid #ddd;border-radius:0}}" +
          "</style></head><body>" +
          "<div class='label'>" +
          "<h2>HMIS</h2>" +
          "<img src='" + imageUrl + "' alt='Item QR code'>" +
          "<h2>" + escapeHtml(it.item_id) + "</h2>" +
          "<p>" + escapeHtml(it.item_name) + "</p>" +
          "</div></body></html>"
        );
        printWindow.document.close();

        window.setTimeout(function () {
          printWindow.focus();
          printWindow.print();
        }, 500);
      }, 250);
    };
  }

// ---- Load transaction history ----
function loadHistory() {
$("hist").hidden = !sess;

if (!sess) return;

["in", "out"].forEach(function (type) {
  var box = $("h-" + type);
  box.textContent = "";

  api("history", {
    type: type,
    item_id: current.item_id,
    limit: 10
  }, true)
    .then(function (rows) {
      if (!rows.length) {
        box.appendChild(el("div", "empty", "No transactions yet."));
        return;
      }

      rows.forEach(function (r) {
        var txt =
          new Date(r.timestamp).toLocaleString() +
          " • qty " + r.qty +
          " • by " + r.staff_id +
          " • balance " + r.balance_after;

        if (type === "out") {
          txt += " • " + r.location_used + " / " + r.purpose;
        }

        box.appendChild(el("div", "row", txt));
      });
    })
    .catch(function (e) {
      box.appendChild(el("div", "err", e.message));
    });
});

}

  // ---- Stock form: Staff ID + PIN are entered HERE, at submit time ----
  function field(f, label, name, attrs) {
    var l = el("label", "", label), i = el("input"); i.name = name;
    Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
    l.appendChild(i); f.appendChild(l); return i;
  }
  function openForm(type) {
    var f = $("form"); f.textContent = ""; f.hidden = false; msg("d-msg", "");
    f.appendChild(el("h3", "", type === "in" ? "Stock In" : "Stock Out"));
    field(f, "Quantity (" + current.unit + ")", "qty", { type: "number", inputmode: "decimal", min: "0", step: "any" });
    if (type === "out") { field(f, "Usage location", "loc", { maxlength: 100 }); field(f, "Purpose", "purpose", { maxlength: 200 }); }
    field(f, "Notes (optional)", "notes", { maxlength: 300 });
    var sid = field(f, "Staff ID", "staff", { autocomplete: "username", autocapitalize: "characters" });
    try { sid.value = localStorage.getItem("hmis_staff") || (sess && sess.staff_id) || ""; } catch (e) {}
    field(f, "PIN", "pin", { type: "password", inputmode: "numeric", autocomplete: "current-password" });
    var rid = uuid(), sub = el("button", "primary", "Submit"); sub.type = "submit"; f.appendChild(sub);
    f.onsubmit = function (ev) {
      ev.preventDefault(); if (busy) return;
      var v = function (n) { return f.elements[n] ? f.elements[n].value.trim() : ""; };
      var qty = Number(v("qty"));
      if (!isFinite(qty) || qty <= 0) return msg("d-msg", "Quantity must be greater than zero.", true);
      if (type === "out" && (!v("loc") || !v("purpose"))) return msg("d-msg", "Usage location and purpose are required.", true);
      if (!v("staff") || !v("pin")) return msg("d-msg", "Staff ID and PIN are required.", true);
      busy = true; sub.disabled = true; msg("d-msg", "Submitting…");
      var data = { item_id: current.item_id, qty: qty, notes: v("notes"), request_id: rid, staff_id: v("staff").toUpperCase(), pin: f.elements.pin.value };
      if (type === "out") { data.location_used = v("loc"); data.purpose = v("purpose"); }
      api(type === "in" ? "stockIn" : "stockOut", data).then(function (r) {
        try { localStorage.setItem("hmis_staff", data.staff_id); } catch (e) {}   // staff ID only, never the PIN
        f.elements.pin.value = ""; f.hidden = true;
        msg("d-msg", "Recorded " + r.transaction_id + ". New balance: " + r.balance_after);
        return api("item", { item_id: current.item_id }).then(function (it) { current = it; renderItem(); loadHistory(); });
      }).catch(function (e) { msg("d-msg", e.message, true); rid = uuid(); })
        .then(function () { busy = false; sub.disabled = false; });
    };
  }

  // ---- Start: QR link (?item=ID) opens the item directly ----
var qid = new URLSearchParams(window.location.search).get("item");

if (qid) {
  openItem(qid.trim().toUpperCase());
} else if (sess && sess.pin) {
  show("list");
  loadList();
} else {
  show("login");
}
})();
