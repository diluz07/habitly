require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { Resend } = require('resend');

const { MONGODB_URI, JWT_SECRET, GROQ_API_KEY, RESEND_API_KEY, EMAIL_FROM,
  GROQ_MODEL = 'qwen/qwen3.8-27b', PORT = 3000 } = process.env;
if (!MONGODB_URI || !JWT_SECRET) { console.error('Set MONGODB_URI and JWT_SECRET in .env'); process.exit(1); }

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/* ---------- Models ---------- */
const User = mongoose.model('User', new mongoose.Schema({
  name: { type: String, trim: true, default: '' },
  age: { type: Number, min: 1, max: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  isVerified: { type: Boolean, default: false },
  verificationCode: { type: String },
  verificationExpires: { type: Date },
  emailReminders: { type: Boolean, default: true },
  lastReminderSentDate: { type: String },
}, { timestamps: true }));

async function sendVerificationEmail(email, name, code) {
  if (!resend) {
    console.log('\n======================================================');
    console.log(`[Resend Sim] Verification code for ${email}: ${code}`);
    console.log('To send live emails, set RESEND_API_KEY in .env and Vercel');
    console.log('======================================================\n');
    return { ok: true, simulated: true };
  }
  const from = EMAIL_FROM || 'Habitly <verify@dilshad.runs-on.dev>';
  const greeting = name ? `Hi ${name},` : 'Hello,';
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif;background:#f6efe2;margin:0;padding:32px 16px;color:#2a211d">
      <div style="max-width:480px;margin:0 auto;background:#fdfaf3;border:1px solid #e8dfcd;border-radius:22px;padding:32px 24px;box-shadow:0 8px 30px rgba(42,33,29,0.06)">
        <div style="font-size:38px;text-align:center;margin-bottom:12px">🌱</div>
        <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:600;text-align:center;margin:0 0 8px;color:#2a211d">Verify your email</h1>
        <p style="font-size:14.5px;color:#7a6f64;text-align:center;line-height:1.5;margin:0 0 24px">
          ${greeting} Welcome to Habitly! Enter the 6-digit verification code below to activate your account and start tracking your habits.
        </p>
        <div style="background:#efe6d6;border-radius:14px;padding:18px 0;text-align:center;margin:20px 0">
          <span style="font-family:monospace,'DM Sans',sans-serif;font-size:34px;font-weight:700;letter-spacing:8px;color:#c8553d">
            ${code}
          </span>
        </div>
        <p style="font-size:12.5px;color:#9b8e82;text-align:center;margin:20px 0 0;line-height:1.4">
          This verification code expires in 15 minutes.<br>If you didn't create a Habitly account, you can safely ignore this email.
        </p>
      </div>
    </body>
    </html>
  `;

  try {
    let result = await resend.emails.send({
      from,
      to: email,
      subject: `${code} is your Habitly verification code`,
      html: emailHtml,
    });

    // If custom domain is not yet verified on Resend, automatically fallback to onboarding@resend.dev
    if (result.error && result.error.message && result.error.message.includes('not verified') && from !== 'Habitly <onboarding@resend.dev>') {
      result = await resend.emails.send({
        from: 'Habitly <onboarding@resend.dev>',
        to: email,
        subject: `${code} is your Habitly verification code`,
        html: emailHtml,
      });
    }

    if (result.error) {
      console.error('Resend error:', result.error);
      return { ok: false, error: result.error.message };
    }
    return { ok: true, data: result.data };
  } catch (err) {
    console.error('Resend exception:', err.message);
    return { ok: false, error: err.message };
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

async function sendHabitReminderEmail(email, name, habits = []) {
  if (!resend) {
    console.log('\n======================================================');
    console.log(`[Resend Sim] Habit reminder for ${email}`);
    console.log('======================================================\n');
    return { ok: true, simulated: true, pendingCount: 0, completedCount: 0 };
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;
  const dayOfWeek = now.getDay();

  // Find habits scheduled for today
  const scheduledToday = habits.filter(h => {
    if (!h || !h.name) return false;
    const dows = Array.isArray(h.dow) && h.dow.length ? h.dow : [0, 1, 2, 3, 4, 5, 6];
    return dows.includes(dayOfWeek);
  });

  const pending = scheduledToday.filter(h => !h.days || !h.days[todayStr]);
  const completed = scheduledToday.filter(h => h.days && h.days[todayStr]);

  const greeting = name ? `Hi ${name},` : 'Hello,';
  const from = EMAIL_FROM || 'Habitly <verify@dilshad.runs-on.dev>';

  let habitsListHtml = '';
  if (pending.length === 0 && completed.length > 0) {
    habitsListHtml = `
      <div style="background:#eaf5ec;border:1px solid #c3e6cb;border-radius:14px;padding:20px;text-align:center;margin:18px 0;">
        <span style="font-size:28px">🎉</span>
        <h3 style="margin:8px 0 4px;color:#276738;font-size:17px;font-weight:600">All habits completed today!</h3>
        <p style="margin:0;font-size:13.5px;color:#2f7a43">You've finished all ${completed.length} habits scheduled for today. Incredible discipline!</p>
      </div>
    `;
  } else if (scheduledToday.length === 0) {
    habitsListHtml = `
      <div style="background:#f4eee2;border:1px solid #e2d7c3;border-radius:14px;padding:18px;text-align:center;margin:18px 0;">
        <span style="font-size:24px">☕</span>
        <p style="font-size:14px;color:#6b5f54;margin:6px 0 0;line-height:1.4">
          No habits are scheduled for today. Rest up or add a new tiny habit in Habitly!
        </p>
      </div>
    `;
  } else {
    habitsListHtml = `
      <div style="margin:18px 0 10px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#c8553d;margin-bottom:10px">
          ⏳ Pending Habits (${pending.length})
        </div>
        ${pending.map(h => `
          <div style="background:#fff;border:1px solid #e8dfcd;border-radius:12px;padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
            <div>
              <span style="font-size:15px;font-weight:600;color:#2a211d">${escapeHtml(h.name)}</span>
              ${h.time ? `<span style="font-size:12px;color:#8a7f74;margin-left:8px">⏰ ${h.time}</span>` : ''}
            </div>
            <span style="background:#fdf2ef;color:#c8553d;font-size:11px;font-weight:700;padding:4px 8px;border-radius:6px;border:1px solid #fae3dc">Pending</span>
          </div>
        `).join('')}
      </div>
    `;
    if (completed.length > 0) {
      habitsListHtml += `
        <div style="margin-top:20px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#3d8a57;margin-bottom:10px">
            ✓ Done Today (${completed.length})
          </div>
          ${completed.map(h => `
            <div style="background:#fbfbf9;border:1px solid #ede8df;border-radius:12px;padding:10px 16px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;opacity:0.85">
              <span style="font-size:14px;color:#554c43;text-decoration:line-through">${escapeHtml(h.name)}</span>
              <span style="color:#3d8a57;font-weight:bold;font-size:13px">✓ Done</span>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif;background:#f6efe2;margin:0;padding:32px 16px;color:#2a211d">
      <div style="max-width:500px;margin:0 auto;background:#fdfaf3;border:1px solid #e8dfcd;border-radius:22px;padding:32px 24px;box-shadow:0 8px 30px rgba(42,33,29,0.06)">
        <div style="font-size:38px;text-align:center;margin-bottom:12px">🌱</div>
        <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:600;text-align:center;margin:0 0 6px;color:#2a211d">Habitly Daily Check-in</h1>
        <p style="font-size:14.5px;color:#7a6f64;text-align:center;margin:0 0 20px;line-height:1.5">
          ${greeting} here's your quick reminder to keep your daily streaks alive.
        </p>

        ${habitsListHtml}

        <div style="text-align:center;margin:28px 0 16px">
          <a href="https://diluz07-habitly.vercel.app" style="background:#c8553d;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 28px;border-radius:999px;display:inline-block;box-shadow:0 4px 14px rgba(200,85,61,0.25)">
            Open Habitly &amp; Check In →
          </a>
        </div>

        <p style="font-size:12px;color:#9b8e82;text-align:center;margin:24px 0 0;line-height:1.4">
          You received this because email reminders are enabled in your Habitly Profile.<br>
          Small daily actions build lifelong identity. You've got this!
        </p>
      </div>
    </body>
    </html>
  `;

  const subject = pending.length > 0
    ? `🌱 ${pending.length} habit${pending.length === 1 ? '' : 's'} waiting for you today`
    : `🌱 Great job! Your habits for today are all checked off`;

  try {
    let result = await resend.emails.send({
      from,
      to: email,
      subject,
      html: emailHtml,
    });

    if (result.error && result.error.message && result.error.message.includes('not verified') && from !== 'Habitly <onboarding@resend.dev>') {
      result = await resend.emails.send({
        from: 'Habitly <onboarding@resend.dev>',
        to: email,
        subject,
        html: emailHtml,
      });
    }

    if (result.error) {
      console.error('Resend reminder error:', result.error);
      return { ok: false, error: result.error.message, pendingCount: pending.length, completedCount: completed.length };
    }
    return { ok: true, data: result.data, pendingCount: pending.length, completedCount: completed.length };
  } catch (err) {
    console.error('Resend reminder exception:', err.message);
    return { ok: false, error: err.message, pendingCount: pending.length, completedCount: completed.length };
  }
}

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
  try {
    await connectDb();
    next();
  } catch (e) {
    console.error('Database connection error:', e.message);
    return res.status(503).json({
      error: 'Database is connecting or offline. In MongoDB Atlas Network Access, ensure 0.0.0.0/0 (Anywhere) is enabled for Vercel.'
    });
  }
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
    let user = await User.findOne({ email });
    if (user && user.isVerified) {
      return res.status(409).json({ error: 'That email is already registered and verified. Please log in.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    const passwordHash = await bcrypt.hash(password, 12);

    if (user && !user.isVerified) {
      user.name = name;
      user.age = rawAge;
      user.passwordHash = passwordHash;
      user.verificationCode = code;
      user.verificationExpires = expires;
      await user.save();
    } else {
      user = await User.create({
        name,
        age: rawAge,
        email,
        passwordHash,
        isVerified: false,
        verificationCode: code,
        verificationExpires: expires,
      });
      await State.create({ user: user._id });
    }

    const emailRes = await sendVerificationEmail(email, name, code);
    res.json({
      ok: true,
      needVerification: true,
      email: user.email,
      simulated: !!emailRes.simulated || !emailRes.ok,
      simulatedCode: (emailRes.simulated || !emailRes.ok) ? code : undefined,
      emailError: emailRes.error
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'That email is already registered' });
    console.error('Signup error:', e.message);
    res.status(500).json({ error: 'Could not create account' });
  }
});

app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();

  if (!email || !code) return res.status(400).json({ error: 'Email and verification code are required' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'Account not found' });
    if (user.isVerified) {
      setCookie(res, user._id);
      return res.json({ ok: true, verified: true, name: user.name, age: user.age, email: user.email });
    }
    if (user.verificationCode !== code) {
      return res.status(400).json({ error: 'Invalid verification code. Please check and try again.' });
    }
    if (!user.verificationExpires || user.verificationExpires < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    user.isVerified = true;
    user.verificationCode = undefined;
    user.verificationExpires = undefined;
    await user.save();

    setCookie(res, user._id);
    res.json({ ok: true, name: user.name || '', age: user.age, email: user.email });
  } catch (e) {
    console.error('Verification error:', e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/auth/resend-code', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'Account not found' });
    if (user.isVerified) return res.status(400).json({ error: 'Account is already verified. Please log in.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.verificationCode = code;
    user.verificationExpires = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    const emailRes = await sendVerificationEmail(email, user.name, code);
    res.json({
      ok: true,
      message: 'New verification code sent',
      simulated: !!emailRes.simulated || !emailRes.ok,
      simulatedCode: (emailRes.simulated || !emailRes.ok) ? code : undefined,
      emailError: emailRes.error
    });
  } catch (e) {
    console.error('Resend code error:', e.message);
    res.status(500).json({ error: 'Could not send verification email' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await User.findOne({ email });
    const ok = user && await bcrypt.compare(String(req.body.password || ''), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Wrong email or password' });

    // Enforce email verification if account explicitly unverified
    if (user.isVerified === false) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      user.verificationCode = code;
      user.verificationExpires = new Date(Date.now() + 15 * 60 * 1000);
      await user.save();
      const emailRes = await sendVerificationEmail(user.email, user.name, code);
      return res.status(403).json({
        error: 'Please verify your email address to continue',
        needVerification: true,
        email: user.email,
        simulated: !!emailRes.simulated || !emailRes.ok,
        simulatedCode: (emailRes.simulated || !emailRes.ok) ? code : undefined,
        emailError: emailRes.error
      });
    }

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
  res.json({
    email: user.email,
    name: user.name || '',
    age: user.age,
    emailReminders: user.emailReminders !== false
  });
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

/* ---------- Habit Reminders via Email ---------- */
app.post('/api/reminders/send-now', auth, async (req, res) => {
  try {
    const user = await User.findById(req.uid);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const state = await State.findOne({ user: req.uid });
    const habits = state ? state.habits : [];
    const result = await sendHabitReminderEmail(user.email, user.name, habits);
    if (!result.ok) {
      return res.status(500).json({ error: result.error || 'Failed to send reminder email' });
    }
    res.json({
      ok: true,
      email: user.email,
      pendingCount: result.pendingCount,
      completedCount: result.completedCount,
      simulated: !!result.simulated
    });
  } catch (err) {
    console.error('send-now error:', err);
    res.status(500).json({ error: 'Server error sending reminder' });
  }
});

app.put('/api/reminders/preferences', auth, async (req, res) => {
  try {
    const emailReminders = req.body.emailReminders !== false;
    await User.findByIdAndUpdate(req.uid, { emailReminders });
    res.json({ ok: true, emailReminders });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update reminder preferences' });
  }
});

// Automated Daily Cron runner endpoint
app.all('/api/cron/reminders', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const users = await User.find({ isVerified: true, emailReminders: { $ne: false }, lastReminderSentDate: { $ne: todayStr } }).limit(50);
    let sentCount = 0;
    for (const u of users) {
      const state = await State.findOne({ user: u._id });
      if (state && state.habits && state.habits.length) {
        const sendRes = await sendHabitReminderEmail(u.email, u.name, state.habits);
        if (sendRes.ok) {
          sentCount++;
          u.lastReminderSentDate = todayStr;
          await u.save();
        }
      }
    }
    res.json({ ok: true, today: todayStr, eligibleUsers: users.length, sentCount });
  } catch (err) {
    console.error('Cron reminders error:', err);
    res.status(500).json({ error: 'Cron execution failed' });
  }
});

/* ---------- AI coach (Groq, key stays on the server) ---------- */
app.post('/api/ai/chat', auth, aiLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!GROQ_API_KEY) return res.status(503).json({ error: 'AI not configured' });
  if (!Array.isArray(messages) || !messages.length || messages.length > 12 ||
      messages.some(m => typeof m.content !== 'string' || m.content.length > 8000 || !['user', 'assistant', 'system'].includes(m.role)))
    return res.status(400).json({ error: 'Invalid messages' });
  try {
    const modelsToTry = Array.from(new Set([GROQ_MODEL, 'qwen/qwen3.8-27b', 'allam-2-7b', 'openai/gpt-oss-120b'].filter(Boolean)));
    let lastError = null;
    for (const model of modelsToTry) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: 600, temperature: 0.6 }),
      });
      const j = await r.json();
      if (r.status === 429) return res.status(429).json({ error: 'AI limit reached, try again later' });
      const msg = j.choices && j.choices[0] && j.choices[0].message;
      const text = msg && (msg.content || msg.reasoning);
      if (text && text.trim()) {
        return res.json({ text: text.trim() });
      }
      lastError = j.error && j.error.message;
      console.warn(`Groq model ${model} failed:`, lastError);
    }
    return res.status(502).json({ error: lastError || 'AI unavailable' });
  } catch (e) {
    console.error('AI chat exception:', e);
    res.status(502).json({ error: 'AI unavailable' });
  }
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
