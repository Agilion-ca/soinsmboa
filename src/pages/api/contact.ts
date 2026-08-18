import type { APIRoute } from 'astro';

export const prerender = false;

const SERVICES: Record<string, string> = {
  'auxiliaire-vie': 'Auxiliaire de vie',
  'garde-malade': 'Garde-malade',
  'medecin': 'Médecin à domicile',
  'autre': 'Autre',
};

const rateLimitMap = new Map<string, number>();

function validate(body: Record<string, string>): string | null {
  if (!body.nom || body.nom.length < 2) return 'Nom invalide';
  if (!body.telephone || body.telephone.length < 8) return 'Téléphone invalide';
  if (!body.ville) return 'Ville requise';
  if (!body.service || !SERVICES[body.service]) return 'Service invalide';
  if (!body.message || body.message.length < 10) return 'Message trop court';
  return null;
}

export const POST: APIRoute = async ({ request }) => {
  const ip = request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown';

  const now = Date.now();
  const last = rateLimitMap.get(ip);
  if (last && now - last < 60_000) {
    return new Response(JSON.stringify({ error: 'Trop de tentatives. Veuillez patienter une minute.' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    });
  }
  rateLimitMap.set(ip, now);

  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Requête invalide' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const err = validate(body);
  if (err) {
    return new Response(JSON.stringify({ error: err }), {
      status: 422, headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = import.meta.env.BREVO_API_KEY;
  const fromEmail = import.meta.env.BREVO_FROM_EMAIL;
  const toEmail = import.meta.env.BREVO_TO_EMAIL;

  if (!apiKey || !fromEmail || !toEmail) {
    return new Response(JSON.stringify({ error: 'Service email non configuré. Contactez-nous par téléphone.' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

  const html = `
    <div style="font-family:sans-serif;max-width:580px;margin:0 auto">
      <div style="background:#1A6B4A;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">Nouvelle demande de soin</h2>
        <p style="margin:4px 0 0;opacity:.8;font-size:13px">GardeMalade Cameroun</p>
      </div>
      <div style="background:#f8f9fa;padding:24px;border-radius:0 0 8px 8px">
        <table style="width:100%">
          <tr><td style="padding:6px 0;color:#666;width:130px;font-size:13px"><strong>Nom</strong></td><td style="padding:6px 0;font-size:14px">${body.nom}</td></tr>
          <tr><td style="padding:6px 0;color:#666;font-size:13px"><strong>Téléphone</strong></td><td style="padding:6px 0"><a href="tel:${body.telephone}" style="color:#1A6B4A;font-size:14px">${body.telephone}</a></td></tr>
          ${body.email ? `<tr><td style="padding:6px 0;color:#666;font-size:13px"><strong>Email</strong></td><td style="padding:6px 0;font-size:14px">${body.email}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#666;font-size:13px"><strong>Ville</strong></td><td style="padding:6px 0;font-size:14px">${body.ville}</td></tr>
          <tr><td style="padding:6px 0;color:#666;font-size:13px"><strong>Service</strong></td><td style="padding:6px 0;font-size:14px">${SERVICES[body.service]}</td></tr>
        </table>
        <div style="margin-top:16px;padding:14px;background:white;border-left:4px solid #1A6B4A;border-radius:4px">
          <p style="margin:0 0 6px;color:#666;font-size:12px;font-weight:bold">MESSAGE</p>
          <p style="margin:0;font-size:14px;line-height:1.6">${body.message}</p>
        </div>
        <p style="margin-top:16px;font-size:11px;color:#999">Reçu le ${new Date().toLocaleString('fr-CM', { timeZone: 'Africa/Douala' })}</p>
      </div>
    </div>
  `;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'GardeMalade CM', email: fromEmail },
      to: [{ email: toEmail }],
      replyTo: body.email ? { email: body.email } : undefined,
      subject: `Demande ${SERVICES[body.service]} — ${body.nom} (${body.ville})`,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error('Brevo error:', detail);
    return new Response(JSON.stringify({ error: 'Impossible d\'envoyer le message. Contactez-nous directement.' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
