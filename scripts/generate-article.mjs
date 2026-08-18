#!/usr/bin/env node
/**
 * generate-article.mjs — Blog article generator for GardeMalade Cameroun
 * Reads topics.json, queries Tavily for RAG, calls Claude to generate bilingual JSON,
 * downloads an Unsplash image, saves everything, and sends a Brevo notification email.
 *
 * Usage:
 *   node scripts/generate-article.mjs          # normal run
 *   node scripts/generate-article.mjs --dry-run # no writes, no emails
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const LOCK_FILE        = '/tmp/gardemalade-blog.lock';
const TOPICS_PATH      = path.join(__dirname, 'topics.json');
const SOURCES_PATH     = path.join(__dirname, 'trusted-sources.json');
const CONTENT_DIR      = path.join(ROOT, 'src/content/blog');
const IMAGES_DIR       = path.join(ROOT, 'public/blog/images');
const INDEX_PATH       = path.join(CONTENT_DIR, '_index.json');

// ── CLI flags ─────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

// ── Load .env ─────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const TAVILY_API_KEY     = process.env.TAVILY_API_KEY     || '';
const UNSPLASH_ACCESS_KEY= process.env.UNSPLASH_ACCESS_KEY|| '';
const BREVO_API_KEY      = process.env.BREVO_API_KEY      || '';
const BREVO_FROM_EMAIL   = process.env.BREVO_FROM_EMAIL   || '';
const BREVO_TO_EMAIL     = process.env.BREVO_TO_EMAIL     || '';

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Lock file ─────────────────────────────────────────────────────────────────

function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    const content = readFileSync(LOCK_FILE, 'utf8').trim();
    const age = Date.now() - parseInt(content || '0', 10);
    if (age < 60 * 60 * 1000) { // 1 hour
      throw new Error(`Lock file exists (PID started ${Math.round(age / 60000)}m ago). Aborting.`);
    }
    log('Stale lock file found, removing.');
  }
  if (!DRY_RUN) writeFileSync(LOCK_FILE, String(Date.now()), 'utf8');
}

function releaseLockSync() {
  try {
    if (!DRY_RUN && existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {}
}

// ── Slug helper ───────────────────────────────────────────────────────────────

function slugify(text) {
  const map = {
    'à':'a','â':'a','ä':'a','é':'e','è':'e','ê':'e','ë':'e',
    'î':'i','ï':'i','ô':'o','ö':'o','ù':'u','û':'u','ü':'u',
    'ç':'c','æ':'ae','œ':'oe','ñ':'n','ý':'y',
  };
  return text
    .toLowerCase()
    .split('').map(c => map[c] || c).join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ── Load index ────────────────────────────────────────────────────────────────

function loadIndex() {
  if (!existsSync(INDEX_PATH)) return [];
  try { return JSON.parse(readFileSync(INDEX_PATH, 'utf8')); } catch { return []; }
}

// ── Topic selection ───────────────────────────────────────────────────────────

function pickTopic(topics, existingArticles) {
  const existingSlugs = new Set(existingArticles.map(a => a.slug));
  const existingKeywords = existingArticles.flatMap(a =>
    [a.focus_keyword_fr || '', a.focus_keyword_en || '']
      .join(' ').toLowerCase().split(/\s+/).filter(w => w.length > 4)
  );

  // Flatten all topics
  const allTopics = [];
  for (const [catKey, cat] of Object.entries(topics.categories)) {
    for (const t of cat.topics) {
      allTopics.push({ ...t, category: catKey, categoryLabel: cat.label });
    }
  }

  // Filter out already published topics
  const available = allTopics.filter(t => {
    if (existingSlugs.has(t.id)) return false;
    const topicText = (t.fr + ' ' + t.en).toLowerCase();
    const overlap = existingKeywords.filter(kw => topicText.includes(kw)).length;
    return overlap < 3;
  });

  if (available.length === 0) {
    log('All topics used, cycling back to full list');
    const shuffled = [...allTopics].sort(() => Math.random() - 0.5);
    return shuffled[0];
  }

  // Rotate by category — pick the least-used category
  const catCounts = {};
  for (const a of existingArticles) catCounts[a.category] = (catCounts[a.category] || 0) + 1;
  available.sort((a, b) => (catCounts[a.category] || 0) - (catCounts[b.category] || 0));

  // Shuffle within same-priority group
  const minCount = catCounts[available[0].category] || 0;
  const sameMin = available.filter(t => (catCounts[t.category] || 0) === minCount);
  return sameMin[Math.floor(Math.random() * sameMin.length)];
}

// ── Tavily RAG ────────────────────────────────────────────────────────────────

async function searchTavily(queries, domains) {
  if (!TAVILY_API_KEY) {
    log('TAVILY_API_KEY missing — skipping RAG search');
    return [];
  }

  const results = [];
  const seen = new Set();

  for (const query of queries.slice(0, 3)) {
    log(`Tavily search: "${query}"`);
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query,
          search_depth: 'advanced',
          include_domains: domains,
          max_results: 4,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!res.ok) {
        log(`Tavily HTTP ${res.status} for "${query}"`);
        continue;
      }
      const data = await res.json();
      for (const r of (data.results || [])) {
        if (!seen.has(r.url)) {
          seen.add(r.url);
          results.push(r);
        }
      }
    } catch (err) {
      log(`Tavily error: ${err.message}`);
    }
  }

  results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return results.slice(0, 8);
}

// ── Build prompts ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `Tu es un expert en santé et soins à domicile au Cameroun (Douala et Yaoundé). Tu rédiges des articles de blog SEO bilingues (français ET anglais) pour GardeMalade Cameroun, un service de garde-malades et d'auxiliaires de vie à domicile.

━━━ RÈGLES ABSOLUES — ZÉRO EXCEPTION ━━━

ANTI-HALLUCINATION :
• N'invente JAMAIS de statistiques, études, citations ou chiffres précis
• Si tu cites un chiffre, il DOIT provenir d'une des sources fournies, avec attribution dans le champ "sources"
• Si les sources ne couvrent pas un point : rédige en termes généraux vérifiables, sans inventer de données
• Jamais de "selon des études" sans citer l'étude réelle avec son URL
• Les chiffres en FCFA doivent être réalistes pour le Cameroun (1 EUR ≈ 655 FCFA)

CONTEXTE CAMEROUNAIS (obligatoire) :
• Quartiers réels : Bonanjo, Akwa, Bonapriso, Makepe (Douala) ; Bastos, Nlongkak, Omnisports, Melen (Yaoundé)
• Monnaie : FCFA (franc CFA d'Afrique centrale)
• Noms africains/camerounais : Marie-Claire, Emmanuel, Sandrine, Hervé, Adjoua, Théodore, Solange, Jean-Baptiste
• Hôpitaux réels : Hôpital Laquintinie (Douala), CHU de Yaoundé, Clinique La Croix du Sud, Hôpital Central de Yaoundé
• Opérateurs télécom : MTN Cameroun, Orange Cameroun (pour Mobile Money)
• Système de santé : mixte public/privé, médecine traditionnelle présente

AUDIENCE DOUBLE :
• Français : familles au Cameroun + diaspora africaine francophone (France, Belgique, Canada)
• Anglais : diaspora anglophone (UK, USA, Cameroun anglophone — Buea, Bamenda)
Les deux langues doivent être NATURELLES, pas une traduction mécanique.
L'anglais cible un lecteur de la diaspora qui cherche depuis l'étranger.

LIENS INTERNES (obligatoire) :
Toujours inclure 2-3 liens internes vers les pages du site :
• /services — page services principale
• /contact — formulaire de contact
• /services#garde — service garde-malade spécifiquement
• /services#auxiliaire — service auxiliaire de vie
• /services#medical — service médical à domicile
• /blog — liste des articles

LONGUEUR : 800-1 200 mots par langue
STRUCTURE : 3-4 sections H2, 4-6 FAQ, 1 conclusion avec CTA
STYLE : professionnel mais chaleureux, sans jargon excessif
FORMAT DE RÉPONSE : JSON UNIQUEMENT — sans balises markdown autour du JSON`;
}

function buildUserPrompt(topic, ragResults, existingArticles) {
  const ragContext = ragResults.length > 0
    ? ragResults.map((r, i) =>
        `[SOURCE ${i + 1}]\nTitre : ${r.title}\nURL : ${r.url}\nContenu : ${(r.content || '').slice(0, 700)}`
      ).join('\n\n---\n\n')
    : 'Aucune source web récupérée — rédige en termes généraux vérifiables sans inventer de données précises.';

  const recentArticles = existingArticles.slice(0, 6).map(a =>
    `• [${a.slug}] ${a.title_fr} (catégorie: ${a.category})`
  ).join('\n') || '(Aucun encore publié)';

  const today = new Date().toISOString().slice(0, 10);
  const slug = slugify(topic.fr);

  return `SUJET FRANÇAIS : ${topic.fr}
SUJET ANGLAIS : ${topic.en}
MOT-CLÉ FR : ${topic.focus_keyword_fr}
MOT-CLÉ EN : ${topic.focus_keyword_en}
CATÉGORIE : ${topic.categoryLabel}
DATE : ${today}
SLUG : ${slug}

SOURCES RÉCUPÉRÉES (base exclusive pour toute donnée chiffrée) :
${ragContext}

ARTICLES DÉJÀ PUBLIÉS (éviter la répétition — utiliser pour liens internes) :
${recentArticles}

TÂCHE :
Rédige un article de blog SEO complet, bilingue (FR + EN), dans le format JSON exact ci-dessous.

PERSONNAGES FICTIFS (à utiliser dans au moins une anecdote) :
• Marie-Claire Essomba, infirmière à Douala (quartier Bonapriso), 12 ans d'expérience
• Emmanuel Nkodo, fils de patient vivant à Lyon, s'occupe de sa mère à Yaoundé à distance
• Dr. Sandrine Mballa, médecin généraliste, CHU de Yaoundé
• Hervé Tchamba, patient post-opératoire, 68 ans, Akwa (Douala)
• Adjoua Fouda, auxiliaire de vie certifiée, 5 ans d'expérience à Douala

INSTRUCTIONS HTML pour le champ "body" des sections :
• Utilise <p> pour les paragraphes
• Utilise <strong> pour l'emphase
• Utilise <ul><li> pour les listes
• PAS de H1, H2, H3 dans body (les headings sont dans le champ "heading")
• Les liens internes : <a href="/services">nos services</a>

Retourne UNIQUEMENT ce JSON (sans balises markdown) :
{
  "meta": {
    "slug": "${slug}",
    "date": "${today}",
    "title": { "fr": "Titre SEO 55-65 caractères avec mot-clé", "en": "SEO title 55-65 chars with keyword" },
    "description": { "fr": "Description SEO 140-158 caractères", "en": "SEO description 140-158 chars" },
    "focus_keyword": { "fr": "${topic.focus_keyword_fr}", "en": "${topic.focus_keyword_en}" },
    "reading_time": 6,
    "category": "${topic.category}",
    "tags": ["garde-malade", "cameroun", "plus 2-3 tags pertinents"],
    "internal_links": [
      { "href": "/services#garde", "text": { "fr": "notre service garde-malade", "en": "our caregiver service" } }
    ]
  },
  "hero": {
    "src": "/blog/images/${slug}.jpg",
    "alt": { "fr": "Description alt image en français", "en": "Image alt description in English" },
    "photographer": null,
    "photographer_url": null,
    "photo_url": null,
    "unsplash_id": null
  },
  "body_images": [],
  "content": {
    "chapeau": {
      "fr": "2-3 phrases d'introduction accrocheuses qui posent le problème et annoncent la valeur de l'article",
      "en": "2-3 engaging intro sentences that frame the problem and announce the article's value"
    },
    "sections": [
      {
        "heading": { "fr": "Titre de section H2 en français", "en": "Section H2 heading in English" },
        "body": {
          "fr": "<p>Contenu HTML détaillé de la section en français (200-300 mots). Inclure des exemples concrets, des chiffres si sources disponibles, des anecdotes avec personnages camerounais.</p>",
          "en": "<p>Detailed HTML content in English (200-300 words). Target diaspora reader. Natural English, not mechanical translation.</p>"
        },
        "image": null
      }
    ],
    "faq": [
      {
        "question": { "fr": "Question fréquente en français ?", "en": "Frequent question in English?" },
        "answer": { "fr": "Réponse détaillée et pratique en français.", "en": "Detailed practical answer in English." }
      }
    ],
    "conclusion": {
      "fr": "Paragraphe de conclusion avec CTA vers /contact ou /services (150-200 mots).",
      "en": "Conclusion paragraph with CTA toward /contact or /services (150-200 words)."
    },
    "cta": {
      "text": { "fr": "Demandez une évaluation gratuite", "en": "Request a free assessment" },
      "href": "/contact"
    }
  },
  "sources": [
    { "title": "Nom de la page", "url": "https://url-exacte.com", "org": "Nom de l'organisme" }
  ],
  "related": [],
  "schema": {
    "faq_items": []
  }
}

RAPPELS CRITIQUES :
1. sections : exactement 3-4 sections H2
2. faq : exactement 4-6 questions/réponses
3. Chaque section body doit faire 200-300 mots par langue
4. Les sections EN doivent être naturelles, ciblant un Camerounais de la diaspora anglophone
5. Inclure au moins une anecdote avec un personnage camerounais nommé
6. Sources : inclure uniquement les URLs des sources réellement utilisées depuis les données RAG fournies`;
}

// ── Claude API call ───────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userPrompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');

  log('Calling Claude claude-sonnet-4-6...');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  let text = (data.content?.[0]?.text || '').trim();

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  const article = JSON.parse(text);
  if (!article?.meta?.slug) throw new Error('Invalid JSON from Claude: missing meta.slug');
  return article;
}

// ── Unsplash image ────────────────────────────────────────────────────────────

const UNSPLASH_QUERIES = [
  'african nurse caregiver black woman',
  'african elderly care family',
  'black healthcare worker patient',
  'african doctor home visit',
  'cameroon healthcare',
  'healthcare caregiver',
];

async function fetchUnsplashImage(slug, customQueries = []) {
  if (!UNSPLASH_ACCESS_KEY) {
    log('UNSPLASH_ACCESS_KEY missing — skipping image');
    return null;
  }

  const queries = [...new Set([...customQueries, ...UNSPLASH_QUERIES])];

  for (const query of queries) {
    log(`Unsplash query: "${query}"`);
    try {
      const searchRes = await fetch(
        `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=landscape&content_filter=high`,
        {
          headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!searchRes.ok) {
        log(`Unsplash HTTP ${searchRes.status} for "${query}"`);
        continue;
      }

      const photo = await searchRes.json();
      if (!photo?.urls?.raw) continue;

      const photoId = photo.id;

      // Trigger download endpoint (required by Unsplash API Terms)
      fetch(`https://api.unsplash.com/photos/${photoId}/download`, {
        headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});

      // Download image (1200×630)
      const imgUrl = `${photo.urls.raw}?w=1200&h=630&fit=crop&crop=center`;
      const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(30000) });
      if (!imgRes.ok) continue;

      const imgBuffer = await imgRes.arrayBuffer();
      if (imgBuffer.byteLength < 10000) continue;

      if (!DRY_RUN) {
        mkdirSync(IMAGES_DIR, { recursive: true });
        writeFileSync(path.join(IMAGES_DIR, `${slug}.jpg`), Buffer.from(imgBuffer));
      }
      log(`Image saved: ${slug}.jpg (${Math.round(imgBuffer.byteLength / 1024)}KB)`);

      return {
        photographer: photo.user?.name || 'Unsplash',
        photographer_url: `${photo.user?.links?.html || 'https://unsplash.com'}?utm_source=gardemalade&utm_medium=referral`,
        photo_url: `${photo.links?.html || 'https://unsplash.com'}?utm_source=gardemalade&utm_medium=referral`,
        unsplash_id: photoId,
        alt_fallback: photo.alt_description || query,
      };
    } catch (err) {
      log(`Unsplash error for "${query}": ${err.message}`);
    }
  }

  log('No Unsplash image found — article will have no hero image');
  return null;
}

// ── Estimate reading time ─────────────────────────────────────────────────────

function estimateReadingTime(article) {
  const allText = JSON.stringify(article.content || '').replace(/<[^>]+>/g, ' ');
  const wordCount = allText.split(/\s+/).filter(Boolean).length;
  return Math.max(3, Math.ceil(wordCount / 220));
}

// ── Save article ──────────────────────────────────────────────────────────────

function saveArticle(article, imageData) {
  const slug = article.meta.slug;

  // Merge image data
  if (imageData) {
    article.hero.photographer = imageData.photographer;
    article.hero.photographer_url = imageData.photographer_url;
    article.hero.photo_url = imageData.photo_url;
    article.hero.unsplash_id = imageData.unsplash_id;
    if (!article.hero.alt?.fr && imageData.alt_fallback) {
      article.hero.alt = { fr: imageData.alt_fallback, en: imageData.alt_fallback };
    }
  }

  // Fix reading time
  article.meta.reading_time = estimateReadingTime(article);

  // Populate schema.faq_items from content.faq
  if (article.content?.faq?.length) {
    article.schema.faq_items = article.content.faq.map(q => ({
      question: q.question,
      answer: q.answer,
    }));
  }

  const filePath = path.join(CONTENT_DIR, `${slug}.json`);
  if (!DRY_RUN) {
    mkdirSync(CONTENT_DIR, { recursive: true });
    writeFileSync(filePath, JSON.stringify(article, null, 2), 'utf8');
    log(`Article saved: ${filePath}`);
  } else {
    log(`[DRY-RUN] Would save article to: ${filePath}`);
  }

  return article;
}

// ── Update index ──────────────────────────────────────────────────────────────

function updateIndex(article) {
  const index = loadIndex();
  const slug = article.meta.slug;

  // Remove existing entry if re-generating
  const filtered = index.filter(a => a.slug !== slug);

  const entry = {
    slug,
    date: article.meta.date,
    title_fr: article.meta.title.fr,
    title_en: article.meta.title.en,
    description_fr: article.meta.description.fr,
    description_en: article.meta.description.en,
    focus_keyword_fr: article.meta.focus_keyword.fr,
    focus_keyword_en: article.meta.focus_keyword.en,
    category: article.meta.category,
    tags: article.meta.tags || [],
    reading_time: article.meta.reading_time,
    hero_src: article.hero.src,
    hero_alt_fr: article.hero.alt?.fr || '',
    hero_alt_en: article.hero.alt?.en || '',
    chapeau_fr: article.content.chapeau.fr,
    chapeau_en: article.content.chapeau.en,
  };

  filtered.unshift(entry);
  filtered.sort((a, b) => b.date.localeCompare(a.date));

  if (!DRY_RUN) {
    writeFileSync(INDEX_PATH, JSON.stringify(filtered, null, 2), 'utf8');
    log(`Index updated: ${filtered.length} articles`);
  } else {
    log(`[DRY-RUN] Would update index with ${filtered.length + 1} articles`);
  }

  return filtered;
}

// ── Send Brevo email ──────────────────────────────────────────────────────────

async function sendBrevoEmail(subject, htmlContent) {
  if (!BREVO_API_KEY || !BREVO_FROM_EMAIL || !BREVO_TO_EMAIL) {
    log('Brevo not configured — skipping email notification');
    return;
  }

  if (DRY_RUN) {
    log('[DRY-RUN] Would send email: ' + subject);
    return;
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: BREVO_FROM_EMAIL, name: 'GardeMalade Blog Generator' },
        to: [{ email: BREVO_TO_EMAIL }],
        subject,
        htmlContent,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      log('Email notification sent');
    } else {
      log(`Brevo error: HTTP ${res.status}`);
    }
  } catch (err) {
    log(`Brevo send failed: ${err.message}`);
  }
}

function buildSuccessEmail(article) {
  const slug = article.meta.slug;
  const titleFr = article.meta.title.fr;
  const date = article.meta.date;
  return {
    subject: `[GardeMalade Blog] Nouvel article publié — ${titleFr}`,
    html: `
<h2>Nouvel article de blog généré</h2>
<p><strong>Titre :</strong> ${titleFr}</p>
<p><strong>Slug :</strong> <code>${slug}</code></p>
<p><strong>Date :</strong> ${date}</p>
<p><strong>Catégorie :</strong> ${article.meta.category}</p>
<p><strong>Temps de lecture :</strong> ${article.meta.reading_time} min</p>
<p><strong>URL :</strong> <a href="https://gardemalade-cm.com/blog/${slug}">gardemalade-cm.com/blog/${slug}</a></p>
<hr>
<p><strong>Intro FR :</strong> ${article.content.chapeau.fr}</p>
<p><em>Mode :</em> ${DRY_RUN ? 'DRY-RUN (aucun fichier écrit)' : 'Production'}</p>
    `.trim(),
  };
}

function buildErrorEmail(error, topic) {
  return {
    subject: `[GardeMalade Blog] ERREUR génération article`,
    html: `
<h2>Erreur lors de la génération d'article</h2>
<p><strong>Sujet :</strong> ${topic?.fr || 'Inconnu'}</p>
<p><strong>Erreur :</strong> <code>${error.message}</code></p>
<p><strong>Stack :</strong><pre>${error.stack || ''}</pre></p>
<p><strong>Date :</strong> ${new Date().toISOString()}</p>
    `.trim(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting GardeMalade blog generator${DRY_RUN ? ' [DRY-RUN]' : ''}`);

  acquireLock();

  let topic = null;

  try {
    // 1. Load data
    const topicsData = JSON.parse(readFileSync(TOPICS_PATH, 'utf8'));
    const sourcesData = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
    const existingArticles = loadIndex();

    log(`Existing articles: ${existingArticles.length}`);

    // 2. Pick topic
    topic = pickTopic(topicsData, existingArticles);
    log(`Selected topic: ${topic.fr}`);
    log(`Category: ${topic.categoryLabel}`);

    // 3. RAG search with Tavily
    const tavily_queries_fr = [
      `${topic.focus_keyword_fr} Cameroun`,
      `soins domicile ${topic.category === 'couts' ? 'tarif coût FCFA' : 'conseils guide'} Cameroun`,
    ];
    const tavily_queries_en = [
      `${topic.focus_keyword_en} Cameroon`,
    ];

    const ragResults = await searchTavily(
      [...tavily_queries_fr, ...tavily_queries_en],
      sourcesData.domains
    );
    log(`RAG results: ${ragResults.length} sources found`);

    // 4. Generate article with Claude
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(topic, ragResults, existingArticles);
    const article = await callClaude(systemPrompt, userPrompt);
    log(`Article generated: "${article.meta?.title?.fr}"`);

    // 5. Download Unsplash image
    const imageData = await fetchUnsplashImage(article.meta.slug, topic.unsplash_queries || []);

    // 6. Save article
    const savedArticle = saveArticle(article, imageData);

    // 7. Update index
    updateIndex(savedArticle);

    // 8. Send success email
    const { subject, html } = buildSuccessEmail(savedArticle);
    await sendBrevoEmail(subject, html);

    log('Generation complete!');
    if (DRY_RUN) {
      log('[DRY-RUN] Article JSON preview:');
      log(JSON.stringify({
        slug: savedArticle.meta.slug,
        title_fr: savedArticle.meta.title.fr,
        title_en: savedArticle.meta.title.en,
        sections_count: savedArticle.content.sections.length,
        faq_count: savedArticle.content.faq.length,
        has_image: !!imageData,
      }, null, 2));
    }

    process.exit(0);
  } catch (err) {
    log(`FATAL ERROR: ${err.message}`);
    console.error(err.stack);

    // Send error email
    try {
      const { subject, html } = buildErrorEmail(err, topic);
      await sendBrevoEmail(subject, html);
    } catch {}

    process.exit(1);
  } finally {
    releaseLockSync();
  }
}

main();
