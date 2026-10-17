// reel-intake.js — Smart Stage PRO Plus Reels: per-event intake forms (Oct 17, 2026)
//
// One form per Reel event. The field names are exactly the keys the Railway storyboard engine
// (reelStoryboard.js) reads, so collectReelIntake() output can be sent straight to it later.
// Works in the browser (window.ReelIntake) and in Node (module.exports) so the schema and the
// formatting/validation helpers can be unit-tested.
//
// Prefill (all editable, per-Reel overrides — they do not change the saved listing):
//   address, beds, baths, sqft  ← the listing's saved details (action=frames → listingDetails)
// NOT prefilled: price (changes constantly; typed per Reel).
(function (root) {
  "use strict";

  // Reel lengths and the photo counts they allow (Oct 17): each photo gets 2.5-7.5s, max 8 photos.
  // Must match REEL_PHOTO_RANGES in the Railway reelStoryboard.js (and lib/reel-slots.json).
  const REEL_LENGTHS = [
    { sec: 15, min: 3, max: 6 },
    { sec: 30, min: 4, max: 8 },
    { sec: 45, min: 6, max: 8 },
    { sec: 60, min: 8, max: 8 },
  ];
  const photoRangeText = (l) => (l.min === l.max ? `${l.min} photos` : `${l.min}\u2013${l.max} photos`);

  // Field kinds: text | money | textarea | date | time | check
  const F = {
    cta:       { key: "cta",       label: "Call to action",        kind: "text",  placeholder: "Leave blank for the default", help: "Branded version only." },
    availability: (ph) => ({ key: "availability", label: "Availability", kind: "text", placeholder: ph }),
    price:     (req, help) => ({ key: "price", label: "List price", kind: "money", required: !!req, placeholder: "e.g. 689000", help }),
    highlight: (n, label) => ({ key: `highlight${n}`, label, kind: "text", placeholder: "About 6-10 words", maxLength: 80, group: "highlights" }),
  };

  const EVENTS = {
    teaser: {
      label: "Teaser", blurb: "Build curiosity before the listing goes live.",
      fields: [
        { key: "headline", label: "Headline", kind: "text", placeholder: "SOMETHING SPECIAL IS COMING", maxLength: 40 },
        F.availability("e.g. this November"), F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    coming_soon: {
      label: "Coming Soon", blurb: "Announce a listing before it hits the market.",
      fields: [
        F.availability("e.g. Late November"), F.price(false, "Optional."), F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    just_listed: {
      label: "Just Listed Highlight", blurb: "The classic new-listing Reel.",
      fields: [
        F.price(false, "Optional."), F.cta,
        F.highlight(1, "Highlight 1 (kitchen)"), F.highlight(2, "Highlight 2 (suite or specialty space)"), F.highlight(3, "Highlight 3 (outdoor)"),
      ],
    },
    for_sale: {
      label: "For Sale", blurb: "A straightforward for-sale feature.",
      fields: [
        { key: "positioning", label: "Opening line", kind: "text", placeholder: "e.g. Single-story living in a 55+ community", maxLength: 60 },
        F.price(false, "Optional."),
        { key: "sellingPoint", label: "Selling point", kind: "text", placeholder: "Shown if no price is entered", maxLength: 80 },
        F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    for_lease: {
      label: "For Lease", blurb: "Rent, terms and availability up front.",
      fields: [
        { key: "rent", label: "Monthly rent", kind: "money", required: true, placeholder: "e.g. 3200" },
        { key: "leaseTerms", label: "Lease terms", kind: "text", placeholder: "e.g. 12-month lease", maxLength: 40 },
        F.availability("e.g. December 1"), F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    feature_spotlight: {
      label: "Feature Spotlight", blurb: "Showcase one standout feature of the home.",
      fields: [
        { key: "feature", label: "Featured space or feature", kind: "text", required: true, placeholder: "e.g. Chef's Kitchen", maxLength: 40 },
        { key: "supporting1", label: "Detail 1", kind: "text", placeholder: "About 6-10 words", maxLength: 80, group: "supporting" },
        { key: "supporting2", label: "Detail 2", kind: "text", placeholder: "About 6-10 words", maxLength: 80, group: "supporting" },
        { key: "supporting3", label: "Detail 3", kind: "text", placeholder: "About 6-10 words", maxLength: 80, group: "supporting" },
        { key: "closingMessage", label: "Closing message", kind: "text", placeholder: "Leave blank to show the home details", maxLength: 60 },
        F.cta,
      ],
    },
    under_contract: {
      label: "Under Contract", blurb: "Share the milestone.",
      fields: [
        { key: "statusMessage", label: "Status message", kind: "text", placeholder: "e.g. Offer accepted in 6 days", maxLength: 80 },
        F.price(false, "Optional — leave blank to keep the price off."), F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    back_on_market: {
      label: "Back on Market", blurb: "Reintroduce a listing.",
      fields: [
        F.availability("e.g. Showings start Saturday"), F.price(false, "Optional."), F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    price_drop: {
      label: "Price Drop", blurb: "A new, lower price.",
      fields: [
        { key: "headline", label: "Headline", kind: "text", placeholder: "PRICE DROP", maxLength: 30 },
        { key: "newPrice", label: "New price", kind: "money", required: true, placeholder: "e.g. 649000" },
        { key: "oldPrice", label: "Previous price", kind: "money", placeholder: "e.g. 689000" },
        F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    price_improvement: {
      label: "Price Improvement Alert", blurb: "A softer way to announce a price change.",
      fields: [
        { key: "headline", label: "Headline", kind: "text", placeholder: "PRICE IMPROVEMENT", maxLength: 30 },
        { key: "newPrice", label: "New price", kind: "money", required: true, placeholder: "e.g. 649000" },
        { key: "oldPrice", label: "Previous price", kind: "money", placeholder: "e.g. 689000" },
        F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    open_house: {
      label: "Open House Invite", blurb: "Date and time lead the Reel.",
      fields: [
        { key: "date", label: "Date", kind: "date", required: true },
        { key: "startTime", label: "Start time", kind: "time" },
        { key: "endTime", label: "End time", kind: "time" },
        F.price(false, "Optional."), F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
    just_sold: {
      label: "Just Sold Recap", blurb: "Celebrate a closed sale.",
      fields: [
        { key: "salePrice", label: "Sale price", kind: "money", placeholder: "Optional — only if you want it shown" },
        { key: "thankYou", label: "Thank-you message", kind: "text", placeholder: "e.g. Thank you to our wonderful clients!", maxLength: 80 },
        { key: "resultConfirmed", label: "I confirm this result is accurate and can be shown (e.g. “sold over asking”)", kind: "check" },
        { key: "verifiedResult", label: "Result to show", kind: "text", placeholder: "e.g. Sold over asking in 9 days", maxLength: 80, showIf: "resultConfirmed" },
        F.cta,
        F.highlight(1, "Highlight 1"), F.highlight(2, "Highlight 2"),
      ],
    },
  };
  const EVENT_KEYS = Object.keys(EVENTS);

  // ── formatting helpers (pure) ──────────────────────────────────────────────
  // "689000" / "689,000" / "$689,000" -> "$689,000". Anything else (e.g. "From $689K") is kept as typed.
  function formatMoney(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return "";
    const digits = s.replace(/[$,\s]/g, "");
    if (/^\d+(\.\d{1,2})?$/.test(digits)) {
      const n = Number(digits);
      return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    }
    return s;
  }
  // "2026-10-25" -> "Sat, Oct 25" (no timezone shift: parsed as a plain calendar date).
  function formatDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }
  // "13:00" -> "1:00 PM"
  function formatTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
    if (!m) return "";
    let h = +m[1]; const min = m[2];
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${min} ${ap}`;
  }
  const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

  // Common (non-event) fields shown for every event.
  const COMMON_KEYS = ["city", "neighborhood", "beds", "baths", "sqft"];

  // Turn raw form values ({key: string|boolean}) into the storyboard data object.
  // ctx: { address, lengthSec }
  function buildIntake(eventKey, values, ctx) {
    const ev = EVENTS[eventKey];
    if (!ev) throw new Error("Unknown Reel event: " + eventKey);
    const v = values || {};
    const out = { event: eventKey, lengthSec: (ctx && ctx.lengthSec) || 30, address: clean(ctx && ctx.address) };
    for (const k of ["city", "neighborhood"]) if (clean(v[k])) out[k] = clean(v[k]);
    if (clean(v.beds)) out.beds = clean(v.beds);
    if (clean(v.baths)) out.baths = clean(v.baths);
    if (clean(v.sqft)) out.sqft = Number(String(v.sqft).replace(/,/g, "")).toLocaleString("en-US");
    const highlights = [], supporting = [];
    for (const f of ev.fields) {
      const raw = v[f.key];
      if (f.kind === "check") { out[f.key] = !!raw; continue; }
      const val = clean(raw);
      if (!val) continue;
      if (f.showIf && !v[f.showIf]) continue;
      let shown = val;
      if (f.kind === "money") shown = formatMoney(val);
      else if (f.kind === "date") shown = formatDate(val);
      else if (f.kind === "time") shown = formatTime(val);
      if (f.group === "highlights") highlights.push(shown);
      else if (f.group === "supporting") supporting.push(shown);
      else out[f.key] = shown;
    }
    if (highlights.length) out.highlights = highlights;
    if (supporting.length) out.supporting = supporting;
    return out;
  }

  // Returns [] when valid, else a list of human-readable problems.
  function validateIntake(eventKey, values) {
    const ev = EVENTS[eventKey];
    if (!ev) return ["Choose a Reel type."];
    const v = values || {};
    const errs = [];
    for (const f of ev.fields) {
      if (f.showIf && !v[f.showIf]) continue;
      if (f.required && !clean(v[f.key])) errs.push(`${f.label} is required.`);
    }
    if (v.resultConfirmed && eventKey === "just_sold" && !clean(v.verifiedResult)) errs.push("Enter the result to show, or untick the confirmation.");
    const num = (k, label, re) => { if (clean(v[k]) && !re.test(String(v[k]).replace(/,/g, "").trim())) errs.push(`${label} must be a number.`); };
    num("beds", "Beds", /^\d{1,2}$/);
    num("baths", "Baths", /^\d{1,2}(\.5)?$/);
    num("sqft", "Sq ft", /^\d{1,6}$/);
    return errs;
  }

  // ── browser rendering ──────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function fieldHtml(f, values) {
    const id = "ri_" + f.key;
    const val = values[f.key];
    const req = f.required ? ' <span class="ri-req">required</span>' : "";
    const help = f.help ? `<div class="ri-help">${esc(f.help)}</div>` : "";
    if (f.kind === "check") {
      return `<label class="ri-check" id="${id}_wrap"><input type="checkbox" id="${id}" ${val ? "checked" : ""}> <span>${esc(f.label)}</span></label>`;
    }
    const type = f.kind === "date" ? "date" : f.kind === "time" ? "time" : "text";
    const inputmode = f.kind === "money" ? ' inputmode="decimal"' : "";
    const max = f.maxLength ? ` maxlength="${f.maxLength}"` : "";
    const hidden = f.showIf && !values[f.showIf] ? ' style="display:none"' : "";
    return `<div class="ri-field" id="${id}_wrap"${hidden}><label for="${id}">${esc(f.label)}${req}</label>
      <input id="${id}" type="${type}"${inputmode}${max} value="${esc(val == null ? "" : val)}" placeholder="${esc(f.placeholder || "")}">${help}</div>`;
  }

  function readValues(eventKey) {
    const ev = EVENTS[eventKey];
    const v = {};
    const keys = COMMON_KEYS.concat(ev.fields.map((f) => f.key));
    for (const k of keys) {
      const el = document.getElementById("ri_" + k);
      if (!el) continue;
      v[k] = el.type === "checkbox" ? el.checked : el.value;
    }
    return v;
  }

  // Render the event picker + form into `container`.
  // opts: { address, listingDetails:{beds,baths,sqft,year_built}|null, state, onChange, onContinue }
  // state (mutated): { eventKey, lengthSec, values }
  function render(container, opts) {
    const st = opts.state;
    st.values = st.values || {};
    const d = opts.listingDetails || {};
    const prefill = { beds: d.beds, baths: d.baths, sqft: d.sqft };
    for (const k of Object.keys(prefill)) if (st.values[k] === undefined && prefill[k] != null) st.values[k] = String(prefill[k]);

    const cards = EVENT_KEYS.map((k) =>
      `<button type="button" class="ri-card${st.eventKey === k ? " on" : ""}" data-ev="${k}"><b>${esc(EVENTS[k].label)}</b><span>${esc(EVENTS[k].blurb)}</span></button>`).join("");

    let form = "";
    if (st.eventKey) {
      const ev = EVENTS[st.eventKey];
      const common = `
        <div class="ri-group-title">Property</div>
        <div class="ri-field"><label>Address</label><input type="text" value="${esc(opts.address || "")}" disabled></div>
        <div class="ri-row">
          <div class="ri-field"><label for="ri_city">City</label><input id="ri_city" type="text" value="${esc(st.values.city || "")}" placeholder="e.g. Roseville"></div>
          <div class="ri-field"><label for="ri_neighborhood">Neighborhood / community</label><input id="ri_neighborhood" type="text" value="${esc(st.values.neighborhood || "")}" placeholder="Optional"></div>
        </div>
        <div class="ri-row ri-row3">
          <div class="ri-field"><label for="ri_beds">Beds</label><input id="ri_beds" type="text" inputmode="numeric" value="${esc(st.values.beds || "")}"></div>
          <div class="ri-field"><label for="ri_baths">Baths</label><input id="ri_baths" type="text" inputmode="decimal" value="${esc(st.values.baths || "")}"></div>
          <div class="ri-field"><label for="ri_sqft">Sq ft</label><input id="ri_sqft" type="text" inputmode="numeric" value="${esc(st.values.sqft || "")}"></div>
        </div>
        <div class="ri-help">Beds, baths and sq ft come from your saved listing details. Changing them here applies to this Reel only.</div>`;
      const lengths = REEL_LENGTHS.map((l) =>
        `<button type="button" class="ri-len${st.lengthSec === l.sec ? " on" : ""}" data-len="${l.sec}">${l.sec}s<span>${photoRangeText(l)}</span></button>`).join("");
      form = `
        <div class="ri-form">
          <div class="ri-group-title">${esc(ev.label)}</div>
          ${common}
          <div class="ri-group-title">Details for this Reel</div>
          ${ev.fields.map((f) => fieldHtml(f, st.values)).join("")}
          <div class="ri-group-title">Length</div>
          <div class="ri-lens">${lengths}</div>
          <div class="ri-errors" id="ri_errors"></div>
        </div>`;
    }
    container.innerHTML = `<div class="ri-cards">${cards}</div>${form}`;

    const save = () => { if (st.eventKey) st.values = Object.assign(st.values, readValues(st.eventKey)); };
    container.querySelectorAll(".ri-card").forEach((b) => b.addEventListener("click", () => {
      save();
      st.eventKey = b.getAttribute("data-ev");
      render(container, opts);
      if (opts.onChange) opts.onChange(st);
    }));
    container.querySelectorAll(".ri-len").forEach((b) => b.addEventListener("click", () => {
      save();
      st.lengthSec = Number(b.getAttribute("data-len"));
      render(container, opts);
      if (opts.onChange) opts.onChange(st);
    }));
    const confirmEl = container.querySelector("#ri_resultConfirmed");
    if (confirmEl) confirmEl.addEventListener("change", () => {
      const w = container.querySelector("#ri_verifiedResult_wrap");
      if (w) w.style.display = confirmEl.checked ? "" : "none";
    });
    container.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => { save(); if (opts.onChange) opts.onChange(st); }));
  }

  // Validate current form state; returns { ok, errors, intake }.
  function collect(opts) {
    const st = opts.state;
    if (!st.eventKey) return { ok: false, errors: ["Choose a Reel type."], intake: null };
    st.values = Object.assign(st.values || {}, readValues(st.eventKey));
    const errors = validateIntake(st.eventKey, st.values);
    if (!st.lengthSec) errors.push("Choose a Reel length.");
    if (errors.length) return { ok: false, errors, intake: null };
    return { ok: true, errors: [], intake: buildIntake(st.eventKey, st.values, { address: opts.address, lengthSec: st.lengthSec }) };
  }

  const api = { REEL_LENGTHS, photoRangeText, EVENTS, EVENT_KEYS, formatMoney, formatDate, formatTime, buildIntake, validateIntake, render, collect };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReelIntake = api;
})(typeof window !== "undefined" ? window : globalThis);
