#!/usr/bin/env bash
# ============================================================
# GardeMalade — Setup initial Cloudflare Pages
# À lancer UNE SEULE FOIS pour créer le projet CF Pages
# Usage: ./scripts/setup-cloudflare.sh
# ============================================================
set -euo pipefail

PROJECT_NAME="garde-malade"
SITE_URL="https://gardemalade-cm.com"

echo "🏥 GardeMalade — Setup Cloudflare Pages"
echo "========================================"

# ── Auth ──────────────────────────────────────────────────
echo ""
echo "📋 Étape 1 : Authentification Cloudflare"
if npx wrangler whoami >/dev/null 2>&1; then
  echo "✅ Déjà authentifié"
else
  echo "→ Lance la connexion dans le navigateur..."
  npx wrangler login
fi

# ── Créer projet CF Pages ──────────────────────────────────
echo ""
echo "📋 Étape 2 : Création du projet Cloudflare Pages"
echo "   Projet: $PROJECT_NAME"

# Build d'abord
npm run build

# Déploiement initial (crée le projet)
npx wrangler pages deploy dist --project-name="$PROJECT_NAME" --branch=main

echo ""
echo "✅ Projet créé sur Cloudflare Pages"

# ── Variables d'environnement ──────────────────────────────
echo ""
echo "📋 Étape 3 : Configuration des variables d'environnement"
echo ""
echo "⚠️  Tu dois ajouter manuellement ces variables dans le dashboard Cloudflare :"
echo "   https://dash.cloudflare.com → Pages → $PROJECT_NAME → Settings → Variables"
echo ""
echo "   BREVO_API_KEY       = <clé API Brevo>"
echo "   BREVO_FROM_EMAIL    = <email expéditeur>"
echo "   BREVO_TO_EMAIL      = <email réception>"
echo "   PUBLIC_PHONE        = +237 6XX XXX XXX"
echo "   PUBLIC_WHATSAPP     = 237600000000"
echo "   PUBLIC_SMS          = +237 6XX XXX XXX"
echo ""
echo "   Pour le blog (phase 2) :"
echo "   ANTHROPIC_API_KEY   = <clé Anthropic>"
echo "   TAVILY_API_KEY      = <clé Tavily>"
echo "   UNSPLASH_ACCESS_KEY = 8xlafA6ZXcw2OjjRK92hnzVvenHEacnJbtzenUfoypo"
echo "   BLOG_ALERT_EMAIL    = <email alertes blog>"

echo ""
echo "📋 Étape 4 : Domaine custom (optionnel)"
echo "   Dans le dashboard CF Pages → Custom domains → Add custom domain"
echo "   → Entrer: gardemalade-cm.com"
echo "   → CF génère les DNS records à ajouter chez Namecheap"
echo ""
echo "   DNS chez Namecheap : Advanced DNS → ajouter les records CF"
echo "   Propagation : 5-30 minutes"

echo ""
echo "========================================"
echo "✅ Setup terminé ! URL preview générée ci-dessus."
echo ""
echo "🔗 Dashboard : https://dash.cloudflare.com/pages"
