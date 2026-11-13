/*
 * Calcule les embeddings de toutes les mesures pour la recherche sémantique du site.
 *
 * Usage (depuis la racine du dépôt) :
 *   cd scripts/embeddings && npm install && node build_embeddings.mjs
 *
 * Sortie : data/embeddings.json, lu par le navigateur. Le même modèle (même version,
 * même quantification) est utilisé côté navigateur pour la requête : ne changer l'un
 * qu'avec l'autre (constantes MODEL et DTYPE, et CONFIG.EMBED_* dans assets/app.js).
 * scripts/validate_data.py bloque si le fichier n'est plus à jour.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";

export const MODEL = "Xenova/multilingual-e5-small";
export const DTYPE = "q8";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const data = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/* Texte indexé pour une mesure. Toute modification doit être reportée dans
   passage_text() de scripts/validate_data.py. */
export function passageText(m) {
  return `${m.title}. ${m.summary} ${m.excerpt}`;
}

const sha1 = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);

const meta = data("data/candidates.json");
const measures = meta.candidates.flatMap((c) => data(c.measures_file).measures);
console.log(`${measures.length} mesures, modèle ${MODEL} (${DTYPE})`);

const extractor = await pipeline("feature-extraction", MODEL, { dtype: DTYPE });
const dim = 384;
const vectors = new Int8Array(measures.length * dim);
const BATCH = 32;
for (let i = 0; i < measures.length; i += BATCH) {
  const batch = measures.slice(i, i + BATCH);
  const out = await extractor(batch.map((m) => "passage: " + passageText(m)), { pooling: "mean", normalize: true });
  const arr = out.data;
  for (let j = 0; j < batch.length; j++) {
    for (let k = 0; k < dim; k++) vectors[(i + j) * dim + k] = Math.max(-127, Math.min(127, Math.round(arr[j * dim + k] * 127)));
  }
  process.stdout.write(`\r${Math.min(i + BATCH, measures.length)}/${measures.length}`);
}
process.stdout.write("\n");

writeFileSync(
  join(ROOT, "data/embeddings.json"),
  JSON.stringify({
    model: MODEL,
    dtype: DTYPE,
    dim,
    quantization: "int8, vecteurs normalisés multipliés par 127",
    ids: measures.map((m) => m.id),
    hashes: measures.map((m) => sha1(passageText(m))),
    vectors: Buffer.from(vectors.buffer).toString("base64"),
  }) + "\n",
);
console.log("data/embeddings.json écrit");
