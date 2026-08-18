#!/usr/bin/env bash
# ============================================================
# GardeMalade — Setup GitHub repo + secrets pour CI/CD
# Usage: ./scripts/setup-github.sh <github-username>
# Requis: gh CLI (brew install gh) authentifié
# ============================================================
set -euo pipefail

GITHUB_USER="${1:-}"
REPO_NAME="garde-malade"

if [ -z "$GITHUB_USER" ]; then
  echo "Usage: ./scripts/setup-github.sh <github-username>"
  echo "Ex:    ./scripts/setup-github.sh moncompte"
  exit 1
fi

echo "🏥 GardeMalade — Setup GitHub"
echo "================================"

# ── Vérification gh CLI ───────────────────────────────────
command -v gh >/dev/null 2>&1 || {
  echo "❌ GitHub CLI requis."
  echo "   Mac:   brew install gh"
  echo "   Linux: https://cli.github.com"
  exit 1
}

if ! gh auth status >/dev/null 2>&1; then
  echo "→ Connexion GitHub..."
  gh auth login
fi

echo "✅ GitHub CLI: $(gh auth status 2>&1 | head -1)"

# ── Init git si nécessaire ────────────────────────────────
if [ ! -d ".git" ]; then
  echo ""
  echo "📋 Initialisation du repo git..."
  git init
  git add .
  git commit -m "feat: initial Astro site garde-malade"
fi

# ── Créer repo GitHub ──────────────────────────────────────
echo ""
echo "📋 Création du repo GitHub: $GITHUB_USER/$REPO_NAME"
if gh repo view "$GITHUB_USER/$REPO_NAME" >/dev/null 2>&1; then
  echo "✅ Repo existe déjà"
else
  gh repo create "$GITHUB_USER/$REPO_NAME" --private --source=. --remote=origin --push
  echo "✅ Repo créé: https://github.com/$GITHUB_USER/$REPO_NAME"
fi

# ── Push initial ───────────────────────────────────────────
git remote set-url origin "https://github.com/$GITHUB_USER/$REPO_NAME.git" 2>/dev/null || true
git push -u origin main 2>/dev/null || git push -u origin master 2>/dev/null || echo "Déjà à jour"

# ── Secrets GitHub pour blog generator ────────────────────
echo ""
echo "📋 Configuration des secrets GitHub (pour le blog auto-générateur)"
echo ""

set_secret() {
  local name="$1"
  local val="$2"
  if [ -n "$val" ]; then
    echo "$val" | gh secret set "$name" --repo="$GITHUB_USER/$REPO_NAME"
    echo "  ✅ $name"
  else
    echo "  ⚠️  $name → non configuré (à ajouter manuellement)"
  fi
}

set_secret "ANTHROPIC_API_KEY"   "${ANTHROPIC_API_KEY:-}"
set_secret "TAVILY_API_KEY"      "${TAVILY_API_KEY:-}"
set_secret "UNSPLASH_ACCESS_KEY" "${UNSPLASH_ACCESS_KEY:-8xlafA6ZXcw2OjjRK92hnzVvenHEacnJbtzenUfoypo}"
set_secret "BREVO_API_KEY"       "${BREVO_API_KEY:-}"
set_secret "BREVO_FROM_EMAIL"    "${BREVO_FROM_EMAIL:-}"
set_secret "BREVO_TO_EMAIL"      "${BREVO_TO_EMAIL:-}"
set_secret "BLOG_ALERT_EMAIL"    "${BLOG_ALERT_EMAIL:-}"

# ── CF Pages API token pour auto-deploy ───────────────────
echo ""
echo "📋 Cloudflare API Token pour déploiement automatique"
echo "   1. https://dash.cloudflare.com/profile/api-tokens"
echo "   2. Create Token → 'Edit Cloudflare Workers' template"
echo "   3. Scope: Account = Pages (Edit)"
echo "   4. Copie le token, puis lance:"
echo ""
echo "   gh secret set CF_API_TOKEN --repo=$GITHUB_USER/$REPO_NAME"
echo "   gh secret set CF_ACCOUNT_ID --repo=$GITHUB_USER/$REPO_NAME"
echo ""
echo "   (Account ID visible dans le dashboard CF, à droite sur la home)"

echo ""
echo "================================"
echo "✅ Setup GitHub terminé !"
echo "🔗 Repo: https://github.com/$GITHUB_USER/$REPO_NAME"
echo ""
echo "📌 Actions suivantes :"
echo "   1. Connecter CF Pages au repo GitHub (dashboard CF)"
echo "   2. Ajouter CF_API_TOKEN + CF_ACCOUNT_ID comme secrets"
echo "   3. Le blog se déploiera automatiquement tous les 2 jours"
