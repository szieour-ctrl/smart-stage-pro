// lib/agent-marketing-series-lib.js — Netlify (shared, pure functions). Nov 28, 2026.
// ONE schema-driven intake for the seven Agent Marketing templates that are built from the agent's own experience, plus the reel-series (follow-up) helpers.
//
// Every template defines, in data:
//   angles      editorial angles (stored in the project's existing `angle` column and in intake.angle)
//   audiences   who the reel is for (intake.audience)
//   topics      the focused subject (intake.topic); `topicFor` limits which angles ask for one, `topicRequiredFor` which require it
//   questions   conditional choice/text questions (`when` shows a question only for some angles; `requiredWhen` requires it; `carry` marks answers a follow-up keeps)
//   firsthand   the agent's own words (intake.firsthand): a prompt per angle, required for some angles
//   writing     template-specific writing and storyboard instructions given to the shared planner
// Local Market Insider keeps its own schema in agent-marketing-intake.js; nothing here changes it.
// Anything not in a schema is dropped by validateSeriesIntake(), so property-sale fields cannot ride along.
"use strict";

const cut = (v, max) => {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return s.length > max ? s.slice(0, max) : s;
};
const LIMITS = { firsthand: 600, text: 400, title: 90, review: 600 };

// Rules shared by every template's writing instructions.
const COMMON_WRITING = [
  "This is the agent speaking about their own work, in their own voice, to a person who may never have met them. The agent's own words (agents_firsthand_observation and every answer in template_brief.answers) are the only source of personal facts.",
  "Never invent credentials, years of experience, client stories, results, testimonials, statistics, prices, builder incentives or local figures. Anything the agent did not give you is general guidance stated as such.",
  "Each reel stands alone: it opens with its own context and ends with its own call to action, so it makes sense when viewed out of order. A follow-up (series_recap present) covers a NEW angle and never repeats the earlier episode's example or takeaway.",
  "The editorial angle decides the hook and the story structure. The audience decides the stakes and the example. The topic and the agent's own method decide the substance.",
  "SHOT LENGTH: no scene is longer than 10 seconds (about 25 spoken words); aim for 8 to 10. A beat that needs more time is split across two scenes with different pictures. The opening and the closing may be shorter when the narration calls for it, and must each stay inside 10 seconds because they can be lip synced (the combined lip-sync budget is 20 seconds).",
  "AGENT_PROFILE is for the opening and the closing only. AGENT_SCENE (the agent in a generic supporting setting) may be used up to 2 times in this reel, in the middle; every AGENT_SCENE scene sets \"pose\" to the ONE id from available_poses whose posture fits what that scene shows, and its ai_generation_prompt describes only the setting, the gaze, the hand action and the mood. Every other scene sets \"pose\": null. If available_poses is empty, use AGENT_SCENE at most once and set \"pose\": null.",
  "Other scenes use renderer-built graphic cards (BRAND_CARD, card_text at most 8 words) or generic concept images with no people. Never show a listing, an address, a price or a sale call to action.",
  "In every scene object of your JSON also include \"pose\": string|null (an id from available_poses, or null).",
];

const AUD = {
  sellers: ["General sellers", "Move-up sellers", "Downsizers", "Relocating sellers"],
  buyers: ["General buyers", "First-time buyers", "Move-up buyers", "Relocation buyers", "Downsizing buyers", "New-home buyers"],
};

const TEMPLATES = {
  meet_your_agent: {
    template: "meet_your_agent", label: "Meet Your Agent",
    purpose: "Make the introduction personal through motivation, working style and a concrete example of how the agent helps.",
    angleQuestion: "What should viewers learn about you?",
    angles: {
      introduce: { label: "Introduce me", flow: "Hook → motivation → working style → what a first conversation is like → invitation", firsthandPrompt: "What do clients appreciate about your approach? (one short example; optional but strongly encouraged)", firsthandRequired: false },
      shaped: { label: "What shaped my approach", flow: "Hook → the experience → what it taught → how it changes the advice → invitation", firsthandPrompt: "Describe one real repair, prep job or experience that shaped how you advise people.", firsthandRequired: true },
      how: { label: "How I work", flow: "Hook → one real opening question → how the answer guides the next step → invitation", firsthandPrompt: "What is one real question you ask, and how does the answer help you and the person decide what to explore next?", firsthandRequired: true },
      client: { label: "Speak to a specific client", flow: "Hook naming the client's situation → what you say, ask or do → what changes for them → invitation", firsthandPrompt: "What is one thing you actually say, ask, or do for this kind of client?", firsthandRequired: true },
    },
    audienceQuestion: "Who is this reel for?",
    audiences: ["General audience", "Sellers", "Buyers", "Homeowners weighing a move", "Downsizers", "New-home buyers"],
    topics: [],
    questions: [
      { key: "motivation", label: "What motivates you most?", type: "choice", options: ["Helping big decisions", "Solving complex problems", "Serving my community", "Guiding a next chapter"], carry: true },
      { key: "clientStyle", label: "How do clients describe you?", type: "choice", options: ["Straightforward", "Warm and patient", "Detailed and strategic", "Proactive"], carry: true },
    ],
    cta: "Let's talk about your next chapter.",
    writing: ["Template: Meet Your Agent. Beats: introduce yourself → share your motivation → show your working style → give one practical example → invite a conversation. The practical example is the agent's own firsthand account, told in their words; with none, keep the example an anonymous description of the process and say nothing about specific clients."],
  },
  why_list_with_me: {
    template: "why_list_with_me", label: "Why List With Me",
    purpose: "Show how the agent helps a seller make a better preparation, pricing, presentation or timing decision.",
    angleQuestion: "What should this reel do?",
    angles: {
      strategy: { label: "Show my strategy", flow: "Name the seller decision → the costly assumption → your specific strategy → what the seller gains → next step", firsthandPrompt: "What specifically do you do differently? One short professional example.", firsthandRequired: true },
      assumption: { label: "Challenge a seller assumption", flow: "The common assumption → what it costs → what you do instead → what the seller gains → next step", firsthandPrompt: "What assumption do sellers bring, and what do you do about it?", firsthandRequired: true },
      decision: { label: "Walk through a seller decision", flow: "The decision → the trade-off → how you help weigh it → what the seller gains → next step", firsthandPrompt: "Which trade-off do you walk sellers through, and how?", firsthandRequired: true },
    },
    audienceQuestion: "Which sellers is this for?", audiences: AUD.sellers,
    topicQuestion: "What seller challenge do you solve?", topics: ["Pricing", "Preparation", "Presentation", "Timing"], topicFor: ["strategy", "assumption", "decision"], topicRequiredFor: ["strategy", "assumption", "decision"],
    questions: [
      { key: "valueArea", label: "Where do you add the most value?", type: "choice", options: ["Strategy", "Repairs and staging", "Marketing", "Negotiation"], carry: true },
      { key: "gain", label: "What should sellers gain?", type: "choice", options: ["Clear plan", "Confidence", "Less stress", "Better positioning"], carry: true },
    ],
    cta: "Ask for a preparation and pricing conversation.",
    writing: ["Template: Why List With Me. Beats: name the seller decision → surface the assumption → show your strategy → explain the benefit → offer a next step. Use general marketing visuals and the agent's own methods. Never use active or pending listing photos, or any listing-specific price, address or sale content."],
  },
  your_buyer_advantage: {
    template: "your_buyer_advantage", label: "Your Buyer Advantage",
    purpose: "Show how buyer representation helps someone compare options and understand trade-offs before committing.",
    angleQuestion: "What should this reel do?",
    angles: {
      introduce: { label: "Introduce my buyer services", flow: "Raise a buyer misconception → how you help compare homes and see trade-offs → how you prepare an offer → next step", firsthandPrompt: "How do you protect a buyer's decision? A short personal method (optional but encouraged).", firsthandRequired: false },
      pitfall: { label: "Explain a common pitfall", title: "Buyer Pitfalls", flow: "The pitfall → the consequence → what you do to help → how the buyer decides → next step", firsthandPrompt: "What do buyers tend to overlook, and what do you do to help?", firsthandRequired: true },
      walkthrough: { label: "Walk through a decision", flow: "The decision → the first step → the trade-off you explain → how the buyer chooses → next step", firsthandPrompt: "What is the first step you take, and which trade-off do you explain?", firsthandRequired: true },
    },
    audienceQuestion: "Which buyers is this for?", audiences: AUD.buyers,
    topicQuestion: "Choose one topic", topics: ["Inspections", "Offer terms", "Negotiations", "Purchase and sale timing"], topicFor: ["pitfall", "walkthrough"], topicRequiredFor: ["pitfall", "walkthrough"],
    questions: [
      { key: "feel", label: "What should they feel?", type: "choice", options: ["Prepared", "Confident", "In control"], carry: true },
    ],
    cta: "Start with a buyer strategy conversation.",
    writing: ["Template: Your Buyer Advantage. Beats: raise a misconception or pitfall → make the consequence visible → explain how you help → show the buyer's decision as two illustrative paths → offer a next step. Use generic categories for payments, condition, due diligence and negotiation; any example figure must come from the agent."],
  },
  my_proven_process: {
    template: "my_proven_process", label: "My Proven Process",
    purpose: "Make a repeatable agent method tangible by showing the sequence and what the client receives.",
    angleQuestion: "What should this reel show?",
    angles: {
      overview: { label: "Walk through my process", flow: "Name the uncertainty → the first action → the method in sequence → what the client gets → first step", firsthandPrompt: "What is the first useful step you take? Give the exact action.", firsthandRequired: true },
      firststep: { label: "Start with the first step", flow: "Name the uncertainty → the exact first step → why it comes first → what happens next → first step", firsthandPrompt: "What is the first useful step you take? Give the exact action.", firsthandRequired: true },
      deliverable: { label: "Show what the client gets", flow: "Name the uncertainty → what the client receives → how it is used → the decision it helps resolve → first step", firsthandPrompt: "What does the client actually receive, and how do they use it?", firsthandRequired: true },
    },
    audienceQuestion: "Who is the process for?", audiences: ["Sellers", "Buyers", "Downsizers", "New-home buyers"],
    topicQuestion: "Where are people unsure?", topics: ["Starting", "Choices", "Pricing", "Timing", "Negotiating"], topicFor: ["overview", "firststep", "deliverable"], topicRequiredFor: ["overview", "firststep", "deliverable"],
    questions: [
      { key: "difference", label: "What makes your process different?", type: "choice", options: ["Custom plan", "Education", "Preparation", "Communication", "Specialty"], carry: true },
      { key: "outcome", label: "What outcome matters?", type: "choice", options: ["Clarity", "Confidence", "Organization", "Better decisions"], carry: true },
      { key: "steps", label: "What are the steps after the first one? (short)", type: "text", max: 400, requiredWhen: { angle: ["overview"] } },
    ],
    cta: "Ask what the first step would look like for you.",
    writing: ["Template: My Proven Process. Beats: name the uncertainty → give the first action → walk through the method → show what the client gets → offer a first step. Use the word \"proven\" only as the template's title; never claim an outcome the agent did not state. Use the agent's own steps and deliverable."],
  },
  new_construction_specialist: {
    template: "new_construction_specialist", label: "New Construction Specialist",
    purpose: "Explain an important builder decision and what the buyer should compare before moving forward.",
    angleQuestion: "What should this reel do?",
    angles: {
      decision: { label: "Open on a builder decision", flow: "The builder decision → what it changes → what you check → one buyer tip → comparison invitation", firsthandPrompt: "Share one buyer tip: one short real-world observation.", firsthandRequired: true },
      compare: { label: "What to compare", flow: "The surprising detail → what to compare side by side → how you help → one buyer tip → comparison invitation", firsthandPrompt: "Share one buyer tip: one short real-world observation.", firsthandRequired: true },
      tip: { label: "One buyer tip", flow: "The tip → why it matters → what to compare → comparison invitation", firsthandPrompt: "What is the one tip you give new-home buyers? One short real-world observation.", firsthandRequired: true },
    },
    audienceQuestion: "Which buyers is this for?", audiences: ["New-home buyers", "First-time buyers", "Move-up buyers", "Downsizing buyers"],
    topicQuestion: "What surprises buyers?", topics: ["Incentives", "Upgrades", "Lot differences", "Timelines", "Contract terms"], topicFor: ["decision", "compare", "tip"], topicRequiredFor: ["decision", "compare", "tip"],
    questions: [
      { key: "productType", label: "Which product types?", type: "choice", options: ["Quick move-in", "To-be-built", "Active adult", "Luxury"], carry: true },
      { key: "compare", label: "What must buyers compare?", type: "choice", options: ["Price", "Financing", "Lot", "Included features", "Delivery"], carry: true },
    ],
    cta: "Ask for help comparing new-home options.",
    writing: ["Template: New Construction Specialist. Beats: open on a builder decision → show the comparison → explain what you check → give one buyer tip → invite a comparison. Never name a builder, a community, an incentive, a term or availability unless the agent wrote it. Use generic design imagery."],
  },
  active_adult_55_specialist: {
    template: "active_adult_55_specialist", label: "55+ Active Adult Specialist",
    purpose: "Help people compare housing and lifestyle choices around their own priorities.",
    angleQuestion: "What should this reel do?",
    angles: {
      transition: { label: "Open with a transition question", flow: "A transition question → the concern → the options → a concrete trade-off → conversation invitation", firsthandPrompt: "What have you learned from these conversations? Optional short firsthand insight.", firsthandRequired: false },
      options: { label: "Compare how you'd live", flow: "The priority → two ways of living compared → what each trades away → conversation invitation", firsthandPrompt: "What have you learned from these conversations? Optional short firsthand insight.", firsthandRequired: false },
      insight: { label: "Share what I've learned", flow: "The insight → the situation behind it → what it means for the decision → conversation invitation", firsthandPrompt: "What have you learned from these conversations?", firsthandRequired: true },
    },
    audienceQuestion: "Who is this reel for?", audiences: ["Homeowners considering a move", "Downsizers", "Relocating buyers"],
    topicQuestion: "What starts the discussion?", topics: ["Maintenance", "Stairs", "Lifestyle", "Simplify", "Proximity to family"], topicFor: ["transition", "options", "insight"], topicRequiredFor: ["transition", "options", "insight"],
    questions: [
      { key: "concern", label: "What concerns clients?", type: "choice", options: ["Memories", "Timing", "Values", "Community fit", "Logistics"], carry: true },
      { key: "clarify", label: "What do you clarify?", type: "choice", options: ["Lifestyle", "Single-story plans", "Community choices", "Coordination"], carry: true },
      { key: "seeking", label: "What are they seeking?", type: "choice", options: ["Freedom", "Convenience", "Connection", "Simpler living"], carry: true },
    ],
    cta: "Talk through what you want in your next chapter.",
    writing: ["Template: 55+ Active Adult Specialist. Beats: open with a transition question → name the concern → present the options → show a concrete trade-off → invite a conversation. Speak to individual preferences and never make age-based assumptions about the viewer. Name no community unless the agent did."],
  },
  agent_review_highlights: {
    template: "agent_review_highlights", label: "Agent Review Highlights",
    purpose: "Connect faithful client feedback to one specific aspect of the agent's work.",
    angleQuestion: "What should this reel do?",
    angles: {
      highlight: { label: "Highlight a client review", flow: "Introduce the agent → the review excerpt (verbatim) → the service behind it → the source and rating → invitation", firsthandPrompt: "", firsthandRequired: false },
      theme: { label: "Explain the service behind a review", flow: "Introduce the agent → the review excerpt (verbatim) → what that looks like in practice → invitation", firsthandPrompt: "What do you do that this review is describing? (one short example; optional)", firsthandRequired: false },
    },
    audienceQuestion: "Who is this reel for?", audiences: ["General audience", "Sellers", "Buyers"],
    topics: [],
    questions: [
      { key: "source", label: "Where is the review published?", type: "choice", options: ["Google", "Zillow", "Realtor.com", "Other supported source"], required: true },
      { key: "reviewText", label: "What is the source review? Paste the exact text.", type: "text", max: 600, required: true },
      { key: "rating", label: "What rating was actually attached?", type: "choice", options: ["Source rating", "No rating"], required: true },
      { key: "ratingValue", label: "Rating shown on the source (1 to 5)", type: "number", min: 1, max: 5, requiredWhen: { rating: ["Source rating"] }, when: { rating: ["Source rating"] } },
      { key: "strength", label: "What strength does it reflect?", type: "choice", options: ["Communication", "Expertise", "Patience", "Negotiation", "Care"], required: true },
      { key: "attested", label: "I am authorized to advertise this review, and the text, source and rating are authentic and accurate.", type: "attest", required: true },
    ],
    cta: "Invite viewers to talk about the same kind of support.",
    writing: ["Template: Agent Review Highlights. Beats: introduce the agent → show the first excerpt → explain the service theme → return to the evidence → close with an invitation. The review text in template_brief.answers.reviewText is quoted EXACTLY and only extractively: never paraphrase it inside quotation marks, never add to it, never invent a second review. Stars appear only when answers.rating is \"Source rating\" and then only the stated value; for an unrated review use quote artwork and mention no rating. The excerpt and its source are shown on screen by a renderer-built quote card (BRAND_CARD, card_text = the source name)."],
  },
};
const KEYS = Object.keys(TEMPLATES);
const isSeriesTemplate = (t) => !!TEMPLATES[t];
const schemaFor = (t) => TEMPLATES[t] || null;

// ── Intake validation ───────────────────────────────────────────────────────────────────────────────────────────────
const inList = (cond, values) => Object.entries(cond || {}).every(([k, allowed]) => allowed.includes(String(values[k] == null ? "" : values[k])));

/** Which questions apply for these values (the ones whose `when` holds). */
function visibleQuestions(schema, values) {
  const v = values || {};
  return schema.questions.filter((q) => !q.when || inList(q.when, v));
}
const topicAsked = (schema, angle) => !!(schema.topics.length && (schema.topicFor || []).includes(angle));
const topicRequired = (schema, angle) => !!(schema.topics.length && (schema.topicRequiredFor || []).includes(angle));
const firsthandOf = (schema, angle) => (schema.angles[angle] || {}).firsthandPrompt || "";

/** The public title the subscriber can edit, built from the template, angle, audience and topic. */
function suggestTitle(template, clean) {
  const s = TEMPLATES[template];
  if (!s) return "";
  const a = s.angles[clean.angle] || {};
  const aud = clean.audience && !/^general/i.test(clean.audience) ? clean.audience : "";
  if (template === "your_buyer_advantage") {
    if (a.title && clean.topic) return `${a.title} · ${clean.topic}`;
    return aud ? `${s.label} for ${aud.replace(/\b([a-z])/g, (c) => c.toUpperCase())}` : s.label;
  }
  if (template === "meet_your_agent") {
    if (clean.angle === "introduce") return s.label;
    return a.label || s.label;
  }
  return [s.label, clean.topic || a.label].filter(Boolean).join(" · ");
}

/**
 * validateSeriesIntake(template, values) → { ok, errors: [{field, message}], clean, needsInput }
 * `clean` holds ONLY known keys: angle, audience, topic, firsthand, publicTitle and the template's own answers. Server-set keys (series_recap) are never accepted from the client.
 */
function validateSeriesIntake(template, values) {
  const schema = TEMPLATES[template];
  if (!schema) return { ok: false, errors: [{ field: "template", message: "Unknown template." }], clean: {}, needsInput: [] };
  const v = values && typeof values === "object" ? values : {};
  const errors = [], clean = {}, needsInput = [];
  const err = (field, message) => errors.push({ field, message });

  const angle = String(v.angle || "");
  if (!schema.angles[angle]) err("angle", `Choose an answer for "${schema.angleQuestion}".`);
  else clean.angle = angle;

  clean.audience = String(v.audience || schema.audiences[0]);
  if (!schema.audiences.includes(clean.audience)) err("audience", "Choose who this reel is for.");

  if (topicAsked(schema, clean.angle)) {
    clean.topic = String(v.topic || "");
    if (clean.topic && !schema.topics.includes(clean.topic)) err("topic", "Choose a topic from the list.");
    else if (!clean.topic && topicRequired(schema, clean.angle)) err("topic", `Choose one: ${schema.topicQuestion}`);
  } else clean.topic = "";

  const shown = { ...v, angle: clean.angle, audience: clean.audience, topic: clean.topic };
  for (const q of visibleQuestions(schema, shown)) {
    const raw = v[q.key];
    const required = q.required === true || (q.requiredWhen && inList(q.requiredWhen, shown));
    const blank = raw == null || String(raw).trim() === "";
    if (q.type === "attest") {
      clean[q.key] = raw === true || raw === "true";
      if (required && !clean[q.key]) err(q.key, "Confirm you are authorized to advertise this review.");
      continue;
    }
    if (blank) { if (required) err(q.key, `Answer: ${q.label}`); else clean[q.key] = q.type === "number" ? null : ""; continue; }
    if (q.type === "choice") { clean[q.key] = String(raw); if (!q.options.includes(clean[q.key])) err(q.key, `Choose one for: ${q.label}`); }
    else if (q.type === "number") { const n = Number(raw); clean[q.key] = n; if (!(n >= q.min && n <= q.max)) err(q.key, `${q.label}: use a number from ${q.min} to ${q.max}.`); }
    else { const t = cut(raw, (q.max || LIMITS.text) + 1); if (t.length > (q.max || LIMITS.text)) err(q.key, `Keep this to ${q.max || LIMITS.text} characters or fewer.`); clean[q.key] = t.slice(0, q.max || LIMITS.text); }
  }

  const fhRequired = !!(schema.angles[clean.angle] && schema.angles[clean.angle].firsthandRequired);
  const fh = cut(v.firsthand, LIMITS.firsthand + 1);
  if (fh.length > LIMITS.firsthand) err("firsthand", `Keep this to ${LIMITS.firsthand} characters or fewer.`);
  clean.firsthand = fh.slice(0, LIMITS.firsthand);
  if (!clean.firsthand) { if (fhRequired) err("firsthand", "Add one thing you actually say, ask or do. This reel is told from your own experience."); else if (firsthandOf(schema, clean.angle)) needsInput.push("firsthand"); }

  const title = cut(v.publicTitle, LIMITS.title + 1);
  if (title.length > LIMITS.title) err("publicTitle", `Keep the title to ${LIMITS.title} characters or fewer.`);
  clean.publicTitle = title.slice(0, LIMITS.title) || suggestTitle(template, clean);
  return { ok: errors.length === 0, errors, clean, needsInput };
}

/** What the page needs to draw the form, for every series template. */
function clientSchema(t) {
  const s = TEMPLATES[t];
  return {
    key: t, label: s.label, purpose: s.purpose, series: true, cta: s.cta,
    angleQuestion: s.angleQuestion, angles: Object.fromEntries(Object.entries(s.angles).map(([k, a]) => [k, { label: a.label, firsthandPrompt: a.firsthandPrompt, firsthandRequired: !!a.firsthandRequired, topic: topicAsked(s, k), topicRequired: topicRequired(s, k) }])),
    audienceQuestion: s.audienceQuestion || "Who is this reel for?", audiences: s.audiences, topicQuestion: s.topicQuestion || "", topics: s.topics,
    questions: s.questions, limits: LIMITS,
  };
}

// ── Planner support ─────────────────────────────────────────────────────────────────────────────────────────────────
/** The hash input for a series template (the shared intakeHash adds these keys only for these templates, so Local Market Insider hashes are unchanged). */
const HASH_KEYS = ["topic", "firsthand", "publicTitle"];
function hashExtra(template, intake) {
  const s = TEMPLATES[template];
  if (!s) return [];
  const i = intake || {};
  return HASH_KEYS.concat(s.questions.map((q) => q.key)).map((k) => [k, i[k] == null ? "" : i[k]]);
}

function templateBrief(project) {
  const s = TEMPLATES[project.template];
  if (!s) return null;
  const i = project.intake || {};
  const a = s.angles[i.angle] || {};
  const answers = Object.fromEntries(s.questions.filter((q) => i[q.key] != null && i[q.key] !== "" && q.type !== "attest").map((q) => [q.key, i[q.key]]));
  return {
    purpose: s.purpose, editorial_angle: a.label || null, story_flow: a.flow || null, topic: i.topic || null, public_title: i.publicTitle || null,
    questions_and_answers: s.questions.filter((q) => answers[q.key] != null).map((q) => ({ question: q.label, answer: answers[q.key] })), answers,
    default_call_to_action: s.cta,
  };
}

/** Extra system-prompt rules for a series template. Local Market Insider gets none, so its prompt stays byte-identical. */
function systemRules(template) {
  const s = TEMPLATES[template];
  if (!s) return [];
  return ["", "TEMPLATE RULES (these apply to this reel in addition to the rules above; where a rule above limits how many AGENT_SCENE or AGENT_PROFILE scenes there are, these rules decide)", ...COMMON_WRITING.map((t, n) => `T${n + 1}. ${t}`), ...s.writing.map((t, n) => `T${COMMON_WRITING.length + n + 1}. ${t}`)];
}

// ── Series (follow-up) helpers ──────────────────────────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The lineage for a new follow-up of `source`: both references set at creation, never by the client. */
function lineageFor(source) {
  const root = source.series_root_project_id || source.id;
  return { source_project_id: source.id, series_root_project_id: root };
}
/** The intake a follow-up starts with: the answers marked `carry` and the audience; angle, topic and firsthand input are always fresh. */
function carriedIntake(template, intake, recap) {
  const s = TEMPLATES[template];
  const i = intake || {};
  const out = {};
  if (s) {
    if (i.audience) out.audience = i.audience;
    s.questions.filter((q) => q.carry && i[q.key]).forEach((q) => { out[q.key] = i[q.key]; });
  } else {
    ["market", "audience"].forEach((k) => { if (i[k]) out[k] = i[k]; });   // Local Market Insider: the topic and its evidence stay with the original project
  }
  if (recap) out.series_recap = recap;
  return out;
}
/** A short recap of the source for the new draft and the planner: its title, angle, topic and approved takeaway. */
function recapOf(source, episodes) {
  const s = TEMPLATES[source.template];
  const i = source.intake || {};
  const n = source.narrative_approved || {};
  const label = s ? s.label : "Local Market Insider";
  const angle = s && s.angles[i.angle] ? s.angles[i.angle].label : (i.angle || "");
  const takeaway = cut(n.editorialAngle || n.hook || (n.captionText ? String(n.captionText).split(/(?<=[.!?])\s+/)[0] : ""), 240);
  return {
    sourceId: source.id, title: cut(i.publicTitle || label, LIMITS.title), template: source.template, angle, topic: i.topic || "", takeaway,
    episodes: (episodes || []).slice(0, 12).map((e) => ({ id: e.id, title: cut((e.intake && e.intake.publicTitle) || label, LIMITS.title), topic: (e.intake && e.intake.topic) || "", angle: (e.intake && e.intake.angle) || "" })),
  };
}
/** The recap the planner sees: only the facts needed to avoid repeating the earlier episode. */
function plannerRecap(intake) {
  const r = intake && intake.series_recap;
  if (!r || typeof r !== "object") return null;
  return { earlier_episode_title: r.title, earlier_angle: r.angle, earlier_topic: r.topic, earlier_takeaway: r.takeaway, already_covered: (r.episodes || []).map((e) => e.title) };
}

module.exports = { TEMPLATES, KEYS, LIMITS, UUID_RE, isSeriesTemplate, schemaFor, clientSchema, validateSeriesIntake, visibleQuestions, suggestTitle, hashExtra, templateBrief, systemRules, lineageFor, carriedIntake, recapOf, plannerRecap, cut };
