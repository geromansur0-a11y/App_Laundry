// Laundry mandiri: IndexedDB-based single-page app
// Penyimpanan: IndexedDB (stores: customers, orders, notifications, settings)

const DB_NAME = 'laundry-standalone-db';
const DB_VERSION = 1;
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('customers')) {
        idb.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
      }
      if (!idb.objectStoreNames.contains('orders')) {
        const os = idb.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
        os.createIndex('created_at', 'created_at', { unique: false });
        os.createIndex('status', 'status', { unique: false });
      }
      if (!idb.objectStoreNames.contains('notifications')) {
        idb.createObjectStore('notifications', { keyPath: 'id', autoIncrement: true });
      }
      if (!idb.objectStoreNames.contains('settings')) {
        idb.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      db = req.result;
      // set default price if not exists
      getSetting('price_per_kg').then(v => {
        if (v == null) setSetting('price_per_kg', '12000');
      }).catch(()=>{});
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeNames, mode='readonly') {
  return openDb().then(database => database.transaction(storeNames, mode));
}

// customers
function addCustomer(data) {
  return tx(['customers'], 'readwrite').then(tr => {
    const s = tr.objectStore('customers');
    return new Promise((res, rej) => {
      const now = new Date().toISOString();
      const toAdd = { name: data.name, phone: data.phone || '', note: data.note || '', created_at: now };
      const r = s.add(toAdd);
      r.onsuccess = () => {
        toAdd.id = r.result;
        res(toAdd);
      };
      r.onerror = () => rej(r.error);
    });
  });
}
function getCustomers(q='') {
  return tx(['customers']).then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('customers');
    const out = [];
    s.openCursor(null, 'prev').onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return res(out.slice(0,200));
      const v = cur.value;
      if (!q || v.name.toLowerCase().includes(q.toLowerCase()) || (v.phone||'').includes(q)) out.push(v);
      cur.continue();
    };
  }));
}

// orders
function addOrder(data) {
  return tx(['orders'], 'readwrite').then(tr => {
    const s = tr.objectStore('orders');
    return new Promise((res, rej) => {
      const now = new Date().toISOString();
      const total = (parseFloat(data.weight) || 0) * (parseFloat(data.price_per_kg) || 0);
      const toAdd = {
        customer_id: data.customer_id,
        weight: parseFloat(data.weight) || 0,
        price_per_kg: parseFloat(data.price_per_kg) || 0,
        total,
        status: 'received',
        created_at: now,
        due_date: data.due_date || null,
        note: data.note || ''
      };
      const r = s.add(toAdd);
      r.onsuccess = () => {
        toAdd.id = r.result;
        // create notification
        addNotification({ type: 'order', message: `Order #${toAdd.id} dibuat` }).catch(()=>{});
        res(toAdd);
      };
      r.onerror = () => rej(r.error);
    });
  });
}
function getOrders({ q='', status=null } = {}) {
  return tx(['orders','customers']).then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('orders');
    const out = [];
    s.openCursor(null, 'prev').onsuccess = async (e) => {
      const cur = e.target.result;
      if (!cur) return finalize();
      const o = cur.value;
      // simple match: customer name/phone or id
      if (q) {
        const matchId = String(o.id) === q;
        const customer = await getCustomerById(o.customer_id);
        const matchText = (customer && (customer.name || '').toLowerCase().includes(q.toLowerCase())) || (customer && customer.phone && customer.phone.includes(q));
        if (!(matchId || matchText)) { cur.continue(); return; }
      }
      if (status && o.status !== status) { cur.continue(); return; }
      const customer = await getCustomerById(o.customer_id);
      o.customer_name = customer ? customer.name : '';
      o.customer_phone = customer ? customer.phone : '';
      out.push(o);
      cur.continue();
    };
    function finalize() {
      res(out.slice(0,1000));
    }
  }));
}
function getCustomerById(id) {
  return tx(['customers']).then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('customers');
    const r = s.get(id);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  }));
}
function updateOrder(id, patch) {
  return tx(['orders']).then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('orders');
    const r = s.get(id);
    r.onsuccess = async () => {
      const o = r.result;
      if (!o) return rej(new Error('not found'));
      const prevStatus = o.status;
      Object.assign(o, patch);
      // recalc total if weight/price changes
      o.total = (parseFloat(o.weight) || 0) * (parseFloat(o.price_per_kg) || 0);
      const w = s.put(o);
      w.onsuccess = () => {
        if (patch.status && patch.status !== prevStatus) {
          addNotification({ type: 'order', message: `Order #${id} status: ${prevStatus} → ${patch.status}` }).catch(()=>{});
        }
        res(o);
      };
      w.onerror = () => rej(w.error);
    };
    r.onerror = () => rej(r.error);
  }));
}

// notifications
function addNotification(n) {
  return tx(['notifications'], 'readwrite').then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('notifications');
    const now = new Date().toISOString();
    const toAdd = { type: n.type||'info', message: n.message||'', order_id: n.order_id||null, read: 0, created_at: now };
    const r = s.add(toAdd);
    r.onsuccess = () => { toAdd.id = r.result; // trigger system notification if allowed
      showBrowserNotification(toAdd).catch(()=>{});
      res(toAdd);
    };
    r.onerror = () => rej(r.error);
  }));
}
function getNotifications({ unreadOnly=true } = {}) {
  return tx(['notifications']).then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('notifications');
    const out = [];
    s.openCursor(null, 'prev').onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return res(out);
      const n = cur.value;
      if (!unreadOnly || n.read === 0) out.push(n);
      cur.continue();
    };
  }));
}
function markNotificationRead(id) {
  return tx(['notifications'], 'readwrite').then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('notifications');
    const r = s.get(id);
    r.onsuccess = () => {
      const n = r.result;
      if (!n) return res(null);
      n.read = 1;
      const w = s.put(n);
      w.onsuccess = () => res(n);
      w.onerror = () => rej(w.error);
    };
    r.onerror = () => rej(r.error);
  }));
}
function markAllNotificationsRead() {
  return tx(['notifications'], 'readwrite').then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('notifications');
    const req = s.openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return res(true);
      const n = cur.value;
      if (n.read === 0) { n.read = 1; cur.update(n); }
      cur.continue();
    };
    req.onerror = () => rej(req.error);
  }));
}

// settings
function getSetting(key) {
  return tx(['settings']).then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('settings');
    const r = s.get(key);
    r.onsuccess = () => res(r.result ? r.result.value : null);
    r.onerror = () => rej(r.error);
  }));
}
function setSetting(key, value) {
  return tx(['settings'], 'readwrite').then(tr => new Promise((res, rej) => {
    const s = tr.objectStore('settings');
    const r = s.put({ key, value: String(value) });
    r.onsuccess = () => res(true);
    r.onerror = () => rej(r.error);
  }));
}

// reports
async function getDailyReport(date) {
  // date YYYY-MM-DD
  const orders = await getOrders({ q: '' });
  const filtered = orders.filter(o => (o.created_at || '').slice(0,10) === date);
  return buildReportFromOrders(filtered, { date });
}
async function getPeriodReport(start, end) {
  const orders = await getOrders({ q: '' });
  const filtered = orders.filter(o => {
    const d = (o.created_at||'').slice(0,10);
    return d >= start && d <= end;
  });
  return buildReportFromOrders(filtered, { start, end });
}
function buildReportFromOrders(orders, meta) {
  const summary = {
    total_orders: orders.length,
    total_revenue: orders.reduce((s,o) => s + (parseFloat(o.total)||0), 0),
    total_weight: orders.reduce((s,o) => s + (parseFloat(o.weight)||0), 0)
  };
  const breakdown = {};
  orders.forEach(o => {
    breakdown[o.status] = breakdown[o.status] || { count: 0, sum_total: 0 };
    breakdown[o.status].count += 1;
    breakdown[o.status].sum_total += (parseFloat(o.total)||0);
  });
  const breakdownArr = Object.keys(breakdown).map(k => ({ status: k, count: breakdown[k].count, sum_total: breakdown[k].sum_total }));
  return { meta, summary, breakdown: breakdownArr, orders };
}

// export CSV (client-side)
function exportCsvOrders(orders, filename) {
  const header = ['id','created_at','customer_name','customer_phone','weight','price_per_kg','total','status','due_date','note'];
  let csv = header.join(',') + '\n';
  orders.forEach(r => {
    const line = [
      csvEscape(r.id),
      csvEscape(r.created_at),
      csvEscape(r.customer_name || ''),
      csvEscape(r.customer_phone || ''),
      csvEscape(r.weight),
      csvEscape(r.price_per_kg),
      csvEscape(r.total),
      csvEscape(r.status),
      csvEscape(r.due_date || ''),
      csvEscape(r.note || '')
    ].join(',');
    csv += line + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
}
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

// export PDF (client-side) using jsPDF + autotable
function exportPdfOrders(title, orders, summary, filename) {
  if (!window.jspdf || !window.jspdf.jsPDF) { alert('jsPDF tidak tersedia'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginLeft = 40;
  let y = 40;
  doc.setFontSize(14);
  doc.text(title, marginLeft, y);
  y += 12;
  const head = [['ID','Waktu','Pelanggan','Telepon','Berat','Harga/kg','Total','Status','Due','Catatan']];
  const body = orders.map(o => [
    o.id,
    o.created_at,
    o.customer_name || '',
    o.customer_phone || '',
    o.weight,
    o.price_per_kg,
    o.total,
    o.status,
    o.due_date || '',
    o.note || ''
  ]);
  doc.autoTable({
    startY: y + 10,
    head,
    body,
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [41, 128, 185], textColor: 255 },
    margin: { left: marginLeft, right: marginLeft }
  });
  const finalY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 10 : doc.internal.pageSize.getHeight() - 60;
  doc.setFontSize(11);
  doc.text(`Total Order: ${summary.total_orders}`, marginLeft, finalY);
  doc.text(`Total Pendapatan: Rp ${summary.total_revenue}`, marginLeft, finalY + 14);
  doc.text(`Total Berat: ${summary.total_weight} kg`, marginLeft, finalY + 28);
  doc.save(filename);
}

// small helpers
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000 * 10);
}
async function showBrowserNotification(n) {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      const title = "Laundry - Notifikasi";
      const body = n.message;
      const opt = { body, tag: 'laundry-notif-' + n.id, renotify: true };
      new Notification(title, opt);
    } else if (Notification.permission !== "denied") {
      const permission = await Notification.requestPermission();
      if (permission === "granted") showBrowserNotification(n);
    }
  } catch (e) { /* ignore */ }
}

// UI wiring
async function loadSettingsToUI() {
  const price = await getSetting('price_per_kg') || '12000';
  document.getElementById('order-price').value = price;
}
async function loadCustomersToUI(q='') {
  const customers = await getCustomers(q);
  const sel = document.getElementById('select-customer');
  sel.innerHTML = '<option value="">Pilih pelanggan...</option>';
  customers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name + (c.phone ? ' • ' + c.phone : '');
    sel.appendChild(opt);
  });
}
document.getElementById('form-add-customer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  if (!name) return alert('Masukkan nama');
  try {
    await addCustomer({ name, phone });
    document.getElementById('cust-name').value = '';
    document.getElementById('cust-phone').value = '';
    await loadCustomersToUI();
    alert('Pelanggan ditambahkan');
  } catch (err) { alert('Error: ' + err.message); }
});

document.getElementById('form-add-order').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customer_id = Number(document.getElementById('select-customer').value);
  const weight = parseFloat(document.getElementById('order-weight').value) || 0;
  const price_per_kg = parseFloat(document.getElementById('order-price').value) || 0;
  if (!customer_id) return alert('Pilih pelanggan');
  try {
    await addOrder({ customer_id, weight, price_per_kg });
    document.getElementById('order-weight').value = '';
    await renderOrders();
    alert('Order dibuat');
    await refreshNotifications();
  } catch (err) { alert('Error: ' + err.message); }
});

document.getElementById('btn-refresh').addEventListener('click', () => renderOrders());
document.getElementById('btn-search').addEventListener('click', () => renderOrders());
document.getElementById('filter-status').addEventListener('change', () => renderOrders());

async function renderOrders() {
  const q = document.getElementById('search-q').value.trim();
  const status = document.getElementById('filter-status').value || null;
  const orders = await getOrders({ q, status });
  const container = document.getElementById('orders-list');
  container.innerHTML = '';
  if (!orders.length) { container.innerHTML = '<div class="text-muted">Tidak ada order.</div>'; return; }
  orders.forEach(o => {
    const card = document.createElement('div');
    card.className = 'card mb-2 p-2';
    card.innerHTML = `
      <div class="d-flex justify-content-between">
        <div><strong>#${o.id}</strong> ${o.customer_name || ''} <small class="text-muted">${o.customer_phone || ''}</small></div>
        <div><span class="badge bg-secondary">${o.status}</span></div>
      </div>
      <div class="small text-muted">Berat: ${o.weight} kg • Harga/kg: ${o.price_per_kg} • Total: Rp ${o.total}</div>
      <div class="mt-2 d-flex gap-2">
        <button class="btn btn-sm btn-outline-primary btn-print">Nota</button>
        <select class="form-select form-select-sm status-select" style="max-width:200px;">
          <option value="">-- Ubah status --</option>
          <option value="received">Diterima</option>
          <option value="processing">Diproses</option>
          <option value="done">Selesai</option>
          <option value="picked">Diambil</option>
        </select>
      </div>
    `;
    card.querySelector('.btn-print').addEventListener('click', () => {
      const w = window.open('', '_blank');
      w.document.write(`<pre>Nota Laundry\nNo: ${o.id}\nPelanggan: ${o.customer_name || '-'}\nTelp: ${o.customer_phone || '-'}\nBerat: ${o.weight} kg\nHarga/kg: ${o.price_per_kg}\nTotal: Rp ${o.total}\nStatus: ${o.status}\n\nTerima kasih!</pre>`);
      w.print();
    });
    card.querySelector('.status-select').addEventListener('change', async (e) => {
      const newStatus = e.target.value;
      if (!newStatus) return;
      await updateOrder(o.id, { status: newStatus });
      renderOrders();
      refreshNotifications();
    });
    container.appendChild(card);
  });
}

/* Notifications UI */
const notifBtn = document.getElementById('btn-notif');
const notifPanel = document.getElementById('notif-panel');
const notifListEl = document.getElementById('notif-list');
const notifCountEl = document.getElementById('notif-count');

notifBtn.addEventListener('click', () => {
  notifPanel.style.display = notifPanel.style.display === 'none' ? 'block' : 'none';
  if (notifPanel.style.display === 'block') fetchNotifications(false);
});
document.getElementById('btn-close-notif').addEventListener('click', () => { notifPanel.style.display='none'; });
document.getElementById('btn-mark-all-read').addEventListener('click', async () => { await markAllNotificationsRead(); fetchNotifications(false); });

async function fetchNotifications(unreadOnly=true) {
  const list = await getNotifications({ unreadOnly });
  notifCountEl.textContent = list.length ? String(list.length) : '';
  if (unreadOnly && list.length) list.slice(0,5).reverse().forEach(n => showBrowserNotification(n).catch(()=>{}));
  if (!unreadOnly || notifPanel.style.display === 'block') renderNotifList(list);
}
async function refreshNotifications() { await fetchNotifications(true); }
function renderNotifList(list) {
  notifListEl.innerHTML = '';
  if (!list.length) { notifListEl.innerHTML = '<div class="text-muted small">Tidak ada notifikasi.</div>'; return; }
  list.forEach(n => {
    const a = document.createElement('div');
    a.className = 'list-group-item list-group-item-action';
    a.setAttribute('data-id', n.id);
    a.innerHTML = `<div class="d-flex justify-content-between"><div>${escapeHtml(n.message)}</div><small class="text-muted">${n.created_at}</small></div>`;
    a.addEventListener('click', async () => {
      await markNotificationRead(n.id);
      fetchNotifications(false);
    });
    notifListEl.appendChild(a);
  });
}

/* Reports UI wiring */
document.getElementById('btn-reports-toggle').addEventListener('click', () => { document.getElementById('reports-panel').style.display = 'block'; });
document.getElementById('btn-close-reports').addEventListener('click', () => { document.getElementById('reports-panel').style.display = 'none'; });

document.getElementById('btn-show-daily').addEventListener('click', async () => {
  const date = document.getElementById('report-date').value || new Date().toISOString().slice(0,10);
  const r = await getDailyReport(date);
  showReportResult(r, false);
});
document.getElementById('btn-show-period').addEventListener('click', async () => {
  const start = document.getElementById('report-start').value;
  const end = document.getElementById('report-end').value;
  if (!start || !end) return alert('Isi start dan end');
  const r = await getPeriodReport(start, end);
  showReportResult(r, true);
});
function showReportResult(res, isPeriod=false) {
  let html = '';
  if (isPeriod) {
    html += `<div><strong>Periode:</strong> ${res.meta.start} — ${res.meta.end}</div>`;
  } else {
    html += `<div><strong>Tanggal:</strong> ${res.meta.date}</div>`;
  }
  html += `<div><strong>Total Order:</strong> ${res.summary.total_orders}</div>`;
  html += `<div><strong>Total Pendapatan:</strong> Rp ${res.summary.total_revenue}</div>`;
  html += `<div><strong>Total Berat:</strong> ${res.summary.total_weight} kg</div>`;
  html += '<div class="mt-2"><strong>Breakdown per status:</strong></div>';
  res.breakdown.forEach(b => { html += `<div>${b.status}: ${b.count} • Rp ${b.sum_total}</div>`; });
  document.getElementById('report-result').innerHTML = html;
  // store last shown report for export
  window.__lastReport = res;
}

/* Export handlers (CSV + PDF client-side) */
document.getElementById('btn-export-daily').addEventListener('click', async () => {
  const date = document.getElementById('report-date').value || new Date().toISOString().slice(0,10);
  const r = await getDailyReport(date);
  exportCsvOrders(r.orders, `report-daily-${date}.csv`);
});
document.getElementById('btn-export-period').addEventListener('click', async () => {
  const start = document.getElementById('report-start').value;
  const end = document.getElementById('report-end').value;
  if (!start || !end) return alert('Isi start dan end');
  const r = await getPeriodReport(start, end);
  exportCsvOrders(r.orders, `report-period-${start}_to_${end}.csv`);
});
document.getElementById('btn-export-pdf-daily').addEventListener('click', async () => {
  const date = document.getElementById('report-date').value || new Date().toISOString().slice(0,10);
  const r = await getDailyReport(date);
  exportPdfOrders(`Laporan Harian - ${date}`, r.orders, r.summary, `report-daily-${date}.pdf`);
});
document.getElementById('btn-export-pdf-period').addEventListener('click', async () => {
  const start = document.getElementById('report-start').value;
  const end = document.getElementById('report-end').value;
  if (!start || !end) return alert('Isi start dan end');
  const r = await getPeriodReport(start, end);
  exportPdfOrders(`Laporan Periode - ${start} → ${end}`, r.orders, r.summary, `report-period-${start}_to_${end}.pdf`);
});

/* Utility */
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, function(m){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[m]; }); }

/* init */
async function main() {
  await openDb();
  await loadSettingsToUI();
  await loadCustomersToUI();
  await renderOrders();
  await refreshNotifications();
  // poll notifications
  setInterval(() => refreshNotifications(), 15000);
}
main();
