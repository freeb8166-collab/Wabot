# HEXGATE v2

HEXGATE is a Node.js + Express + Baileys WhatsApp bot with:
- Pairing Code web onboarding
- Cyberpunk frontend
- Multi-session storage
- Anti-link / anti-spam
- Fake recording mode
- Anti-delete restoration for received text and media
- Welcome messages
- Admin commands
- Menu

## Deploy
1. Push the repository root to GitHub.
2. Connect it to Render.
3. Use Node 20.
4. Keep the persistent disk enabled.
5. Do not commit `.env`, sessions or media.

## Pairing
Use the international number with digits only, e.g. `2438XXXXXXXX`.
WhatsApp pairing is a WhatsApp Web companion-device flow, not a mobile API.

## Important
Anti-delete stores received content locally so that a revoked message can be restored. Use it only where you have the right/permission to retain the group content.

## Pairing troubleshooting
The npm peer-dependency warning visible during installation is not, by itself, a fatal Baileys error.

The code requests the pairing code after Baileys emits the `qr` readiness event, uses digits-only international phone numbers, and attempts to use the current WhatsApp Web version.

If WhatsApp still shows "Impossible de connecter l’appareil" after the code is entered, this can be caused by upstream WhatsApp Web/Baileys pairing regressions rather than the website. Current Baileys issue reports document cases where pairing codes are generated but WhatsApp rejects the link. Try a fresh session directory and a newly generated code; do not reuse an old pairing code.
