require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { MONGODB_URI, JWT_SECRET, GROQ_API_KEY,
  GROQ_MODEL = 'llama-3.3-70b-versatile', PORT = 3000 } = process.env;
if (!MONGODB_URI || !JWT_SECRET) { console.error('Set MONGODB_URI and JWT_SECRET in .env'); process.exit(1); }

/* ---------- Models ---------- */
const User = mongoose.model('User', new mongoose.Schema({
  name: { type: String, trim: true, default: '' },
  age: { type: Number, min: 1, max: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
}, { timestamps: true }));

// One document per user holds their habits and mood logs (matches the app's data shape).
const State = mongoose.model('State', new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  habits: { type: Array, default: [] },
  mood: { type: Object, default: {} },
}, { timestamps: true, minimize: false }));

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);

// Enable CORS for local development ports and file origins
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'http://localhost:3000', 'http://127.0.0.1:3000'],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  hsts: process.env.NODE_ENV === 'production',
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get(['/login', '/signup'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const setCookie = (res, uid) => res.cookie('token', jwt.sign({ uid }, JWT_SECRET, { expiresIn: '7d' }), {
  httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 });
const auth = (req, res, next) => {
  try { req.uid = jwt.verify(req.cookies.token, JWT_SECRET).uid; next(); }
  catch { res.status(401).json({ error: 'Not signed in' }); }
};
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 40, keyGenerator: (req) => String(req.uid) });

let cachedPromise = null;
async function connectDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!cachedPromise) {
    cachedPromise = mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
    }).catch(err => {
      cachedPromise = null;
      throw err;
    });
  }
  await cachedPromise;
  return mongoose.connection;
}

/* Ensure database connection before handling stateful API routes */
app.use('/api', async (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path === '/me' || req.path === '/state') {
    try {
      await connectDb();
    } catch (e) {
      console.error('Database connection error:', e.message);
      return res.status(503).json({
        error: 'Database is connecting or offline. In MongoDB Atlas Network Access, ensure 0.0.0.0/0 (Anywhere) is enabled for Vercel.'
      });
    }
  }
  next();
});

/* ---------- Auth ---------- */
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const rawAge = req.body.age !== undefined && req.body.age !== '' ? Number(req.body.age) : undefined;
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (name.length > 80) return res.status(400).json({ error: 'Name must be 80 characters or less' });
  if (rawAge !== undefined && (isNaN(rawAge) || rawAge < 5 || rawAge > 120)) {
    return res.status(400).json({ error: 'Please enter a valid age between 5 and 120' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const user = await User.create({
      name,
      age: rawAge,
      email,
      passwordHash: await bcrypt.hash(password, 12),
    });
    await State.create({ user: user._id });
    setCookie(res, user._id);
    res.json({ ok: true, name: user.name, age: user.age, email: user.email });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'That email is already registered' });
    console.error('Signup error:', e.message);
    res.status(500).json({ error: 'Could not create account' });
  }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const user = await User.findOne({ email: String(req.body.email || '').trim().toLowerCase() });
    const ok = user && await bcrypt.compare(String(req.body.password || ''), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Wrong email or password' });
    setCookie(res, user._id);
    res.json({ ok: true, name: user.name || '', age: user.age, email: user.email });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Database query failed' });
  }
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', auth, async (req, res) => {
  const user = await User.findById(req.uid);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ email: user.email, name: user.name || '', age: user.age });
});

/* ---------- User data ---------- */
app.get('/api/state', auth, async (req, res) => {
  const s = await State.findOne({ user: req.uid });
  res.json({ habits: s ? s.habits : [], mood: s ? s.mood : {} });
});
app.put('/api/state', auth, async (req, res) => {
  const { habits, mood } = req.body;
  if (!Array.isArray(habits) || habits.length > 200 || typeof mood !== 'object' || mood === null)
    return res.status(400).json({ error: 'Invalid data' });
  await State.findOneAndUpdate({ user: req.uid }, { habits, mood }, { upsert: true });
  res.json({ ok: true });
});

/* ---------- AI coach (Groq, key stays on the server) ---------- */
app.post('/api/ai/chat', auth, aiLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!GROQ_API_KEY) return res.status(503).json({ error: 'AI not configured' });
  if (!Array.isArray(messages) || !messages.length || messages.length > 12 ||
      messages.some(m => typeof m.content !== 'string' || m.content.length > 8000 || !['user', 'assistant', 'system'].includes(m.role)))
    return res.status(400).json({ error: 'Invalid messages' });
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 600, temperature: 0.6 }),
    });
    const j = await r.json();
    if (r.status === 429) return res.status(429).json({ error: 'AI limit reached, try again later' });
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) { console.error('Groq error:', j.error && j.error.message); return res.status(502).json({ error: 'AI unavailable' }); }
    res.json({ text: text.trim() });
  } catch (e) { console.error(e); res.status(502).json({ error: 'AI unavailable' }); }
});

if (require.main === module) {
  const server = app.listen(PORT, () => console.log('Habitly running on http://localhost:' + PORT));
  connectDb()
    .then(() => console.log('MongoDB connected successfully'))
    .catch((e) => {
      console.error('MongoDB connection failed:', e.message);
      console.error('Hint: In MongoDB Atlas, ensure your current IP address is whitelisted in Network Access.');
    });
}

module.exports = app;
