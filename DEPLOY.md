# Guide de déploiement — GardeMalade Cameroun

> Stack : Astro 5 + Cloudflare Pages (PoP Douala) + GitHub Actions

---

## Vue d'ensemble

```
GitHub repo
    │
    ├─ push on main ──────────────────→ GitHub Actions ──→ Cloudflare Pages (auto)
    │
    └─ cron */2 jours ────────────────→ Blog generator ──→ commit ──→ CF Pages
```

---

## Prérequis

| Outil | Version | Installation |
|-------|---------|-------------|
| Node.js | ≥ 22 | https://nodejs.org |
| npm | inclus | — |
| Git | — | `brew install git` |
| gh CLI | — | `brew install gh` |
| Wrangler | auto-installé | via `npx wrangler` |

Comptes nécessaires :
- **Cloudflare** (gratuit) — https://dash.cloudflare.com
- **GitHub** — https://github.com
- **Brevo** (gratuit jusqu'à 300 emails/jour) — https://brevo.com

---

## Étape 1 — Préparer les variables d'environnement

Copier `.env.example` :
```bash
cp .env.example .env  # puis éditer
```

Contenu de `.env` :
```env
BREVO_API_KEY=             # Settings → API Keys dans brevo.com
BREVO_FROM_EMAIL=          # ex: contact@gardemalade-cm.com
BREVO_TO_EMAIL=            # votre email de réception

PUBLIC_PHONE=+237 6XX XXX XXX
PUBLIC_WHATSAPP=237600000000
PUBLIC_SMS=+237 6XX XXX XXX

# Phase 2 — Blog
ANTHROPIC_API_KEY=         # https://console.anthropic.com
TAVILY_API_KEY=            # https://tavily.com
UNSPLASH_ACCESS_KEY=8xlafA6ZXcw2OjjRK92hnzVvenHEacnJbtzenUfoypo
BLOG_ALERT_EMAIL=          # email alertes blog
```

---

## Étape 2 — Premier déploiement Cloudflare Pages

### 2a. Authentifier Wrangler
```bash
npx wrangler login
# → Ouvre le navigateur pour connexion Cloudflare
```

### 2b. Créer le projet et déployer
```bash
chmod +x scripts/setup-cloudflare.sh
./scripts/setup-cloudflare.sh
```

Ce script :
1. Build le site (`npm run build`)
2. Crée le projet sur Cloudflare Pages
3. Déploie et donne l'URL preview
4. Guide pour les variables d'env

### 2c. Configurer les variables d'env dans CF Dashboard

Aller sur : **https://dash.cloudflare.com → Pages → garde-malade → Settings → Environment Variables**

Ajouter pour **Production** :

| Variable | Valeur |
|----------|--------|
| `BREVO_API_KEY` | clé Brevo |
| `BREVO_FROM_EMAIL` | email expéditeur |
| `BREVO_TO_EMAIL` | email réception |
| `PUBLIC_PHONE` | +237 6XX XXX XXX |
| `PUBLIC_WHATSAPP` | 237600000000 |
| `PUBLIC_SMS` | +237 6XX XXX XXX |

---

## Étape 3 — Domaine custom (Namecheap)

### 3a. Dans CF Pages Dashboard
- **Pages → garde-malade → Custom domains → Add custom domain**
- Entrer `gardemalade-cm.com`
- CF affiche les DNS records à configurer

### 3b. Dans Namecheap (cPanel)
- **Domain → Advanced DNS**
- Supprimer les anciens records `A` et `CNAME`
- Ajouter les records CF :

```
Type    Host    Value                           TTL
CNAME   @       garde-malade.pages.dev          Auto
CNAME   www     garde-malade.pages.dev          Auto
```

> ⚠️ Namecheap ne permet pas de CNAME sur `@` (apex). Solution :
> Transférer les DNS vers Cloudflare (gratuit) :
> - Dans Namecheap : **Domain → Nameservers → Custom DNS**
> - Entrer les nameservers Cloudflare (ex: `lena.ns.cloudflare.com`)
> - Attendre 5-48h pour la propagation

### 3c. Vérification
```bash
dig gardemalade-cm.com
# doit pointer vers 104.21.x.x (Cloudflare)
```

---

## Étape 4 — GitHub + CI/CD automatique

### 4a. Créer le repo GitHub
```bash
chmod +x scripts/setup-github.sh
./scripts/setup-github.sh <votre-username-github>
# Ex: ./scripts/setup-github.sh moncompte
```

### 4b. Créer un token Cloudflare pour GitHub Actions

1. https://dash.cloudflare.com/profile/api-tokens
2. **Create Token → Custom Token**
3. Permissions :
   - Account → Cloudflare Pages → Edit
   - Zone → Zone → Read (si domaine custom)
4. Copier le token

```bash
gh secret set CF_API_TOKEN   # coller le token
gh secret set CF_ACCOUNT_ID  # visible dans le sidebar CF dashboard
```

### 4c. Tester le workflow
```bash
gh workflow run deploy.yml
gh run watch
```

---

## Étape 5 — Blog automatique (Phase 2)

Le blog génère un article tous les 2 jours via GitHub Actions.

### 5a. Ajouter les secrets blog
```bash
gh secret set ANTHROPIC_API_KEY
gh secret set TAVILY_API_KEY
# UNSPLASH_ACCESS_KEY déjà dans setup-github.sh
```

### 5b. Premier test manuel
```bash
node scripts/generate-article.mjs --dry-run
# Vérifie que tout fonctionne sans écrire de fichiers

node scripts/generate-article.mjs
# Génère un vrai article
```

### 5c. Déclencher manuellement sur GitHub
```bash
gh workflow run generate-article.yml
```

---

## Déploiements suivants

Après le setup initial, tout est automatique :

| Déclencheur | Action |
|------------|--------|
| `git push origin main` | Build + deploy CF Pages (1-2 min) |
| Cron `*/2 jours` | Génère article → push → deploy auto |
| Manuel | `./scripts/deploy.sh --prod` |

---

## Commandes utiles

```bash
# Dev local
npm run dev                          # localhost:4321

# Build + preview local (comme CF)
npm run build && npm run preview

# Deploy preview (branch de test)
./scripts/deploy.sh

# Deploy production
./scripts/deploy.sh --prod

# Générer un article de blog maintenant
node scripts/generate-article.mjs

# Voir les logs CF Pages en live
npx wrangler pages deployment tail --project-name=garde-malade

# Status du site
npx wrangler pages project list
```

---

## Troubleshooting

| Problème | Solution |
|----------|----------|
| Build échoue | `npm ci && npm run build` |
| Wrangler non authentifié | `npx wrangler login` |
| Variables d'env manquantes | Ajouter dans CF Dashboard > Settings > Variables |
| Domain pas résolu | Attendre propagation DNS (max 48h) |
| Email non reçu | Vérifier BREVO_API_KEY + logs CF Worker |
| Blog generator échoue | Vérifier `ANTHROPIC_API_KEY` + `TAVILY_API_KEY` |

---

## Architecture production

```
Internet
   │
   ↓
Cloudflare CDN (PoP Douala 🇨🇲 + mondial)
   │
   ├─ Pages statiques → servi depuis le cache CDN (< 5ms)
   │
   └─ /api/contact → Cloudflare Worker (edge, < 10ms)
                          │
                          └─ Brevo API → Email
```

> **Latence estimée depuis Douala :** 5-20ms (HTML statique du cache)
> **Latence depuis Paris (diaspora) :** 3-10ms
