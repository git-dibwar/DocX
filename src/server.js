const fs = require('fs');
const path = require('path');

const requiredPackages = ['express', 'multer', 'jsonwebtoken', 'stripe', 'mammoth', 'pdf-lib', 'docx'];
const missingPackages = requiredPackages.filter((pkg) => !fs.existsSync(path.join(__dirname, '..', 'node_modules', pkg)));

if (missingPackages.length) {
  console.error(`Missing dependencies: ${missingPackages.join(', ')}`);
  console.error('Run `npm install` from the project root, then run `npm start` again.');
  process.exit(1);
}

const dotenvPath = path.join(__dirname, '..', 'node_modules', 'dotenv');
if (fs.existsSync(dotenvPath)) require('dotenv').config();

const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { processDocument } = require('./documentProcessor');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.docx' && ext !== '.pdf') return cb(new Error('Only .docx and .pdf files are allowed'));
    cb(null, true);
  }
});

const memoryUsers = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function authRequired(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('/workspace', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'workspace.html')));

app.post('/api/signup', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Provide a valid email and password with at least 8 characters.' });
  }
  if (memoryUsers.has(email)) return res.status(409).json({ error: 'Account already exists.' });

  memoryUsers.set(email, { password, subscribed: false });
  return res.json({ message: 'Account created. Please sign in.' });
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = memoryUsers.get(email);

  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials.' });

  const token = jwt.sign({ email, subscribed: !!user.subscribed }, JWT_SECRET, { expiresIn: '2h' });
  return res.json({ token, subscribed: !!user.subscribed, email });
});

app.get('/api/me', authRequired, (req, res) => {
  const live = memoryUsers.get(req.user.email);
  return res.json({ email: req.user.email, subscribed: !!live?.subscribed });
});

app.post('/api/billing/create-checkout-session', authRequired, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID || 'price_placeholder', quantity: 1 }],
      customer_email: req.user.email,
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}/workspace?billing=success`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/workspace?billing=cancel`
    });
    return res.json({ url: session.url });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to create checkout session', details: error.message });
  }
});

app.post('/api/billing/mock-activate', authRequired, (req, res) => {
  const user = memoryUsers.get(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  user.subscribed = true;
  const token = jwt.sign({ email: req.user.email, subscribed: true }, JWT_SECRET, { expiresIn: '2h' });
  return res.json({ message: 'Subscription activated.', token, subscribed: true });
});

app.post('/api/process', authRequired, upload.single('document'), async (req, res) => {
  const user = memoryUsers.get(req.user.email);
  if (!user?.subscribed) return res.status(403).json({ error: 'Active subscription required.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const options = {
    alignImages: req.body.alignImages === 'true',
    fixParagraphs: req.body.fixParagraphs === 'true',
    applyHeadingStyles: req.body.applyHeadingStyles === 'true',
    updateFonts: req.body.updateFonts === 'true',
    addTableOfContents: req.body.addTableOfContents === 'true',
    insertFigureCaptions: req.body.insertFigureCaptions === 'true',
    spellCheck: req.body.spellCheck === 'true'
  };

  const ext = path.extname(req.file.originalname).toLowerCase();
  let outputPath;
  try {
    outputPath = await processDocument(req.file.path, ext, options);
    const safeName = `${path.parse(req.file.originalname).name}-edited${ext}`;
    res.download(outputPath, safeName, () => {
      fs.unlink(req.file.path, () => {});
      if (outputPath) fs.unlink(outputPath, () => {});
    });
  } catch (error) {
    fs.unlink(req.file.path, () => {});
    if (outputPath) fs.unlink(outputPath, () => {});
    return res.status(500).json({ error: 'Processing failed', details: error.message });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.message?.includes('File too large')) {
    return res.status(413).json({ error: 'File exceeds 20MB limit.' });
  }
  return res.status(400).json({ error: err.message || 'Request failed.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Monodraft running at http://localhost:${port}`);
});
