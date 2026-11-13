"use strict";

/* Configuration du POC. MAX_PER_CANDIDATE est identique pour tous les candidats (équité). */
const CONFIG = {
  MAX_PER_CANDIDATE: 3,
  AI_CONTEXT_PER_CANDIDATE: 5,
  MIN_RELEVANCE: 2,
  /* URL du Worker Cloudflare qui détient la clé API (voir worker/). Vide = mode IA masqué. */
  AI_PROXY_URL: "https://presidentielle-2027-ia.colianos.workers.dev/explain",
};

const STATE = {
  meta: null,
  candidates: [],
  measures: [],
  grid: null,
  themes: {},
  verification: {},
};

const STOPWORDS = new Set(("le la les un une des de du d l et ou mais donc or ni car a au aux en dans par pour sur sous avec sans ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te se y ne pas plus moins tres trop est suis es sommes etes sont ai as avons avez ont etre avoir fait faire qui que quoi dont ou quand comme si tout tous toute toutes chaque autre autres meme aussi bien mal peu beaucoup encore deja jamais toujours rien chose cela ca ici depuis entre vers chez lors alors puis apres avant pendant").split(" "));

/* ---------- Utilitaires ---------- */

const $ = (sel) => document.querySelector(sel);

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9\s]/g, " ");
}

function stem(token) {
  return token.replace(/(aux|eaux)$/, "al").replace(/(s|x)$/, "");
}

function tokenize(text) {
  return normalize(text)
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

function sameRoot(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return n >= 5 && a.slice(0, 5) === b.slice(0, 5);
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Impossible de charger ${path} (${res.status})`);
  return res.json();
}

/* ---------- Chargement ---------- */

async function loadData() {
  const [meta, grid, themes, verification] = await Promise.all([
    fetchJSON("data/candidates.json"),
    fetchJSON("data/credibility.json"),
    fetchJSON("data/themes.json"),
    fetchJSON("data/verification.json").catch(() => ({ results: {} })),
  ]);
  STATE.meta = meta;
  STATE.candidates = meta.candidates;
  STATE.grid = grid;
  STATE.verification = verification.results || {};
  STATE.verificationDate = verification.generated_at;

  STATE.themes = {};
  for (const [theme, words] of Object.entries(themes)) {
    STATE.themes[theme] = words.flatMap(tokenize);
  }

  const files = await Promise.all(STATE.candidates.map((c) => fetchJSON(c.measures_file)));
  STATE.measures = files.flatMap((file) =>
    file.measures.map((m) => {
      const indexText = [m.title, m.summary, m.excerpt, (m.tags || []).join(" "), m.theme].join(" ");
      return { ...m, candidate_id: file.candidate_id, _tokens: tokenize(indexText), _theme: m.theme };
    })
  );
}

/* ---------- Recherche locale ---------- */

function detectThemes(queryTokens) {
  const found = new Set();
  for (const [theme, words] of Object.entries(STATE.themes)) {
    if (queryTokens.some((q) => words.some((w) => sameRoot(q, w)))) found.add(theme);
  }
  return found;
}

function scoreMeasure(measure, queryTokens, themes) {
  let score = 0;
  for (const q of new Set(queryTokens)) {
    if (measure._tokens.some((t) => sameRoot(q, t))) score += 1;
  }
  if (themes.has(measure._theme)) score += 3;
  return score;
}

function retrieve(query, limit) {
  const qTokens = tokenize(query);
  const themes = detectThemes(qTokens);
  const byCandidate = new Map(STATE.candidates.map((c) => [c.id, []]));
  for (const m of STATE.measures) {
    const s = scoreMeasure(m, qTokens, themes);
    if (s >= CONFIG.MIN_RELEVANCE) byCandidate.get(m.candidate_id)?.push({ measure: m, score: s });
  }
  return shuffle(STATE.candidates).map((candidate) => ({
    candidate,
    measures: (byCandidate.get(candidate.id) || [])
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.measure),
  }));
}

/* ---------- Indice de solidité ---------- */

function verificationOf(measure) {
  return STATE.verification[measure.id] || { status: "non_verifie" };
}

function computeScore(measure) {
  const grid = STATE.grid;
  const rows = [];
  let weighted = 0;
  let weightSum = 0;
  let evaluated = 0;

  for (const crit of grid.criteria) {
    const entry = measure.credibility?.[crit.id];
    const def = entry && crit.values[entry.value];
    const usable = def && (!crit.requires_source || entry.source_url);
    rows.push({ id: crit.id, label: crit.label, question: crit.question, weight: crit.weight, points: usable ? def.points : null, valueLabel: usable ? def.label : null, entry: usable ? entry : null });
    if (usable) {
      weighted += crit.weight * def.points;
      weightSum += crit.weight;
      evaluated += 1;
    }
  }

  const v = grid.verification;
  const vr = verificationOf(measure);
  const vdef = v.statuses[vr.status] || v.statuses.non_verifie;
  rows.push({ id: v.id, label: v.label, question: v.question, weight: v.weight, points: vdef.points, valueLabel: vdef.label, entry: null });
  if (vdef.points !== null) {
    weighted += v.weight * vdef.points;
    weightSum += v.weight;
    evaluated += 1;
  }

  const total = grid.criteria.length + 1;
  const enough = evaluated >= (grid.min_criteres_pour_noter || 2);
  return { rows, evaluated, total, value: enough && weightSum ? Math.round((100 * weighted) / weightSum) : null };
}

/* ---------- Rendu ---------- */

function renderScore(measure) {
  const s = computeScore(measure);
  const segs = s.rows.map((r) => {
    const label = `${r.label} (poids ${r.weight}) : ${r.points === null ? "non évalué" : r.valueLabel}`;
    const inner = r.points === null ? "" : `<span style="width:${Math.round(r.points * 100)}%"></span>`;
    return `<span class="score-seg${r.points === null ? " na" : ""}" style="flex:${r.weight}" title="${escapeHTML(label)}">${inner}</span>`;
  }).join("");

  const headline = s.value === null
    ? `<span class="score-figure"><span class="score-value">Non noté</span> <span class="score-note">pas assez d'éléments sourcés</span></span>`
    : `<span class="score-figure"><span class="score-value">${s.value}/100</span> <span class="score-note">${s.evaluated} critères sur ${s.total} renseignés</span></span>`;

  const details = s.rows.map((r) => {
    let detail = r.points === null ? "Non évalué : aucun élément sourcé pour l'instant." : escapeHTML(r.valueLabel);
    if (r.entry?.note) detail += `. ${escapeHTML(r.entry.note)}`;
    if (r.entry?.source_url) detail += ` <a href="${escapeHTML(r.entry.source_url)}" target="_blank" rel="noopener">Source</a>`;
    return `<dt>${escapeHTML(r.label)} <span class="score-note">(poids ${r.weight})</span></dt><dd>${detail}</dd>`;
  }).join("");

  return `
    <div class="score">
      <div class="score-line"><span class="score-label">Indice de solidité</span>${headline}</div>
      <div class="score-bar" role="img" aria-label="Détail de l'indice : ${s.rows.map((r) => `${r.label} ${r.points === null ? "non évalué" : Math.round(r.points * 100) + " %"}`).join(", ")}">${segs}</div>
      <details class="criteria"><summary>Voir le détail des critères</summary><dl>${details}</dl></details>
    </div>`;
}

function renderVerification(measure) {
  const vr = verificationOf(measure);
  const def = STATE.grid.verification.statuses[vr.status] || STATE.grid.verification.statuses.non_verifie;
  const look = { verifie: ["ok", "✓"], approchant: ["warn", "≈"], introuvable: ["ko", "✕"], domaine_non_officiel: ["ko", "✕"] }[vr.status] || ["unknown", "?"];
  const when = vr.checked_at ? `, contrôlé le ${formatDate(vr.checked_at)}` : "";
  const demo = vr.demo ? " (statut fictif)" : "";
  const numbers = vr.chiffres_absents?.length ? `. Chiffre absent de la source : ${vr.chiffres_absents.join(", ")}` : "";
  return `<p class="verif ${look[0]}"><span class="verif-icon" aria-hidden="true">${look[1]}</span><span>${escapeHTML(def.label)}${when}${escapeHTML(numbers)}${demo}</span></p>`;
}

function renderMeasure(measure) {
  const vr = verificationOf(measure);
  const archive = vr.archive_url ? `<a href="${escapeHTML(vr.archive_url)}" target="_blank" rel="noopener">Version archivée</a>` : "";
  return `
    <li class="measure" id="m-${escapeHTML(measure.id)}">
      <h4>${escapeHTML(measure.title)}</h4>
      <p class="summary">${escapeHTML(measure.summary)}</p>
      ${renderScore(measure)}
      ${renderVerification(measure)}
      <details class="criteria">
        <summary>Lire l'extrait du programme</summary>
        <blockquote class="excerpt">« ${escapeHTML(measure.excerpt)} »<br><small>${escapeHTML(measure.source?.locator || "")}</small></blockquote>
      </details>
      <p class="measure-links">
        <a href="${escapeHTML(measure.source?.url)}" target="_blank" rel="noopener">Voir sur le site officiel</a>
        ${archive}
      </p>
    </li>`;
}

function renderBallots(selection, aiByCandidate) {
  const container = $("#ballots");
  container.innerHTML = "";
  const tpl = $("#ballot-template");

  selection.forEach(({ candidate, measures }, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.style.setProperty("--i", i);
    node.classList.add("enter");
    node.querySelector(".ballot-name").textContent = candidate.name;
    node.querySelector(".ballot-party").textContent = candidate.party || "";
    const link = node.querySelector(".program-link");
    link.href = candidate.program_url;

    const ai = aiByCandidate?.get(candidate.id);
    if (ai) {
      const box = node.querySelector(".ballot-ai");
      box.hidden = false;
      box.innerHTML = `<p class="ai-label">Explication générée par IA à partir des extraits ci-dessous</p><p>${escapeHTML(ai)}</p>`;
    }

    const list = node.querySelector(".measures");
    list.innerHTML = measures.length
      ? measures.map(renderMeasure).join("")
      : `<li class="empty">Aucune mesure de ce programme ne correspond à votre description. Consultez le programme complet pour vérifier.</li>`;
    container.appendChild(node);
  });
}

function renderMethod() {
  const g = STATE.grid;
  $("#method-principle").textContent = g.principe;
  const rows = [...g.criteria, g.verification].map((c) => `
    <div class="method-row">
      <div class="method-weight">${c.weight}</div>
      <div><h3>${escapeHTML(c.label)}</h3><p>${escapeHTML(c.question)}</p></div>
    </div>`).join("");
  $("#method-grid").innerHTML = rows;
}

function renderMeta() {
  if (STATE.meta.demo) $("#demo-banner").hidden = false;
  const parts = [];
  if (STATE.meta.updated_at) parts.push(`Programmes mis à jour le ${formatDate(STATE.meta.updated_at)}.`);
  if (STATE.verificationDate) parts.push(`Dernière vérification automatique le ${formatDate(STATE.verificationDate)}.`);
  $("#data-meta").textContent = parts.join(" ");
}

/* ---------- Mode IA (via le proxy, la clé n'est jamais dans le navigateur) ---------- */

function aiAvailable() {
  return /^(https:\/\/[^/]+|http:\/\/localhost:\d+)\/explain$/.test(CONFIG.AI_PROXY_URL) && !CONFIG.AI_PROXY_URL.includes("REMPLACER");
}

async function askClaude(query, selection) {
  /* Le Worker relit lui-même les extraits officiels : on n'envoie que le texte et les identifiants. */
  const body = {
    query,
    selection: selection.map(({ candidate, measures }) => ({ id: candidate.id, measures: measures.map((m) => m.id) })),
  };
  let res;
  try {
    res = await fetch(CONFIG.AI_PROXY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Le service d'explication par IA est injoignable. Réessayez ou utilisez la recherche locale.");
  }
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed.error || `Le service d'explication par IA a répondu avec une erreur ${res.status}.`);

  /* Garde-fou : on ne garde que les candidats et mesures réellement fournis. */
  const allowed = new Map(selection.map(({ candidate, measures }) => [candidate.id, new Set(measures.map((m) => m.id))]));
  const out = new Map();
  for (const item of parsed.candidats || []) {
    if (!allowed.has(item.id) || typeof item.explication !== "string") continue;
    out.set(item.id, {
      text: item.explication.replace(/\u2014/g, ",").slice(0, 600),
      measures: (item.mesures || []).filter((id) => allowed.get(item.id).has(id)),
    });
  }
  return out;
}

/* ---------- Interactions ---------- */

function showError(message) {
  const el = $("#form-error");
  el.textContent = message;
  el.hidden = !message;
}

async function onSubmit(event) {
  event.preventDefault();
  showError("");
  const query = $("#situation").value.trim();
  if (query.length < 10) {
    showError("Décrivez votre situation en une phrase au moins pour obtenir des mesures pertinentes.");
    return;
  }
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const results = $("#results");
  const button = $("#submit-btn");

  if (mode === "ia") {
    if (!$("#ia-consent").checked) return showError("Cochez la case d'accord pour envoyer votre texte à Anthropic, ou choisissez la recherche locale.");
  }

  button.disabled = true;
  results.hidden = false;
  results.setAttribute("aria-busy", "true");

  try {
    if (mode === "local") {
      const selection = retrieve(query, CONFIG.MAX_PER_CANDIDATE);
      renderBallots(selection, null);
      setResultsMeta(selection, false);
    } else {
      button.textContent = "Analyse en cours…";
      const wide = retrieve(query, CONFIG.AI_CONTEXT_PER_CANDIDATE);
      const ai = await askClaude(query, wide);
      const selection = wide.map(({ candidate, measures }) => {
        const cited = ai.get(candidate.id)?.measures || [];
        const ordered = [...measures.filter((m) => cited.includes(m.id)), ...measures.filter((m) => !cited.includes(m.id))];
        return { candidate, measures: ordered.slice(0, CONFIG.MAX_PER_CANDIDATE) };
      });
      const texts = new Map([...ai].map(([id, v]) => [id, v.text]));
      renderBallots(selection, texts);
      setResultsMeta(selection, true);
    }
    results.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  } catch (err) {
    showError(err.message || "Une erreur est survenue. Réessayez en recherche locale.");
  } finally {
    button.disabled = false;
    button.textContent = "Voir les propositions";
    results.setAttribute("aria-busy", "false");
  }
}

function setResultsMeta(selection, ai) {
  const withHits = selection.filter((s) => s.measures.length).length;
  $("#results-meta").textContent =
    `${withHits} programme${withHits > 1 ? "s" : ""} sur ${selection.length} contien${withHits > 1 ? "nent" : "t"} des mesures liées à votre situation. ` +
    `Ordre des candidats tiré au hasard. ${CONFIG.MAX_PER_CANDIDATE} mesures au plus par candidat.` +
    (ai ? " Les explications sont générées par IA et peuvent contenir des erreurs : seul l'extrait du programme fait foi." : "");
}

function init() {
  if (!aiAvailable()) $("#mode-ia-option").hidden = true;
  $("#ask-form").addEventListener("submit", onSubmit);
  document.querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      $("#situation").value = chip.dataset.example;
      $("#situation").focus();
    })
  );
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      $("#ia-settings").hidden = document.querySelector('input[name="mode"]:checked').value !== "ia";
    })
  );

  loadData()
    .then(() => {
      renderMethod();
      renderMeta();
    })
    .catch((err) => showError(`Les données n'ont pas pu être chargées : ${err.message}`));
}

document.addEventListener("DOMContentLoaded", init);

/* Exposé pour les tests en ligne de commande. */
if (typeof module !== "undefined") module.exports = { tokenize, normalize, sameRoot };
