# AegisCare – Elderly Care & Medication Management Platform

Shared, passcode-protected care circles where the elderly person (owner), caretakers (edit) and family (view-only) manage medicines, track adherence and monitor doctor appointments.

**Features:** role-based passcode access (scrypt-hashed, signed tokens, rate-limited login) · medication schedules and one-tap Taken/Skip · 7-day adherence score · email reminders (upcoming dose, missed dose escalated to the circle, appointments at 24h and 2h, low-stock refill) · Gemini-powered family summary · accessible UI (skip link, labels, ARIA live region, large-text mode, read-aloud, keyboard friendly).

**Run:** `npm install && npm start` · **Test:** `npm test` · **Config:** see `.env.example`. Deploy with `gcloud run deploy --source .`
