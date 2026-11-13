"use strict";

/* Configuration du POC. MAX_PER_CANDIDATE est identique pour tous les candidats (équité). */
const CONFIG = {
  MAX_PER_CANDIDATE: 3,
  AI_CONTEXT_PER_CANDIDATE: 5,
  MIN_RELEVANCE: 2,
  /* Recherche sémantique : modèle exécuté dans le navigateur (le texte ne quitte pas l'appareil).
     Doit correspondre au modèle de scripts/embeddings/build_embeddings.mjs. */
  TRANSFORMERS_URL: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm",
  SEM_WEIGHT: 0.6, /* part du sens dans la pertinence ; le reste vient des mots en commun */
  SEM_TOP_PCT: 0.99,
  MIN_COMBINED: 0.6, /* pertinence minimale (0 à 1) pour qu'une mesure soit retenue */
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

  /* Un fichier en échec (erreur passagère du serveur) est réessayé une fois, puis ignoré,
     pour ne jamais bloquer l'affichage des autres candidats. */
  const loadMeasures = (c) => fetchJSON(c.measures_file)
    .catch(() => new Promise((r) => setTimeout(r, 800)).then(() => fetchJSON(c.measures_file)))
    .catch(() => {
      STATE.loadErrors = (STATE.loadErrors || 0) + 1;
      return { candidate_id: c.id, measures: [] };
    });
  const files = await Promise.all(STATE.candidates.map(loadMeasures));
  if (STATE.loadErrors) showError(`Les mesures de ${STATE.loadErrors} candidat(s) n'ont pas pu être chargées. Rechargez la page.`);
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

/* ---------- Recherche sémantique ---------- */

function setSearchStatus(text) {
  const el = $("#search-status");
  el.textContent = text || "";
  el.hidden = !text;
}

/* Charge une seule fois les vecteurs des mesures et le modèle (mis en cache par le navigateur). */
function ensureSemantic() {
  if (STATE.sem) return STATE.sem;
  STATE.sem = (async () => {
    const files = new Map();
    const progress = (e) => {
      if (e.status !== "progress" || !e.total) return;
      files.set(e.file, [e.loaded, e.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      if (STATE.semWaiting) setSearchStatus(`Chargement du modèle de recherche : ${Math.round((100 * loaded) / total)} % (environ 120 Mo, une seule fois, ensuite gardé en cache).`);
    };
    const [emb, tf] = await Promise.all([fetchJSON("data/embeddings.json"), import(CONFIG.TRANSFORMERS_URL)]);
    tf.env.allowLocalModels = false;
    const extractor = await tf.pipeline("feature-extraction", emb.model, { dtype: emb.dtype, progress_callback: progress });
    const bytes = Uint8Array.from(atob(emb.vectors), (c) => c.charCodeAt(0));
    const vectors = new Int8Array(bytes.buffer);
    const row = new Map(emb.ids.map((id, i) => [id, i]));
    return { extractor, dim: emb.dim, vectors, row };
  })();
  STATE.sem.catch(() => {});
  return STATE.sem;
}

/* Similarité de chaque mesure avec la requête, ou null si le modèle est indisponible. */
async function semanticScores(query) {
  try {
    STATE.semWaiting = true;
    const sem = await ensureSemantic();
    const out = await sem.extractor("query: " + query, { pooling: "mean", normalize: true });
    const q = out.data;
    const sims = new Map();
    for (const m of STATE.measures) {
      const i = sem.row.get(m.id);
      if (i === undefined) continue;
      let dot = 0;
      const base = i * sem.dim;
      for (let k = 0; k < sem.dim; k++) dot += q[k] * sem.vectors[base + k];
      sims.set(m.id, dot / 127);
    }
    return sims;
  } catch (err) {
    console.warn("Recherche sémantique indisponible :", err);
    return null;
  } finally {
    STATE.semWaiting = false;
    setSearchStatus("");
  }
}

/* ---------- Recherche ---------- */

/* Pertinence d'une mesure pour la situation (0 à 1) :
   - avec le modèle : SEM_WEIGHT x similarité de sens (recalée entre la médiane et le
     maximum de la recherche) + (1 - SEM_WEIGHT) x mots en commun (relatifs au maximum) ;
   - sans le modèle : mots en commun seuls.
   Les mesures sous le seuil sont écartées ; la pertinence finale est relative à la
   meilleure mesure trouvée, tous candidats confondus. */
function retrieve(query, limit, sims = null) {
  const qTokens = tokenize(query);
  const themes = detectThemes(qTokens);
  const kw = new Map(STATE.measures.map((m) => [m.id, scoreMeasure(m, qTokens, themes)]));
  const bestKw = Math.max(1, ...kw.values());

  let combined;
  if (sims && sims.size) {
    const sorted = [...sims.values()].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    /* Haut de l'échelle : 99e centile plutôt que le maximum, pour qu'une seule mesure
       très proche n'écrase pas toutes les autres. */
    const max = sorted[Math.floor((sorted.length - 1) * CONFIG.SEM_TOP_PCT)];
    const span = Math.max(1e-6, max - median);
    combined = new Map(STATE.measures.map((m) => {
      const z = Math.min(1, Math.max(0, ((sims.get(m.id) ?? median) - median) / span));
      return [m.id, CONFIG.SEM_WEIGHT * z + (1 - CONFIG.SEM_WEIGHT) * (kw.get(m.id) / bestKw)];
    }));
  } else {
    combined = new Map(STATE.measures.map((m) => [m.id, kw.get(m.id) >= CONFIG.MIN_RELEVANCE ? kw.get(m.id) / bestKw : 0]));
  }
  const threshold = sims && sims.size ? CONFIG.MIN_COMBINED : 1e-9;

  const byCandidate = new Map(STATE.candidates.map((c) => [c.id, []]));
  let best = 0;
  for (const m of STATE.measures) {
    const r = combined.get(m.id);
    if (r >= threshold) {
      byCandidate.get(m.candidate_id)?.push({ measure: m, score: r });
      if (r > best) best = r;
    }
  }
  STATE.relevance = new Map();
  for (const list of byCandidate.values()) for (const x of list) STATE.relevance.set(x.measure.id, best ? x.score / best : 0);
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

/* ---------- Classement ---------- */

/* Score d'un candidat pour une recherche : pour chaque mesure affichée (au plus
   MAX_PER_CANDIDATE), indice de solidité multiplié par sa pertinence pour la situation
   (relative à la meilleure mesure trouvée, entre 0 et 1) ; somme ramenée sur 100.
   Il combine donc le nombre de mesures, leur pertinence et leur solidité. Une mesure
   non notée compte pour 0. À score égal, l'ordre reste tiré au hasard. */
function measureRelevance(m) {
  return STATE.relevance?.get(m.id) ?? 0;
}

function candidateScore(measures) {
  const sum = measures.reduce((acc, m) => acc + (computeScore(m).value ?? 0) * measureRelevance(m), 0);
  return Math.round(sum / CONFIG.MAX_PER_CANDIDATE);
}

function rankSelection(selection) {
  const withMeasures = selection
    .filter((s) => s.measures.length)
    .map((s) => ({ ...s, score: candidateScore(s.measures) }))
    .sort((a, b) => b.score - a.score); /* tri stable : l'ordre aléatoire départage les égalités */
  const without = selection.filter((s) => !s.measures.length);
  return { ranked: withMeasures, without };
}

const NO_MEASURE_GROUPS = [
  { key: "nomatch", title: "Leur programme ne contient pas de mesure intégrée liée à votre situation" },
  { key: "aucun", title: "N'ont encore rien publié sur un site officiel" },
  { key: "inaccessible", title: "Site officiel inaccessible à nos outils" },
];

function renderNoMeasureCard(without) {
  if (!without.length) return null;
  const groups = { nomatch: [], aucun: [], inaccessible: [] };
  for (const { candidate } of without) {
    const key = candidate.program_status === "aucun" || candidate.program_status === "inaccessible" ? candidate.program_status : "nomatch";
    groups[key].push(candidate);
  }
  const byName = (a, b) => (a.sort_name || a.name.split(" ").slice(-1)[0]).localeCompare(b.sort_name || b.name.split(" ").slice(-1)[0], "fr");
  const body = NO_MEASURE_GROUPS.filter((g) => groups[g.key].length).map((g) => `
    <div class="none-group">
      <h4>${escapeHTML(g.title)} <span class="none-count">(${groups[g.key].length})</span></h4>
      <p>${groups[g.key].sort(byName).map((c) => c.program_url
        ? `<a href="${escapeHTML(c.program_url)}" target="_blank" rel="noopener">${escapeHTML(c.name)}</a>`
        : escapeHTML(c.name)).join(", ")}</p>
    </div>`).join("");
  const node = document.createElement("article");
  node.className = "ballot-none";
  node.innerHTML = `<h3>Ces candidats n'ont pas de mesure pour votre situation</h3>${body}
    <p class="none-note">Cela ne signifie pas qu'ils n'ont rien prévu : seules les mesures publiées sur un site officiel et intégrées à l'outil sont prises en compte. Consultez la section <a href="#programmes">Programmes intégrés</a>.</p>`;
  return node;
}

function renderBallots(selection, aiByCandidate) {
  const container = $("#ballots");
  container.innerHTML = "";
  const tpl = $("#ballot-template");
  const { ranked, without } = rankSelection(selection);

  const none = renderNoMeasureCard(without);
  if (none) container.appendChild(none);

  ranked.forEach(({ candidate, measures, score }, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.style.setProperty("--i", i);
    node.classList.add("enter");
    node.querySelector(".ballot-rank").textContent = `${i + 1}`;
    node.querySelector(".ballot-score").textContent = `Score ${score}/100`;
    node.querySelector(".ballot-score").title = "Pour chaque mesure affichée (3 au plus) : indice de solidité × pertinence pour votre situation. Somme ramenée sur 100.";
    node.querySelector(".ballot-name").textContent = candidate.name;
    node.querySelector(".ballot-party").textContent = candidate.party || "";
    const link = node.querySelector(".program-link");
    if (candidate.program_url) link.href = candidate.program_url;
    else link.remove();

    const ai = aiByCandidate?.get(candidate.id);
    if (ai) {
      const box = node.querySelector(".ballot-ai");
      box.hidden = false;
      box.innerHTML = `<p class="ai-label">Explication générée par IA à partir des extraits ci-dessous</p><p>${escapeHTML(ai)}</p>`;
    }

    node.querySelector(".measures").innerHTML = measures.map(renderMeasure).join("");
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

const PROGRAM_STATUS = {
  programme: "Programme publié",
  propositions: "Propositions partielles",
  aucun: "Rien de publié à ce jour",
  inaccessible: "Site officiel inaccessible à nos outils",
};

function renderPrograms() {
  const meta = STATE.meta;
  if (meta.inclusion_rule) $("#programs-rule").textContent = meta.inclusion_rule;
  const counts = new Map();
  for (const m of STATE.measures) counts.set(m.candidate_id, (counts.get(m.candidate_id) || 0) + 1);
  const verified = new Map();
  for (const m of STATE.measures) if (verificationOf(m).status === "verifie") verified.set(m.candidate_id, (verified.get(m.candidate_id) || 0) + 1);

  const lastName = (c) => (c.sort_name || c.name.split(" ").slice(-1)[0]).toLocaleLowerCase("fr");
  const rows = STATE.candidates.slice().sort((a, b) => lastName(a).localeCompare(lastName(b), "fr")).map((c) => {
    const status = c.program_status || "aucun";
    const doc = c.program_url
      ? `<a href="${escapeHTML(c.program_url)}" target="_blank" rel="noopener">${escapeHTML(c.program_title || "Programme officiel")}</a>`
        + (c.program_date ? `<br><small>Publié le ${escapeHTML(formatDate(c.program_date))}</small>` : "")
        + (c.ingested_at ? `<br><small>Consulté le ${escapeHTML(formatDate(c.ingested_at))}</small>` : "")
      : "Aucun document officiel trouvé";
    const n = counts.get(c.id) || 0;
    const v = verified.get(c.id) || 0;
    const declared = c.declared_on ? `<span class="party">Candidature déclarée le ${escapeHTML(formatDate(c.declared_on))}</span>` : "";
    return `<tr>
      <th scope="row">${escapeHTML(c.name)}<span class="party">${escapeHTML(c.party || "")}</span>${declared}</th>
      <td><span class="status-pill status-${escapeHTML(status)}">${escapeHTML(PROGRAM_STATUS[status] || status)}</span></td>
      <td>${doc}</td>
      <td class="num">${n}${n ? `<br><small>${v} vérifiée${v > 1 ? "s" : ""} sur le site</small>` : ""}</td>
    </tr>`;
  }).join("");
  $("#programs-body").innerHTML = rows;

  const total = STATE.measures.length;
  const withProgram = STATE.candidates.filter((c) => (counts.get(c.id) || 0) > 0).length;
  $("#programs-summary").textContent =
    `${STATE.candidates.length} candidats suivis, ${withProgram} avec des mesures intégrées, ${total} mesures au total.` +
    (meta.updated_at ? ` Liste mise à jour le ${formatDate(meta.updated_at)}.` : "");

  if (meta.excluded?.length) {
    $("#programs-excluded").hidden = false;
    $("#programs-excluded-list").innerHTML = meta.excluded.map((e) =>
      `<li><strong>${escapeHTML(e.name)}</strong> : ${escapeHTML(e.reason)}${e.source ? ` <a href="${escapeHTML(e.source)}" target="_blank" rel="noopener">Source</a>` : ""}</li>`).join("");
  }
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
    /* Seuls les candidats ayant au moins une mesure pertinente sont envoyés : les autres affichent déjà un message factuel. */
    selection: selection.filter(({ measures }) => measures.length).map(({ candidate, measures }) => ({ id: candidate.id, measures: measures.map((m) => m.id) })),
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
    button.textContent = "Recherche en cours…";
    const sims = await semanticScores(query);
    STATE.searchKind = sims ? "semantique" : "mots";
    if (mode === "local") {
      const selection = retrieve(query, CONFIG.MAX_PER_CANDIDATE, sims);
      renderBallots(selection, null);
      setResultsMeta(selection, false);
    } else {
      button.textContent = "Analyse en cours…";
      const wide = retrieve(query, CONFIG.AI_CONTEXT_PER_CANDIDATE, sims);
      const ai = wide.some(({ measures }) => measures.length) ? await askClaude(query, wide) : new Map();
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
  const kind = STATE.searchKind === "semantique"
    ? "Recherche par le sens et par les mots, exécutée dans votre navigateur. "
    : "Recherche par mots-clés (le modèle de recherche par le sens n'a pas pu être chargé). ";
  $("#results-meta").textContent = kind +
    `${withHits} programme${withHits > 1 ? "s" : ""} sur ${selection.length} contien${withHits > 1 ? "nent" : "t"} des mesures liées à votre situation. ` +
    `Candidats classés par score : pour chaque mesure affichée (${CONFIG.MAX_PER_CANDIDATE} au plus), pertinence pour votre situation × indice de solidité. Égalités départagées au hasard. Ce score ne juge pas le fond des mesures.` +
    (ai ? " Les explications sont générées par IA et peuvent contenir des erreurs : seul l'extrait du programme fait foi." : "");
}

function init() {
  if (!aiAvailable()) $("#mode-ia-option").hidden = true;
  $("#ask-form").addEventListener("submit", onSubmit);
  /* Le modèle (environ 120 Mo) n'est téléchargé qu'à la première interaction avec le formulaire. */
  const warmUp = () => ensureSemantic();
  $("#situation").addEventListener("focus", warmUp, { once: true });
  document.querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      $("#situation").value = chip.dataset.example;
      ensureSemantic();
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
      renderPrograms();
    })
    .catch((err) => showError(`Les données n'ont pas pu être chargées : ${err.message}`));
}

document.addEventListener("DOMContentLoaded", init);

/* Exposé pour les tests en ligne de commande. */
if (typeof module !== "undefined") module.exports = { tokenize, normalize, sameRoot };
