const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(path.join(__dirname, 'expenses.db'));

// ── DB Setup ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    description  TEXT NOT NULL,
    amount       REAL NOT NULL,
    payer        TEXT NOT NULL,
    split_among  TEXT NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Server-Sent Events (real-time sync) ───────────────────────────────────────
let clients = [];

function broadcast() {
  const data = `data: update\n\n`;
  clients.forEach(c => c.write(data));
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');

  clients.push(res);
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

// ── Members API ───────────────────────────────────────────────────────────────
app.get('/api/members', (req, res) => {
  const rows = db.prepare('SELECT name FROM members ORDER BY id').all();
  res.json(rows.map(r => r.name));
});

app.post('/api/members', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'שם ריק' });
  try {
    db.prepare('INSERT INTO members (name) VALUES (?)').run(name.trim());
    broadcast();
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'השם כבר קיים' });
  }
});

app.delete('/api/members/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const used = db.prepare(
    `SELECT COUNT(*) AS c FROM expenses
     WHERE payer = ? OR split_among LIKE ?`
  ).get(name, `%"${name}"%`);

  if (used.c > 0) {
    return res.status(400).json({ error: `לא ניתן למחוק – ${name} מופיע/ה בתשלומים` });
  }

  db.prepare('DELETE FROM members WHERE name = ?').run(name);
  broadcast();
  res.json({ ok: true });
});

// ── Expenses API ──────────────────────────────────────────────────────────────
app.get('/api/expenses', (req, res) => {
  const rows = db.prepare('SELECT * FROM expenses ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ ...r, split_among: JSON.parse(r.split_among) })));
});

app.post('/api/expenses', (req, res) => {
  const { description, amount, payer, split_among } = req.body;
  if (!description || !amount || !payer || !split_among?.length) {
    return res.status(400).json({ error: 'נתונים חסרים' });
  }
  db.prepare(
    'INSERT INTO expenses (description, amount, payer, split_among) VALUES (?, ?, ?, ?)'
  ).run(description.trim(), parseFloat(amount), payer, JSON.stringify(split_among));
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/expenses/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  broadcast();
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running → http://localhost:${PORT}`);
});
