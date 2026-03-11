# Monodraft

Monodraft is a modern, monochrome, subscription-gated document editing web app.

## What changed
- **Catchy brand + modern UI**: split auth into a dedicated login page and kept upload/processing in a separate workspace page.
- **No database**: no SQLite or persistent storage for users/jobs.
- **Temporary file handling**: uploads are capped at **20MB**, processed, downloaded, then source/output files are deleted from server.

## Routes
- `GET /login` → sign in / sign up
- `GET /workspace` → upload + formatting workspace

## Run
```bash
npm install
npm start
```
Then open: `http://localhost:3000/login`

## Environment
Copy `.env.example` to `.env` and set values.

## Notes
- This is production-oriented in flow and safety (file size limits, temporary storage lifecycle, auth gating), but Stripe subscription state persistence should be backed by webhook-driven user state in a real production deployment.
