#!/usr/bin/env bash
# ============================================================
# GardeMalade Cameroun — Script de déploiement Cloudflare Pages
# Usage: ./scripts/deploy.sh [--prod] [--skip-build]
# ============================================================
set -euo pipefail

PROD=false
SKIP_BUILD=false
PROJECT_NAME="garde-malade"

for arg in "$@"; do
  case $arg in
    --prod) PROD=true ;;
    --skip-build) SKIP_BUILD=true ;;
  esac
done

echo "🏥 GardeMalade — Déploiement Cloudflare Pages"
echo "=============================================="

# ── 1. Vérifications ──────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "❌ Node.js requis. Installer via https://nodejs.org"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "❌ npm requis."; exit 1; }

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 22 ]; then
  echo "⚠️  Node.js 22+ recommandé. Version actuelle: $(node -v)"
fi

if ! npx wrangler --version >/dev/null 2>&1; then
  echo "📦 Installation de wrangler..."
  npm install -g wrangler
fi

echo "✅ Node $(node -v) | wrangler $(npx wrangler --version 2>/dev/null | head -1)"

# ── 2. Vérification authentification Cloudflare ───────────
echo ""
echo "🔑 Vérification de l'authentification Cloudflare..."
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "❌ Non authentifié. Lance: npx wrangler login"
  echo "   Puis relance ce script."
  exit 1
fi
ACCOUNT=$(npx wrangler whoami 2>/dev/null | grep -i "account" | head -1 || echo "OK")
echo "✅ Cloudflare: $ACCOUNT"

# ── 3. Variables d'environnement ──────────────────────────
echo ""
echo "🔍 Vérification des variables d'environnement..."
MISSING=()
[ -z "${BREVO_API_KEY:-}" ]    && MISSING+=("BREVO_API_KEY")
[ -z "${BREVO_FROM_EMAIL:-}" ] && MISSING+=("BREVO_FROM_EMAIL")
[ -z "${BREVO_TO_EMAIL:-}" ]   && MISSING+=("BREVO_TO_EMAIL")
[ -z "${PUBLIC_PHONE:-}" ]     && MISSING+=("PUBLIC_PHONE")
[ -z "${PUBLIC_WHATSAPP:-}" ]  && MISSING+=("PUBLIC_WHATSAPP")

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "⚠️  Variables manquantes dans l'environnement:"
  for v in "${MISSING[@]}"; do echo "   - $v"; done
  echo "   Ces variables doivent être ajoutées dans le dashboard Cloudflare Pages."
  echo "   (pour le build local, elles peuvent être dans .env)"
fi

# ── 4. Build ──────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo ""
  echo "🔨 Build en cours..."
  npm run build
  echo "✅ Build terminé → dist/"
fi

# ── 5. Déploiement ────────────────────────────────────────
echo ""
if [ "$PROD" = true ]; then
  echo "🚀 Déploiement en PRODUCTION..."
  npx wrangler pages deploy dist --project-name="$PROJECT_NAME" --branch=main
else
  echo "🚀 Déploiement en PREVIEW (--prod pour production)..."
  npx wrangler pages deploy dist --project-name="$PROJECT_NAME"
fi

echo ""
echo "=============================================="
echo "✅ Déploiement terminé !"
echo ""
echo "📌 Prochaines étapes :"
echo "   1. Vérifier le site sur le dashboard Cloudflare Pages"
echo "   2. Configurer les variables d'env dans CF dashboard si pas encore fait"
echo "   3. Configurer le domaine custom (voir DEPLOY.md)"
