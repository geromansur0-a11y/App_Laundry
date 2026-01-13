const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const DB_PATH = path.join(__dirname, 'laundry.db');

const db = new sqlite3.Database(DB_PATH);

function init() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      weight REAL DEFAULT 0,
      price_per_kg REAL DEFAULT 0,
      total REAL DEFAULT 0,
      status TEXT DEFAULT 'received',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      due_date TEXT,
      note TEXT,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )`);

    // Optional: sample prices table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    // insert default price if not exists
    db.get("SELECT value FROM settings WHERE key = 'price_per_kg'", (err, row) => {
      if (!row) {
        db.run("INSERT INTO settings(key, value) VALUES(?, ?)", ['price_per_kg', '12000']);
      }
    });
  });
}

function close() {
  db.close();
}

module.exports = { db, init, close };
