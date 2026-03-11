# DocX Subscription Web App Prototype

This prototype is a single-repo web app with:
- Front-end UI for auth, subscription, upload, edit checklist, and job history
- Node/Express backend APIs for auth, billing, and processing
- File processing for `.docx` and `.pdf`

## Features

### Accounts + access control
- Register/login with email/password
- JWT-protected APIs
- Subscription-gated processing endpoint

### Stripe billing
- Creates a Stripe Checkout session for subscription billing
- Includes `POST /api/billing/mock-activate` for local development flows

### File editing workflow
Upload `.docx` or `.pdf`, select formatting options, and download processed output:
- Align images
- Fix paragraphs
- Apply heading styles
- Update fonts
- Add table of contents
- Insert figure captions
- Run spell-check

## Run locally (npm)

1. Install dependencies
   ```bash
   npm install
   ```
2. Configure env
   ```bash
   cp .env.example .env
   ```
3. Start server
   ```bash
   npm start
   ```
4. Open http://localhost:3000

## Notes
- This is a prototype; some transformations are placeholder/heuristic implementations.
- For production Stripe integration, add webhook handling to sync subscription state.

## Troubleshooting
- If `npm start` reports missing modules (for example `Cannot find module "dotenv"`), install dependencies first:
  ```bash
  npm install
  ```
- Then retry:
  ```bash
  npm start
  ```
