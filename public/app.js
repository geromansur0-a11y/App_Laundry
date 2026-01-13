// Simple frontend logic: customer list, create customer, create order, list orders, update status
const api = (path, opts) => fetch(path, opts).then(async r => {
  if (!r.ok) {
    const t = await r.text().catch(()=>null);
    throw new Error(t || r.statusText);
  }
  return r.json();
});

let notifPollInterval = null;

async function loadSettings() {
  const s = await api('/api/settings');
  document.getElementById('order-price').value = s.price_per_kg || 12000;
}

async function loadCustomers(q = '') {
  const url = '/api/customers' + (q ? '?q=' + encodeURIComponent(q) : '');
  const customers = await api(url);
  const sel = document.getElementById('select-customer');
  sel.innerHTML = '<option value="">Pilih pelanggan...</option>';
  customers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name + (c.phone ? ' • ' + c.phone : '');
    sel.appendChild(opt);
  });
  return customers;
}

document.getElementById('form-add-customer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  if (!name) return alert('Masukkan nama');
  try {
    const res = await api('/api/customers', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, phone })});
    document.getElementById('cust-name').value = '';
    document.getElementById('cust-phone').value = '';
    await loadCustomers();
    alert('Pelanggan ditambahkan: ' + res.name);
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

document.getElementById('form-add-order').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customer_id = document.getElementById('select-customer').value;
  const weight = parseFloat(document.getElementById('order-weight').value) || 0;
  const price_per_kg = parseFloat(document.getElementById('order-price').value) || 0;
  if (!customer_id) return alert('Pilih pelanggan');
  try {
    const res = await api('/api/orders', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ customer_id, weight, price_per_kg })});
    document.getElementById('order-weight').value = '';
    await loadOrders();
    alert('Order dibuat: #' + res.id);
    // immediately refresh notifications
    fetchNotifications();
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

document.getElementById('btn-refresh')?.addEventListener('click', () => loadOrders());

document.getElementById('btn-search').addEventListener('click', () => {
  loadOrders();
  loadCustomers(document.getElementById('search-q').value.trim());
});

async function loadOrders() {
  const q = document.getElementById('search-q').value.trim();
  const status = document.getElementById('filter-status').value;
  let url = '/api/orders';
  const params = [];
  if (q) params.push('q=' + encodeURIComponent(q));
  if (status) params.push('status=' + encodeURIComponent(status));
  if (params.length) url += '?' + params.join('&');
  const orders = await api(url);
  const container = document.getElementById('orders-list');
  container.innerHTML = '';
  if (!orders.length) {
    container.innerHTML = '<div class="text-muted">Tidak ada order.</div>';
    return;
  }
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
    // print
    card.querySelector('.btn-print').addEventListener('click', () => {
      const w = window.open('', '_blank');
      w.document.write(`<pre>Nota Laundry\nNo: ${o.id}\nPelanggan: ${o.customer_name || '-'}\nTelp: ${o.customer_phone || '-'}\nBerat: ${o.weight} kg\nHarga/kg: ${o.price_per_kg}\nTotal: Rp ${o.total}\nStatus: ${o.status}\n\nTerima kasih!</pre>`);
      w.print();
    });
    // change status
    card.querySelector('.status-select').addEventListener('change', async (e) => {
      const newStatus = e.target.value;
      if (!newStatus) return;
      await api('/api/orders/' + o.id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: newStatus })});
      loadOrders();
      fetchNotifications();
    });
    container.appendChild(card);
  });
}

/* Notifications handling */
const notifBtn = document.getElementById('btn-notif');
const notifPanel = document.getElementById('notif-panel');
const notifListEl = document.getElementById('notif-list');
const notifCountEl = document.getElementById('notif-count');

notifBtn.addEventListener('click', () => {
  notifPanel.style.display = notifPanel.style.display === 'none' ? 'block' : 'none';
  if (notifPanel.style.display === 'block') {
    // mark visible: also show list of recent notifications
    fetchNotifications(false);
  }
});

document.getElementById('btn-close-notif').addEventListener('click', () => {
  notifPanel.style.display = 'none';
});

document.getElementById('btn-mark-all-read').addEventListener('click', async () => {
  // mark all displayed as read
  const items = notifListEl.querySelectorAll('[data-id]');
  for (const it of items) {
    const id = it.getAttribute('data-id');
    await api(`/api/notifications/${id}/read`, { method: 'PUT' }).catch(()=>{});
  }
  fetchNotifications();
});

async function fetchNotifications(unreadOnly = true) {
  try {
    const url = '/api/notifications' + (unreadOnly ? '?unread=true' : '');
    const notifs = await api(url);
    // update badge
    const unreadCount = unreadOnly ? notifs.length : notifs.filter(n => n.read === 0).length;
    notifCountEl.textContent = unreadCount > 0 ? unreadCount : '';
    // if unread and permission, trigger browser notification
    if (unreadOnly && notifs.length) {
      notifs.slice(0,5).reverse().forEach(n => showBrowserNotification(n));
    }
    // if panel open or not unreadOnly, render list
    if (!unreadOnly || notifPanel.style.display === 'block') {
      renderNotifList(notifs);
    }
  } catch (err) {
    console.error('Notif error', err);
  }
}

function renderNotifList(notifs) {
  notifListEl.innerHTML = '';
  if (!notifs.length) {
    notifListEl.innerHTML = '<div class="text-muted small">Tidak ada notifikasi.</div>';
    return;
  }
  notifs.forEach(n => {
    const a = document.createElement('div');
    a.className = 'list-group-item list-group-item-action';
    a.setAttribute('data-id', n.id);
    a.innerHTML = `<div class="d-flex justify-content-between"><div>${escapeHtml(n.message)}</div><small class="text-muted">${n.created_at}</small></div>`;
    a.addEventListener('click', async () => {
      await api(`/api/notifications/${n.id}/read`, { method: 'PUT' }).catch(()=>{});
      fetchNotifications(false);
    });
    notifListEl.appendChild(a);
  });
}

// show browser notification (if granted)
function showBrowserNotification(n) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    const title = "Laundry - Notifikasi";
    const body = n.message;
    const opt = { body, tag: 'laundry-notif-' + n.id, renotify: true };
    try {
      new Notification(title, opt);
    } catch (e) {
      // ignore
    }
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then(permission => {
      if (permission === "granted") {
        showBrowserNotification(n);
      }
    });
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function(m) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[m]; });
}

/* Reports handling */
document.getElementById('btn-reports-toggle').addEventListener('click', () => {
  document.getElementById('reports-panel').style.display = 'block';
});
document.getElementById('btn-close-reports').addEventListener('click', () => {
  document.getElementById('reports-panel').style.display = 'none';
});

document.getElementById('btn-show-daily').addEventListener('click', async () => {
  const date = document.getElementById('report-date').value || new Date().toISOString().slice(0,10);
  const res = await api('/api/reports/daily?date=' + encodeURIComponent(date));
  showReportResult(res);
});

document.getElementById('btn-show-period').addEventListener('click', async () => {
  const start = document.getElementById('report-start').value;
  const end = document.getElementById('report-end').value;
  if (!start || !end) return alert('Isi start dan end');
  const res = await api(`/api/reports/period?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  showReportResult(res, true);
});

function showReportResult(res, isPeriod = false) {
  let html = '';
  if (isPeriod) {
    html += `<div><strong>Periode:</strong> ${res.start} — ${res.end}</div>`;
    html += `<div><strong>Total Order:</strong> ${res.summary.total_orders}</div>`;
    html += `<div><strong>Total Pendapatan:</strong> Rp ${res.summary.total_revenue}</div>`;
    html += `<div><strong>Total Berat:</strong> ${res.summary.total_weight} kg</div>`;
    html += '<div class="mt-2"><strong>Breakdown per status:</strong></div>';
    res.breakdown.forEach(b => {
      html += `<div>${b.status}: ${b.count} • Rp ${b.sum_total}</div>`;
    });
  } else {
    html += `<div><strong>Tanggal:</strong> ${res.date}</div>`;
    html += `<div><strong>Total Order:</strong> ${res.summary.total_orders}</div>`;
    html += `<div><strong>Total Pendapatan:</strong> Rp ${res.summary.total_revenue}</div>`;
    html += `<div><strong>Total Berat:</strong> ${res.summary.total_weight} kg</div>`;
    html += '<div class="mt-2"><strong>Breakdown per status:</strong></div>';
    res.breakdown.forEach(b => {
      html += `<div>${b.status}: ${b.count} • Rp ${b.sum_total}</div>`;
    });
  }
  document.getElementById('report-result').innerHTML = html;
}

/* Export CSV handlers */
// helper to download blob
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

document.getElementById('btn-export-daily').addEventListener('click', async () => {
  const date = document.getElementById('report-date').value || new Date().toISOString().slice(0,10);
  try {
    const r = await fetch(`/api/reports/daily.csv?date=${encodeURIComponent(date)}`);
    if (!r.ok) {
      const t = await r.text().catch(()=>r.statusText);
      return alert('Error: ' + t);
    }
    const blob = await r.blob();
    downloadBlob(blob, `report-daily-${date}.csv`);
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

document.getElementById('btn-export-period').addEventListener('click', async () => {
  const start = document.getElementById('report-start').value;
  const end = document.getElementById('report-end').value;
  if (!start || !end) return alert('Isi start dan end');
  try {
    const r = await fetch(`/api/reports/period.csv?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    if (!r.ok) {
      const t = await r.text().catch(()=>r.statusText);
      return alert('Error: ' + t);
    }
    const blob = await r.blob();
    downloadBlob(blob, `report-period-${start}_to_${end}.csv`);
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

/* Export PDF handlers (uses jsPDF + autotable included in index.html) */
function createPdfFromOrders(title, orders, summary) {
  // ensure jsPDF available
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('jsPDF tidak tersedia.');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginLeft = 40;
  let y = 40;
  doc.setFontSize(14);
  doc.text(title, marginLeft, y);
  y += 12;

  // prepare table
  const head = [['ID','Waktu','Pelanggan','Telepon','Berat (kg)','Harga/kg','Total','Status','Due','Catatan']];
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

  // use autoTable
  // start table a bit lower
  doc.autoTable({
    startY: y + 10,
    head: head,
    body: body,
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [41, 128, 185], textColor: 255 },
    margin: { left: marginLeft, right: marginLeft }
  });

  // after table, add summary
  const finalY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 10 : doc.internal.pageSize.getHeight() - 60;
  doc.setFontSize(11);
  doc.text(`Total Order: ${summary.total_orders}`, marginLeft, finalY);
  doc.text(`Total Pendapatan: Rp ${summary.total_revenue}`, marginLeft, finalY + 14);
  doc.text(`Total Berat: ${summary.total_weight} kg`, marginLeft, finalY + 28);

  return doc;
}

document.getElementById('btn-export-pdf-daily').addEventListener('click', async () => {
  const date = document.getElementById('report-date').value || new Date().toISOString().slice(0,10);
  try {
    const res = await api('/api/reports/daily?date=' + encodeURIComponent(date));
    const orders = res.orders || [];
    const summary = res.summary || { total_orders: 0, total_revenue: 0, total_weight: 0 };
    const title = `Laporan Harian - ${date}`;
    const doc = createPdfFromOrders(title, orders, summary);
    if (doc) doc.save(`report-daily-${date}.pdf`);
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

document.getElementById('btn-export-pdf-period').addEventListener('click', async () => {
  const start = document.getElementById('report-start').value;
  const end = document.getElementById('report-end').value;
  if (!start || !end) return alert('Isi start dan end');
  try {
    const res = await api(`/api/reports/period?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    const orders = res.orders || [];
    const summary = res.summary || { total_orders: 0, total_revenue: 0, total_weight: 0 };
    const title = `Laporan Periode - ${start} → ${end}`;
    const doc = createPdfFromOrders(title, orders, summary);
    if (doc) doc.save(`report-period-${start}_to_${end}.pdf`);
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

/* initialize */
async function main() {
  await loadSettings();
  await loadCustomers();
  await loadOrders();
  // start notification poll
  fetchNotifications(true);
  if (notifPollInterval) clearInterval(notifPollInterval);
  notifPollInterval = setInterval(() => fetchNotifications(true), 15000);
}

main();
