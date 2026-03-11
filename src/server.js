require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const db = require('./db');
const { authRequired } = require('./auth');
const { processDocument } = require('./documentProcessor');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.docx' && ext !== '.pdf') return cb(new Error('Only .docx and .pdf files are allowed'));
    cb(null, true);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const stmt = db.prepare('INSERT INTO users(email, password_hash) VALUES(?, ?)');
    const result = stmt.run(email.toLowerCase(), hash);
    return res.json({ userId: result.lastInsertRowid });
  } catch (error) {
    return res.status(400).json({ error: 'Account already exists' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, isActive: !!user.is_active },
    process.env.JWT_SECRET || 'dev-secret-change-me',
    { expiresIn: '2h' }
  );

  return res.json({ token, isActive: !!user.is_active });
});

app.get('/api/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT id, email, is_active FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: { ...user, isActive: !!user.is_active } });
});

app.post('/api/billing/create-checkout-session', authRequired, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: String(user.id) } });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID || 'price_placeholder',
          quantity: 1
        }
      ],
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}?billing=success`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}?billing=cancel`
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: 'Unable to create checkout session', details: error.message });
  }
});

app.post('/api/billing/mock-activate', authRequired, (req, res) => {
  db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(req.user.id);
  res.json({ message: 'Subscription activated for local prototype use' });
});

app.post('/api/process', authRequired, upload.single('document'), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user?.is_active) return res.status(403).json({ error: 'Active subscription required' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const options = {
    alignImages: req.body.alignImages === 'true',
    fixParagraphs: req.body.fixParagraphs === 'true',
    applyHeadingStyles: req.body.applyHeadingStyles === 'true',
    updateFonts: req.body.updateFonts === 'true',
    addTableOfContents: req.body.addTableOfContents === 'true',
    insertFigureCaptions: req.body.insertFigureCaptions === 'true',
    spellCheck: req.body.spellCheck === 'true'
  };

  const job = db
    .prepare(
      'INSERT INTO processing_jobs(user_id, original_name, source_path, options_json, status) VALUES (?, ?, ?, ?, ?)'
    )
    .run(req.user.id, req.file.originalname, req.file.path, JSON.stringify(options), 'running');

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const outputPath = await processDocument(req.file.path, ext, options);

    db.prepare('UPDATE processing_jobs SET output_path = ?, status = ? WHERE id = ?').run(outputPath, 'done', job.lastInsertRowid);

    const safeName = `${path.parse(req.file.originalname).name}-edited${ext}`;
    return res.download(outputPath, safeName);
  } catch (error) {
    db.prepare('UPDATE processing_jobs SET status = ? WHERE id = ?').run('error', job.lastInsertRowid);
    return res.status(500).json({ error: 'Processing failed', details: error.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

app.get('/api/jobs', authRequired, (req, res) => {
  const jobs = db
    .prepare('SELECT id, original_name, options_json, status, created_at FROM processing_jobs WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id)
    .map((j) => ({ ...j, options: JSON.parse(j.options_json) }));

  res.json({ jobs });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`DocX prototype listening on http://localhost:${port}`);
});
