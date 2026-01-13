const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { db, init } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

init();

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: get settings (price)
app.get('/api/settings', (req, res) => {
  db.all("SELECT key, value FROM settings", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const out = {};
    rows.forEach(r => out[r.key] = r.value);
    res.json(out);
  });
});

// API: customers
app.get('/api/customers', (req, res) => {
  const q = req.query.q;
  let sql = "SELECT * FROM customers ORDER BY created_at DESC LIMIT 100";
  const params = [];
  if (q) {
    sql = "SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY created_at DESC LIMIT 100";
    params.push(`%${q}%`, `%${q}%`);
  }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/customers', (req, res) => {
  const { name, phone, note } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const stmt = db.prepare("INSERT INTO customers(name, phone, note) VALUES(?,?,?)");
  stmt.run([name, phone || '', note || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT * FROM customers WHERE id = ?", [this.lastID], (e, row) => {
      res.json(row);
    });
  });
});

// API: orders
app.get('/api/orders', (req, res) => {
  const q = req.query.q;
  const status = req.query.status;
  let sql = `SELECT o.*, c.name as customer_name, c.phone as customer_phone
    FROM orders o LEFT JOIN customers c ON o.customer_id = c.id`;
  const params = [];
  const cond = [];
  if (q) {
    cond.push("(c.name LIKE ? OR c.phone LIKE ? OR o.id = ?)");
    params.push(`%${q}%`, `%${q}%`, q);
  }
  if (status) {
    cond.push("o.status = ?");
    params.push(status);
  }
  if (cond.length) sql += " WHERE " + cond.join(" AND ");
  sql += " ORDER BY o.created_at DESC LIMIT 200";
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/orders', (req, res) => {
  const { customer_id, weight, price_per_kg, due_date, note } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
  const total = (parseFloat(weight) || 0) * (parseFloat(price_per_kg) || 0);
  const stmt = db.prepare(`INSERT INTO orders(customer_id, weight, price_per_kg, total, due_date, note) VALUES(?,?,?,?,?,?)`);
  stmt.run([customer_id, weight || 0, price_per_kg || 0, total, due_date || null, note || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT o.*, c.name as customer_name FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE o.id = ?", [this.lastID], (e, row) => {
      // create notification: new order
      db.run("INSERT INTO notifications(type, message, order_id) VALUES(?, ?, ?)", ['order', `Order #${row.id} dibuat untuk ${row.customer_name || 'pelanggan'}`, row.id]);
      res.json(row);
    });
  });
});

app.put('/api/orders/:id', (req, res) => {
  const id = req.params.id;
  const { status, weight, price_per_kg, note } = req.body;
  db.get("SELECT * FROM orders WHERE id = ?", [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'not found' });
    const newWeight = typeof weight !== 'undefined' ? weight : order.weight;
    const newPrice = typeof price_per_kg !== 'undefined' ? price_per_kg : order.price_per_kg;
    const total = (parseFloat(newWeight) || 0) * (parseFloat(newPrice) || 0);
    const stmt = db.prepare("UPDATE orders SET status = COALESCE(?, status), weight = ?, price_per_kg = ?, total = ?, note = COALESCE(?, note) WHERE id = ?");
    stmt.run([status || null, newWeight, newPrice, total, note || null, id], function(e) {
      if (e) return res.status(500).json({ error: e.message });
      db.get("SELECT o.*, c.name as customer_name FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE o.id = ?", [id], (err2, row) => {
        // if status changed, create notification
        if (status && status !== order.status) {
          const msg = `Order #${id} status: ${order.status} → ${status}`;
          db.run("INSERT INTO notifications(type, message, order_id) VALUES(?, ?, ?)", ['order', msg, id]);
        }
        res.json(row);
      });
    });
  });
});

// notifications API
app.get('/api/notifications', (req, res) => {
  const unread = req.query.unread === 'true';
  let sql = "SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200";
  const params = [];
  if (unread) {
    sql = "SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC LIMIT 100";
  }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.put('/api/notifications/:id/read', (req, res) => {
  const id = req.params.id;
  db.run("UPDATE notifications SET read = 1 WHERE id = ?", [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, read: 1 });
  });
});

// reports API (JSON) — now includes orders array for PDF generation on client
app.get('/api/reports/daily', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const summarySql = `SELECT COUNT(*) as total_orders, COALESCE(SUM(total),0) as total_revenue, COALESCE(SUM(weight),0) as total_weight
    FROM orders WHERE DATE(created_at) = ?`;
  const breakdownSql = `SELECT status, COUNT(*) as count, COALESCE(SUM(total),0) as sum_total FROM orders WHERE DATE(created_at) = ? GROUP BY status`;
  const ordersSql = `SELECT o.id, o.created_at, c.name as customer_name, c.phone as customer_phone, o.weight, o.price_per_kg, o.total, o.status, o.due_date, o.note
    FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE DATE(o.created_at) = ? ORDER BY o.created_at ASC`;

  db.get(summarySql, [date], (err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(breakdownSql, [date], (err2, breakdown) => {
      if (err2) return res.status(500).json({ error: err2.message });
      db.all(ordersSql, [date], (err3, orders) => {
        if (err3) return res.status(500).json({ error: err3.message });
        res.json({ date, summary, breakdown, orders });
      });
    });
  });
});

app.get('/api/reports/period', (req, res) => {
  const start = req.query.start;
  const end = req.query.end;
  if (!start || !end) return res.status(400).json({ error: 'start and end required (YYYY-MM-DD)' });
  const summarySql = `SELECT COUNT(*) as total_orders, COALESCE(SUM(total),0) as total_revenue, COALESCE(SUM(weight),0) as total_weight
    FROM orders WHERE DATE(created_at) BETWEEN ? AND ?`;
  const breakdownSql = `SELECT status, COUNT(*) as count, COALESCE(SUM(total),0) as sum_total FROM orders WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY status`;
  const ordersSql = `SELECT o.id, o.created_at, c.name as customer_name, c.phone as customer_phone, o.weight, o.price_per_kg, o.total, o.status, o.due_date, o.note
    FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE DATE(o.created_at) BETWEEN ? AND ? ORDER BY o.created_at ASC`;

  db.get(summarySql, [start, end], (err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(breakdownSql, [start, end], (err2, breakdown) => {
      if (err2) return res.status(500).json({ error: err2.message });
      db.all(ordersSql, [start, end], (err3, orders) => {
        if (err3) return res.status(500).json({ error: err3.message });
        res.json({ start, end, summary, breakdown, orders });
      });
    });
  });
});

// Helper to escape CSV fields
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

// reports CSV endpoints (unchanged)
app.get('/api/reports/daily.csv', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const sql = `SELECT o.id, o.created_at, c.name as customer_name, c.phone as customer_phone, o.weight, o.price_per_kg, o.total, o.status, o.due_date, o.note
    FROM orders o LEFT JOIN customers c ON o.customer_id = c.id
    WHERE DATE(o.created_at) = ? ORDER BY o.created_at ASC`;
  db.all(sql, [date], (err, rows) => {
    if (err) return res.status(500).send('Error: ' + err.message);
    let csv = '';
    const header = ['id','created_at','customer_name','customer_phone','weight','price_per_kg','total','status','due_date','note'];
    csv += header.join(',') + '\n';
    rows.forEach(r => {
      const line = [
        csvEscape(r.id),
        csvEscape(r.created_at),
        csvEscape(r.customer_name),
        csvEscape(r.customer_phone),
        csvEscape(r.weight),
        csvEscape(r.price_per_kg),
        csvEscape(r.total),
        csvEscape(r.status),
        csvEscape(r.due_date),
        csvEscape(r.note)
      ].join(',');
      csv += line + '\n';
    });
    // append summary
    const summarySql = `SELECT COUNT(*) as total_orders, COALESCE(SUM(total),0) as total_revenue, COALESCE(SUM(weight),0) as total_weight
      FROM orders WHERE DATE(created_at) = ?`;
    db.get(summarySql, [date], (err2, summary) => {
      if (!err2 && summary) {
        csv += '\n';
        csv += `#summary,,,\n`;
        csv += `total_orders,${summary.total_orders}\n`;
        csv += `total_revenue,${summary.total_revenue}\n`;
        csv += `total_weight,${summary.total_weight}\n`;
      }
      const filename = `report-daily-${date}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    });
  });
});

app.get('/api/reports/period.csv', (req, res) => {
  const start = req.query.start;
  const end = req.query.end;
  if (!start || !end) return res.status(400).send('start and end required (YYYY-MM-DD)');
  const sql = `SELECT o.id, o.created_at, c.name as customer_name, c.phone as customer_phone, o.weight, o.price_per_kg, o.total, o.status, o.due_date, o.note
    FROM orders o LEFT JOIN customers c ON o.customer_id = c.id
    WHERE DATE(o.created_at) BETWEEN ? AND ? ORDER BY o.created_at ASC`;
  db.all(sql, [start, end], (err, rows) => {
    if (err) return res.status(500).send('Error: ' + err.message);
    let csv = '';
    const header = ['id','created_at','customer_name','customer_phone','weight','price_per_kg','total','status','due_date','note'];
    csv += header.join(',') + '\n';
    rows.forEach(r => {
      const line = [
        csvEscape(r.id),
        csvEscape(r.created_at),
        csvEscape(r.customer_name),
        csvEscape(r.customer_phone),
        csvEscape(r.weight),
        csvEscape(r.price_per_kg),
        csvEscape(r.total),
        csvEscape(r.status),
        csvEscape(r.due_date),
        csvEscape(r.note)
      ].join(',');
      csv += line + '\n';
    });
    // append summary
    const summarySql = `SELECT COUNT(*) as total_orders, COALESCE(SUM(total),0) as total_revenue, COALESCE(SUM(weight),0) as total_weight
      FROM orders WHERE DATE(created_at) BETWEEN ? AND ?`;
    db.get(summarySql, [start, end], (err2, summary) => {
      if (!err2 && summary) {
        csv += '\n';
        csv += `#summary,,,\n`;
        csv += `total_orders,${summary.total_orders}\n`;
        csv += `total_revenue,${summary.total_revenue}\n`;
        csv += `total_weight,${summary.total_weight}\n`;
      }
      const filename = `report-period-${start}_to_${end}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    });
  });
});

// simple settings update (price)
app.put('/api/settings/price_per_kg', (req, res) => {
  const v = req.body.value;
  if (!v) return res.status(400).json({ error: 'value required' });
  db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['price_per_kg', v], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ key: 'price_per_kg', value: v });
  });
});

// fallback to frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Laundry app listening on http://localhost:${PORT}`);
});
