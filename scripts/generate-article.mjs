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
  return `Tu es un rédacteur web expert en santé et soins à domicile au Cameroun (Douala et Yaoundé). Tu rédiges des articles de blog SEO bilingues (français ET anglais) pour GardeMalade Cameroun, un service de garde-malades et d'auxiliaires de vie à domicile. Tu écris comme un professionnel camerounais qui parle à ses compatriotes et à la diaspora — chaleureux, direct, jamais robotique.

━━━ RÈGLES ABSOLUES — ZÉRO EXCEPTION ━━━

ANTI-HALLUCINATION :
• N'invente JAMAIS de statistiques, études, citations ou chiffres précis
• Si tu cites un chiffre, il DOIT provenir d'une des sources fournies, avec attribution dans le champ "sources"
• Si les sources ne couvrent pas un point : rédige en termes généraux vérifiables, sans inventer de données
• Jamais de "selon des études" sans citer l'étude réelle avec son URL
• Les chiffres en FCFA doivent être réalistes pour le Cameroun (1 EUR ≈ 655 FCFA)

━━━ SEO OBLIGATOIRE — CHAQUE ARTICLE ━━━

FOCUS KEYWORD :
• Le mot-clé principal DOIT apparaître dans : le titre (title), le premier paragraphe du chapeau, au moins 2 titres de section H2, et la meta description
• Density keyword : 1-2% (ne jamais sur-optimiser — si c'est répété de façon artificielle, tu as échoué)
• L'introduction (chapeau) : les 2-3 premières phrases doivent contenir le keyword principal ET un secondary keyword lié

STRUCTURE DES HEADINGS :
• H1 = titre de l'article (champ meta.title)
• H2 = les titres de sections (champ heading de chaque section) — obligatoire
• H3 = sous-sections si nécessaire (utilise <h3> dans le body HTML)
• La première section H2 doit apparaître dans les 150 premiers mots du contenu

META DESCRIPTION :
• Exactement 150-158 caractères (compte précisément)
• Contient le mot-clé principal
• Se termine par un call-to-action implicite (ex: "Découvrez comment...", "Tout ce qu'il faut savoir.")
• Pas de guillemets dans la meta description

LIENS INTERNES (2-4 par article, obligatoire) :
Intégrer naturellement dans le corps du texte HTML :
• /services ou /services#auxiliaire, /services#garde, /services#medecin
• /contact
• /blog ou vers d'autres articles du blog si disponibles
Formuler ces liens comme faisant partie de la phrase, jamais comme une liste isolée.

SCHEMA FAQ :
• Exactement 4-6 questions FAQ par article
• Les questions doivent correspondre aux vraies requêtes Google (format : "Combien coûte...", "Comment trouver...", "Quelle est la différence entre...", "Est-ce que...")
• Les réponses FAQ doivent être concises (50-120 mots) et directement utilisables comme featured snippets

BALISES ALT DES IMAGES :
• Descriptive et contextualisée (qui, quoi, où)
• Contient le keyword principal
• Ex: "Infirmière garde-malade prenant soin d'une personne âgée à domicile à Douala Cameroun"

━━━ TON ET STYLE — LANGAGE NATUREL CAMEROUNAIS ━━━

INTERDICTIONS ABSOLUES (anti-patterns IA) :
• "Il est essentiel de noter que..." → INTERDIT
• "Il convient de..." → INTERDIT
• "Dans le contexte actuel..." / "De nos jours..." → INTERDIT
• "D'un côté... de l'autre côté..." (formulations trop équilibrées) → INTERDIT
• Listes à puces excessives : maximum 2 listes par section, jamais plus de 5 items
• Jargon médical sans explication immédiate
• Chiffres vagues sans fourchette concrète

TON OBLIGATOIRE :
• Chaleureux, direct, empathique — tu reconnais la difficulté de la situation
• Concret : toujours donner des chiffres précis (ex: "entre 15 000 et 25 000 FCFA par nuit")
• Naturel : utilise les tournures du français camerounais (voir liste ci-dessous)
• Pour la version anglaise : ton légèrement plus formel mais toujours chaleureux, cible le lecteur de la diaspora (UK, USA, Canada)

EXPRESSIONS ET TOURNURES NATURELLES À UTILISER (choisir 2-3 par article) :
• "Tu sais, ici au Cameroun..."
• "Je ne vais pas te mentir, c'est une vraie galère de..."
• "C'est connu de tout le monde que..."
• "La famille, c'est sacré"
• "On est ensemble" (expression camerounaise de solidarité)
• "Ce n'est pas chose facile" (expression locale)
• "Avec la vie chère..."
• "quand on rentre au mboa..." (pour les articles ciblant la diaspora)
• "Mon frère" / "Ma sœur" (ton familier, à utiliser avec parcimonie — 1 fois max)
• "Mboa" peut apparaître une fois par article (Camfranglais = pays/maison)

━━━ CONTEXTE CAMEROUNAIS OBLIGATOIRE ━━━

RÉFÉRENCES LOCALES (au moins 3 par article parmi cette liste) :
• Hôpitaux : Hôpital Général de Douala, CHU de Yaoundé, Hôpital Laquintinie, Hôpital Central de Yaoundé, Polyclinique Bonanjo
• Quartiers Douala : Akwa, Makepe, Bastos (résidentiel), Bonanjo, Bonapriso, Logbessou
• Quartiers Yaoundé : Biyem-Assi, Ngousso, Nlongkak, Melen, Omnisports
• Mobile Money : Orange Money, MTN MoMo (pour le paiement)
• Opérateurs télécom : Orange Cameroun, MTN Cameroun
• Transport : "taxi-moto", "taxi"
• Monnaie : FCFA TOUJOURS (jamais "francs" générique)

PRÉNOMS CAMEROUNAIS À UTILISER POUR LES ANECDOTES :
• Femmes : Marie-Claire, Sandrine, Cécile, Honorine, Blandine, Yvette, Madeleine, Thérèse, Angèle, Solange
• Hommes : Emmanuel, Hervé, Rodrigue, Didier, Arsène, Gilbert, Théophile, Valentin, Clovis, Désiré

AUDIENCE DOUBLE :
• Français : familles au Cameroun + diaspora africaine francophone (France, Belgique, Canada)
• Anglais : diaspora anglophone (UK, USA, Cameroun anglophone — Buea, Bamenda)
Les deux langues doivent être NATURELLES — l'anglais n'est pas une traduction mécanique du français.

━━━ LONGUEUR ET STRUCTURE ━━━

LONGUEUR : 800-1 200 mots par langue
STRUCTURE : 3-4 sections H2, 4-6 FAQ, 1 conclusion avec CTA
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
MOT-CLÉ PRINCIPAL FR : ${topic.focus_keyword_fr}
MOT-CLÉ PRINCIPAL EN : ${topic.focus_keyword_en}
CATÉGORIE : ${topic.categoryLabel}
DATE : ${today}
SLUG : ${slug}

SOURCES RÉCUPÉRÉES (base exclusive pour toute donnée chiffrée) :
${ragContext}

ARTICLES DÉJÀ PUBLIÉS (éviter la répétition — utiliser pour liens internes si pertinent) :
${recentArticles}

━━━ TÂCHE ━━━
Rédige un article de blog SEO complet, bilingue (FR + EN), dans le format JSON exact ci-dessous.

━━━ CONTRAINTES SEO PRÉCISES ━━━

1. TITRE (meta.title) :
   - FR : 55-65 caractères, contient "${topic.focus_keyword_fr}" tel quel ou quasi-identique
   - EN : 55-65 caractères, contient "${topic.focus_keyword_en}"

2. META DESCRIPTION :
   - FR : exactement 150-158 caractères (compte les espaces, compte précisément)
   - EN : exactement 150-158 caractères
   - Contient le keyword principal
   - Se termine par un call-to-action implicite ("Découvrez...", "Tout ce qu'il faut savoir.", "Nos conseils.")

3. CHAPEAU (introduction) :
   - Les 2 premières phrases contiennent "${topic.focus_keyword_fr}" ET un secondary keyword connexe
   - Ton : direct, empathique, camerounais — pas "Dans le contexte actuel..."
   - Ex de bon départ : "Tu cherches un garde-malade à Douala pour ta maman ?" ou "Trouver un auxiliaire de vie fiable au Cameroun, ce n'est pas chose facile."

4. SECTIONS H2 :
   - 3-4 sections au total
   - Au moins 2 titres de section doivent contenir le mot-clé principal "${topic.focus_keyword_fr}"
   - La première section commence dans les 150 premiers mots
   - Chaque section : 200-300 mots par langue

5. LIENS INTERNES (2-4, formulés naturellement dans le corps du texte) :
   - Au moins 1 lien vers /services, /services#garde, /services#auxiliaire ou /services#medecin
   - Au moins 1 lien vers /contact
   - Si des articles déjà publiés sont listés ci-dessus et pertinents : 1 lien vers /blog/[slug]
   - Format HTML : <a href="/services#garde">notre service de garde-malade</a>

6. FAQ (4-6 questions) :
   - Formats de questions qui correspondent aux vraies requêtes Google :
     "Combien coûte...", "Comment trouver...", "Quelle est la différence entre...", "Est-ce que...", "Où trouver..."
   - Réponses : 50-120 mots, directes, utilisables comme featured snippets
   - Les questions FAQ doivent être différentes des titres de sections

7. BALISE ALT IMAGE HERO :
   - Descriptive, contextualisée : qui + quoi + où
   - Contient le keyword : ex. "Auxiliaire de vie à domicile aidant une personne âgée à Douala Cameroun"

━━━ PERSONNAGES FICTIFS (choisir 1-2 selon pertinence pour l'article) ━━━
• Marie-Claire Essomba, infirmière à Douala (quartier Bonapriso), 12 ans d'expérience
• Emmanuel Nkodo, fils de patient vivant à Lyon, gère les soins de sa mère à Yaoundé à distance
• Dr. Sandrine Mballa, médecin généraliste, CHU de Yaoundé
• Hervé Tchamba, patient post-opératoire, 68 ans, Akwa (Douala)
• Blandine Ngassa, auxiliaire de vie certifiée, 5 ans d'expérience, Makepe (Douala)
• Cécile Atangana, fille de patient, rentrée du mboa depuis Paris pour s'occuper de son père
• Didier Kamga, infirmier à domicile, Ngousso (Yaoundé), spécialisé soins post-opératoires

━━━ STYLE CAMEROUNAIS (CRITIQUE) ━━━
• Utilise 2-3 expressions naturelles parmi : "Tu sais, ici au Cameroun...", "Je ne vais pas te mentir...", "La famille, c'est sacré", "On est ensemble", "Ce n'est pas chose facile", "Avec la vie chère...", "quand on rentre au mboa..."
• Au moins 3 références locales : hôpitaux (Hôpital Général de Douala, Laquintinie, CHU de Yaoundé, Hôpital Central de Yaoundé, Polyclinique Bonanjo), quartiers (Akwa, Makepe, Bonanjo, Bonapriso, Logbessou — Douala ; Biyem-Assi, Ngousso, Nlongkak, Melen — Yaoundé), Mobile Money (Orange Money, MTN MoMo), transport (taxi-moto, taxi)
• Monnaie : FCFA toujours (jamais "francs" seul)
• Chiffres concrets : fourchettes de prix, durées, distances — pas "des tarifs compétitifs"

━━━ INSTRUCTIONS HTML pour le champ "body" des sections ━━━
• Utilise <p> pour les paragraphes (jamais de texte brut sans balise)
• Utilise <strong> pour l'emphase sur les termes importants
• Utilise <ul><li> pour les listes (maximum 2 listes par section, max 5 items par liste)
• Utilise <h3> pour les sous-sections si nécessaire (pas H2 — le H2 est dans "heading")
• PAS de H1, H2 dans body
• Les liens internes dans le texte : <a href="/services#garde">notre service de garde-malade</a>
• Les citations en italique : <em>«&nbsp;La citation.&nbsp;»</em>

Retourne UNIQUEMENT ce JSON (sans balises markdown) :
{
  "meta": {
    "slug": "${slug}",
    "date": "${today}",
    "title": {
      "fr": "Titre SEO 55-65 chars — contient '${topic.focus_keyword_fr}'",
      "en": "SEO title 55-65 chars — contains '${topic.focus_keyword_en}'"
    },
    "description": {
      "fr": "Meta description FR exactement 150-158 caractères avec keyword et call-to-action implicite en fin de phrase.",
      "en": "Meta description EN exactly 150-158 characters with keyword and implicit call-to-action at the end of the sentence."
    },
    "focus_keyword": { "fr": "${topic.focus_keyword_fr}", "en": "${topic.focus_keyword_en}" },
    "secondary_keywords": {
      "fr": ["secondary keyword 1 FR", "secondary keyword 2 FR"],
      "en": ["secondary keyword 1 EN", "secondary keyword 2 EN"]
    },
    "reading_time": 6,
    "category": "${topic.category}",
    "tags": ["garde-malade", "cameroun", "plus 2-3 tags pertinents"],
    "internal_links": [
      { "href": "/services#garde", "text": { "fr": "notre service garde-malade", "en": "our caregiver service" } },
      { "href": "/contact", "text": { "fr": "nous contacter", "en": "contact us" } }
    ]
  },
  "hero": {
    "src": "/blog/images/${slug}.jpg",
    "alt": {
      "fr": "Alt image descriptive avec keyword — ex: '${topic.focus_keyword_fr} à domicile au Cameroun'",
      "en": "Descriptive alt with keyword — ex: '${topic.focus_keyword_en} home care in Cameroon'"
    },
    "photographer": null,
    "photographer_url": null,
    "photo_url": null,
    "unsplash_id": null
  },
  "body_images": [],
  "content": {
    "chapeau": {
      "fr": "2-3 phrases d'accroche contenant '${topic.focus_keyword_fr}' + secondary keyword. Ton direct et camerounais — pas 'Dans le contexte actuel...'",
      "en": "2-3 hook sentences containing '${topic.focus_keyword_en}' + secondary keyword. Warm tone targeting diaspora reader."
    },
    "sections": [
      {
        "heading": {
          "fr": "Titre H2 contenant '${topic.focus_keyword_fr}' — section 1 (dans les 150 premiers mots)",
          "en": "H2 heading containing '${topic.focus_keyword_en}' — section 1"
        },
        "body": {
          "fr": "<p>Contenu HTML 200-300 mots en français. Ton camerounais, chiffres en FCFA, référence locale (hôpital ou quartier), lien interne naturel vers /services ou /services#garde.</p>",
          "en": "<p>HTML content 200-300 words in English. Target diaspora reader. Natural English, not mechanical translation. Include internal link to /services.</p>"
        },
        "image": null
      },
      {
        "heading": {
          "fr": "Deuxième titre H2 — peut contenir '${topic.focus_keyword_fr}' ou secondary keyword",
          "en": "Second H2 heading — keyword or secondary keyword"
        },
        "body": {
          "fr": "<p>Contenu HTML 200-300 mots. Anecdote avec personnage camerounais nommé (prénom + quartier + situation concrète). Expression camerounaise naturelle.</p>",
          "en": "<p>HTML content 200-300 words. Anecdote with named Cameroonian character. Warm tone for diaspora.</p>"
        },
        "image": null
      },
      {
        "heading": {
          "fr": "Troisième titre H2 — aspect pratique ou guide étape par étape",
          "en": "Third H2 heading — practical aspect or step-by-step guide"
        },
        "body": {
          "fr": "<p>Contenu HTML 200-300 mots. Conseils pratiques, Mobile Money ou paiement, lien interne vers /contact.</p>",
          "en": "<p>HTML content 200-300 words. Practical tips, payment methods, internal link to /contact.</p>"
        },
        "image": null
      }
    ],
    "faq": [
      {
        "question": {
          "fr": "Combien coûte [sujet] au Cameroun ?",
          "en": "How much does [subject] cost in Cameroon?"
        },
        "answer": {
          "fr": "Réponse directe 50-120 mots, chiffres en FCFA si pertinent, utilisable comme featured snippet Google.",
          "en": "Direct answer 50-120 words, prices in CFA francs if relevant, usable as Google featured snippet."
        }
      },
      {
        "question": {
          "fr": "Comment trouver [sujet] fiable à Douala ou Yaoundé ?",
          "en": "How to find a reliable [subject] in Douala or Yaoundé?"
        },
        "answer": {
          "fr": "Réponse directe 50-120 mots.",
          "en": "Direct answer 50-120 words."
        }
      },
      {
        "question": {
          "fr": "Quelle est la différence entre [option A] et [option B] ?",
          "en": "What is the difference between [option A] and [option B]?"
        },
        "answer": {
          "fr": "Réponse directe 50-120 mots.",
          "en": "Direct answer 50-120 words."
        }
      },
      {
        "question": {
          "fr": "Est-ce possible d'organiser [sujet] depuis la France ou le Canada ?",
          "en": "Can I arrange [subject] from France, Canada or the UK?"
        },
        "answer": {
          "fr": "Réponse directe 50-120 mots.",
          "en": "Direct answer 50-120 words."
        }
      }
    ],
    "conclusion": {
      "fr": "Paragraphe de conclusion 150-200 mots. Récapitulatif empathique + lien interne naturel vers /contact avec CTA. Ton camerounais chaleureux.",
      "en": "Conclusion paragraph 150-200 words. Empathetic recap + natural internal link to /contact with CTA. Warm diaspora-friendly tone."
    },
    "cta": {
      "text": { "fr": "Demandez une évaluation gratuite", "en": "Request a free assessment" },
      "href": "/contact"
    }
  },
  "sources": [
    { "title": "Nom de la page source", "url": "https://url-exacte-depuis-RAG.com", "org": "Nom de l'organisme" }
  ],
  "related": [],
  "schema": {
    "faq_items": []
  }
}

━━━ RAPPELS CRITIQUES AVANT DE GÉNÉRER ━━━
1. Vérifie que meta.description.fr fait bien 150-158 caractères (compte-les)
2. Le mot-clé "${topic.focus_keyword_fr}" doit apparaître dans : title.fr, chapeau.fr (1ère phrase), au moins 2 heading.fr, description.fr
3. sections : exactement 3-4 sections H2
4. faq : exactement 4-6 questions — format "Combien...", "Comment...", "Quelle différence...", "Est-ce que..."
5. Liens internes : 2-4 liens, formulés naturellement dans le texte (pas en liste)
6. Références camerounaises : au moins 3 (hôpital OU quartier OU Mobile Money OU transport)
7. Expressions camerounaises : au moins 2 dans l'article FR
8. Anecdote obligatoire : 1-2 personnages fictifs camerounais nommés avec situation concrète
9. Sources : inclure uniquement les URLs réellement utilisées depuis les données RAG fournies
10. Les sections EN doivent être naturelles pour un lecteur de la diaspora anglophone — pas une traduction mot-à-mot`;
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
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(480000),
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
<p><strong>URL :</strong> <a href="https://soinsmboa.com/blog/${slug}">soinsmboa.com/blog/${slug}</a></p>
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
