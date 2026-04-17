// app.js — Guia de Compras v5.5
// Arquitectura: listas guardam apenas referências (catId, itemIdx, qty, checked)
// Os dados do produto (name, unit, preco, bestShopId) são lidos do catálogo em runtime.
import { db } from "./firebase.js";
import { defaultCatalog, defaultSupermercados } from "./data-default.js";
import {
  collection, doc, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, onSnapshot, deleteField
} from "./firebase.js";

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
const state = {
  catalog:        {},   // { catId: { nome, items:[{name,defaultQty,unit,preco,bestShopId}] } }
  supermercados:  {},   // { shopId: { nome, cor } }
  allListas:      [],
  currentLista:   null, // raw Firestore doc { date, nome, supermercado, items:{itemKey:{catId,itemIdx,qty,checked}} }
  currentListaId: null,
  unsubLista:     null,
  unsubCatalog:   null, // realtime catalog listener while lista view is open
  pendingDelete:  null,
  addProductSel:  new Set(),
};

// ═══════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════
function todayStr() { return new Date().toISOString().split("T")[0]; }
function formatDatePT(s) {
  if (!s) return "";
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
}
function slugify(t) {
  return t.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
// Stable item key from catId + index stored in lista
function itemKey(catId, itemIdx) { return `${catId}__${itemIdx}`; }

function fmtKz(v) { return "Kz " + Math.round(v).toLocaleString("pt-AO"); }

function showToast(msg, type = "default") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = "toast"; }, 3200);
}
function openModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

// ── Resolve item data from catalog ─────────────────
// listaItem: { catId, itemIdx, qty, checked }
// Returns merged object with catalog data, or null if not found.
function resolveItem(listaItem) {
  const catData = state.catalog[listaItem.catId];
  if (!catData) return null;
  const catalogItem = catData.items[listaItem.itemIdx];
  if (!catalogItem) return null;
  const shop = listaItem.bestShopId
    ? state.supermercados[listaItem.bestShopId]
    : state.supermercados[catalogItem.bestShopId];
  return {
    ...catalogItem,
    catId:       listaItem.catId,
    itemIdx:     listaItem.itemIdx,
    qty:         listaItem.qty ?? catalogItem.defaultQty,
    checked:     listaItem.checked ?? false,
    categoria:   catData.nome,
    shopNome:    shop?.nome  || "",
    shopCor:     shop?.cor   || "#888",
    shopId:      catalogItem.bestShopId || "",
  };
}

// ── Auto name ──────────────────────────────────────
const PT_DAYS   = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];
const PT_MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
                   "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
function generateListaName(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const base = `Compras ${PT_DAYS[d.getDay()]} ${d.getDate()} de ${PT_MONTHS[d.getMonth()]}`;
  const names = state.allListas.filter(l => l.date === dateStr).map(l => l.nome);
  if (!names.includes(base)) return base;
  let n = 2;
  while (names.includes(`${base} #${n}`)) n++;
  return `${base} #${n}`;
}

// ── Shop distribution (by value) ───────────────────
const SHOP_COLORS_FALLBACK = ["#2D6A4F","#E07A5F","#C9A84C","#5B7FA6","#8E6BBF","#3D9970","#E8743B","#708090"];
function calcShopDist(selections) {
  const totals = {};
  selections.forEach(key => {
    const [catId, idxStr] = key.split("|");
    const catData = state.catalog[catId]; if (!catData) return;
    const item    = catData.items[parseInt(idxStr)]; if (!item) return;
    const shopId  = item.bestShopId || "outro";
    const shop    = state.supermercados[shopId];
    const label   = shop?.nome || shopId;
    const cor     = shop?.cor  || "#888";
    const val     = (item.preco || 0) * (item.defaultQty || 1);
    if (!totals[label]) totals[label] = { val: 0, cor };
    totals[label].val += val;
  });
  return totals; // { label: { val, cor } }
}
function topShop(dist) {
  let top = "", topVal = 0;
  Object.entries(dist).forEach(([s, d]) => { if (d.val > topVal) { top = s; topVal = d.val; } });
  return top;
}
function renderShopDist(dist) {
  const total = Object.values(dist).reduce((a, d) => a + d.val, 0);
  const el = document.getElementById("gerar-shop-dist");
  if (!total) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const sorted = Object.entries(dist).sort((a, b) => b[1].val - a[1].val);
  document.getElementById("shop-dist-bars").innerHTML = sorted.map(([, d]) => {
    const pct = (d.val / total) * 100;
    return `<div class="dist-seg" style="width:${pct}%;background:${d.cor}" title="${pct.toFixed(0)}%"></div>`;
  }).join("");
  document.getElementById("shop-dist-legend").innerHTML = sorted.map(([label, d]) => {
    const pct = (d.val / total) * 100;
    return `<div class="dist-leg-item"><span class="dist-dot" style="background:${d.cor}"></span>${label} <strong>${pct.toFixed(0)}%</strong></div>`;
  }).join("");
}

function calcBudgetFromLista(listaItems) {
  let total = 0;
  Object.values(listaItems || {}).forEach(listaItem => {
    const resolved = resolveItem(listaItem);
    if (resolved) total += (resolved.qty || 0) * (resolved.preco || 0);
  });
  return total;
}

// ═══════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════
const views = { listas:"view-listas", lista:"view-lista", gerar:"view-gerar", admin:"view-admin" };

function switchView(name, param) {
  // Stop realtime listeners
  if (state.unsubLista)   { state.unsubLista();   state.unsubLista   = null; }
  if (state.unsubCatalog) { state.unsubCatalog(); state.unsubCatalog = null; }

  Object.values(views).forEach(id => {
    document.getElementById(id).classList.add("hidden");
    document.getElementById(id).classList.remove("active");
  });
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(views[name]).classList.remove("hidden");
  document.getElementById(views[name]).classList.add("active");
  const nb = document.querySelector(`[data-view="${name}"]`);
  if (nb) nb.classList.add("active");

  if (name === "listas") initListasView();
  if (name === "lista")  initListaView(param);
  if (name === "gerar")  initGerarView();
  if (name === "admin")  initAdminView();
}

document.getElementById("brand-link").addEventListener("click", () => switchView("listas"));
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const v = btn.dataset.view;
    switchView(v === "lista" ? "listas" : v);
  });
});

// ═══════════════════════════════════════════════════
// FIRESTORE — SUPERMERCADOS
// ═══════════════════════════════════════════════════
async function loadSupermercados() {
  const snap = await getDocs(collection(db, "supermercados"));
  state.supermercados = {};
  snap.forEach(d => { state.supermercados[d.id] = d.data(); });
}
async function saveSupermercado(shopId, data) {
  await setDoc(doc(db, "supermercados", shopId), data);
}
async function deleteSupermercado(shopId) {
  await deleteDoc(doc(db, "supermercados", shopId));
}

// ═══════════════════════════════════════════════════
// FIRESTORE — CATALOG
// ═══════════════════════════════════════════════════
async function loadCatalog() {
  const snap = await getDocs(collection(db, "catalogo"));
  state.catalog = {};
  snap.forEach(d => { state.catalog[d.id] = d.data(); });
}
async function saveCategoryToFirestore(catId, data) {
  await setDoc(doc(db, "catalogo", catId), data);
}
async function deleteCategoryFromFirestore(catId) {
  await deleteDoc(doc(db, "catalogo", catId));
}

// ═══════════════════════════════════════════════════
// FIRESTORE — LISTAS
// Items stored as: { catId, itemIdx, qty, checked }
// ═══════════════════════════════════════════════════
async function loadAllListas() {
  const snap = await getDocs(collection(db, "listas"));
  state.allListas = [];
  snap.forEach(d => {
    const data = d.data();
    state.allListas.push({
      id:           d.id,
      date:         data.date         || "",
      nome:         data.nome         || "",
      supermercado: data.supermercado || "",
      itemCount:    data.items ? Object.keys(data.items).length : 0,
    });
  });
  state.allListas.sort((a, b) => b.date.localeCompare(a.date));
}

function subscribeToLista(listaId, cb) {
  if (state.unsubLista) { state.unsubLista(); state.unsubLista = null; }
  state.unsubLista = onSnapshot(doc(db, "listas", listaId), snap => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

// Subscribe to catalog changes so lista view auto-updates when products edited
function subscribeToCatalog(cb) {
  if (state.unsubCatalog) { state.unsubCatalog(); state.unsubCatalog = null; }
  state.unsubCatalog = onSnapshot(collection(db, "catalogo"), snap => {
    state.catalog = {};
    snap.forEach(d => { state.catalog[d.id] = d.data(); });
    cb();
  });
}

async function updateListaItemFields(listaId, key, fields) {
  const upd = {};
  Object.entries(fields).forEach(([k, v]) => { upd[`items.${key}.${k}`] = v; });
  await updateDoc(doc(db, "listas", listaId), upd);
}
async function removeListaItemKey(listaId, key) {
  const upd = {}; upd[`items.${key}`] = deleteField();
  await updateDoc(doc(db, "listas", listaId), upd);
}
async function saveNewLista(listaDoc) {
  const id = crypto.randomUUID();
  await setDoc(doc(db, "listas", id), listaDoc);
  return id;
}
async function deleteListaById(id) { await deleteDoc(doc(db, "listas", id)); }

// ═══════════════════════════════════════════════════
// SEED
// ═══════════════════════════════════════════════════
async function seedCatalog() {
  const btn = document.getElementById("btn-seed");
  btn.disabled = true; btn.textContent = "A carregar…";
  try {
    for (const [catName, items] of Object.entries(defaultCatalog)) {
      await saveCategoryToFirestore(slugify(catName), { nome: catName, items });
    }
    await loadCatalog(); renderAdminCatalog(); populateCategorySelects();
    showToast("Catálogo carregado!", "success");
  } catch (e) { console.error(e); showToast("Erro ao carregar.", "error"); }
  finally { btn.disabled = false; btn.textContent = "🌱 Seed Padrão"; }
}
async function seedSupermercados() {
  const btn = document.getElementById("btn-seed-shops");
  btn.disabled = true; btn.textContent = "A carregar…";
  try {
    for (const shop of defaultSupermercados) {
      await saveSupermercado(shop.id, { nome: shop.nome, cor: shop.cor });
    }
    await loadSupermercados(); renderAdminShops(); populateShopSelects();
    showToast("Supermercados carregados!", "success");
  } catch (e) { console.error(e); showToast("Erro.", "error"); }
  finally { btn.disabled = false; btn.textContent = "🌱 Seed Supermercados"; }
}

// ═══════════════════════════════════════════════════
// SHARED SELECTS
// ═══════════════════════════════════════════════════
function populateCategorySelects() {
  const cats = Object.entries(state.catalog).sort((a, b) => a[1].nome.localeCompare(b[1].nome));
  ["admin-cat-filter", "gerar-cat-filter"].forEach(id => {
    const sel = document.getElementById(id), val = sel.value;
    sel.innerHTML = '<option value="">Todas as categorias</option>' +
      cats.map(([id, c]) => `<option value="${id}">${c.nome}</option>`).join("");
    sel.value = val;
  });
  document.getElementById("item-cat-input").innerHTML =
    cats.map(([id, c]) => `<option value="${id}">${c.nome}</option>`).join("");
  document.getElementById("add-product-cat").innerHTML =
    '<option value="">Todas as categorias</option>' +
    cats.map(([id, c]) => `<option value="${id}">${c.nome}</option>`).join("");
}

function populateShopSelects() {
  const shops = Object.entries(state.supermercados).sort((a, b) => a[1].nome.localeCompare(b[1].nome));
  // Item modal shop select
  const itemShopSel = document.getElementById("item-shop-input");
  const itemShopVal = itemShopSel.value;
  itemShopSel.innerHTML = '<option value="">— Nenhum —</option>' +
    shops.map(([id, s]) => `<option value="${id}">${s.nome}</option>`).join("");
  itemShopSel.value = itemShopVal;

  // Gerar shop filter
  const gerarShopSel = document.getElementById("gerar-shop-filter");
  const gerarShopVal = gerarShopSel.value;
  gerarShopSel.innerHTML = '<option value="">Todos os supermercados</option>' +
    shops.map(([id, s]) => `<option value="${id}">${s.nome}</option>`).join("");
  gerarShopSel.value = gerarShopVal;

  // Lista shop filter
  const listaShopSel = document.getElementById("lista-shop-filter");
  const listaShopVal = listaShopSel.value;
  listaShopSel.innerHTML = '<option value="">Todos os supermercados</option>' +
    shops.map(([id, s]) => `<option value="${id}">${s.nome}</option>`).join("");
  listaShopSel.value = listaShopVal;
}

// ═══════════════════════════════════════════════════
// VIEW: LISTAGEM
// ═══════════════════════════════════════════════════
async function initListasView() {
  await Promise.all([loadAllListas(), loadCatalog(), loadSupermercados()]);
  renderListasGrid();
}

function renderListasGrid() {
  const container = document.getElementById("listas-grid");
  container.innerHTML = "";
  if (!state.allListas.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🗒️</div>
      <p>Nenhuma lista ainda.</p><small>Use "Gerar" para criar a primeira lista.</small></div>`;
    return;
  }
  const byDate = {};
  state.allListas.forEach(l => { if (!byDate[l.date]) byDate[l.date] = []; byDate[l.date].push(l); });
  Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).forEach(([date, listas]) => {
    const group = document.createElement("div"); group.className = "listas-date-group";
    group.innerHTML = `<div class="listas-date-label">📅 ${formatDatePT(date)}</div>`;
    listas.forEach(lista => {
      const card = document.createElement("div"); card.className = "lista-card";
      card.innerHTML = `
        <div class="lista-card-body" data-id="${lista.id}">
          <div class="lista-card-top">
            <span class="lista-card-nome">${lista.nome || "Lista sem nome"}</span>
            ${lista.supermercado ? `<span class="lista-card-shop">🛍️ ${lista.supermercado}</span>` : ""}
          </div>
          <div class="lista-card-meta">${lista.itemCount} produtos</div>
        </div>
        <div class="lista-card-actions">
          <button class="btn-icon" title="Partilhar" data-action="share"       data-id="${lista.id}">🔗</button>
          <button class="btn-icon" title="Editar"    data-action="edit-lista"   data-id="${lista.id}">✏️</button>
          <button class="btn-icon danger" title="Apagar" data-action="delete-lista" data-id="${lista.id}">🗑️</button>
        </div>`;
      card.querySelector(".lista-card-body").addEventListener("click", () => switchView("lista", lista.id));
      card.querySelectorAll("[data-action]").forEach(btn => {
        btn.addEventListener("click", e => { e.stopPropagation(); handleListaCardAction(btn.dataset.action, btn.dataset.id); });
      });
      group.appendChild(card);
    });
    container.appendChild(group);
  });
}

function shareUrl(listaId) {
  return location.href.replace(/index\.html.*$/, "").replace(/\?.*$/, "") + `viewer.html?lista=${listaId}`;
}

function handleListaCardAction(action, listaId) {
  if (action === "share") {
    navigator.clipboard.writeText(shareUrl(listaId))
      .then(() => showToast("Link copiado!", "success"))
      .catch(() => prompt("Copia este link:", shareUrl(listaId)));
  }
  if (action === "edit-lista")   openEditListaModal(listaId);
  if (action === "delete-lista") confirmDeleteLista(listaId);
}

async function openEditListaModal(listaId) {
  const lista = state.allListas.find(l => l.id === listaId); if (!lista) return;
  document.getElementById("edit-lista-id").value   = listaId;
  document.getElementById("edit-lista-nome").value = lista.nome || "";
  document.getElementById("edit-lista-date").value = lista.date || "";
  document.getElementById("edit-lista-shop").value = lista.supermercado || "";
  openModal("modal-edit-lista");
}
document.getElementById("btn-save-edit-lista").addEventListener("click", async () => {
  const id   = document.getElementById("edit-lista-id").value;
  const nome = document.getElementById("edit-lista-nome").value.trim();
  const date = document.getElementById("edit-lista-date").value;
  const shop = document.getElementById("edit-lista-shop").value.trim();
  if (!nome) return showToast("Insira um nome.", "error");
  if (!date) return showToast("Seleccione uma data.", "error");
  try {
    await updateDoc(doc(db, "listas", id), { nome, date, supermercado: shop });
    closeModal("modal-edit-lista"); showToast("Lista actualizada!", "success");
    await loadAllListas(); renderListasGrid();
  } catch (e) { console.error(e); showToast("Erro.", "error"); }
});

function confirmDeleteLista(listaId) {
  const lista = state.allListas.find(l => l.id === listaId);
  state.pendingDelete = { type: "lista", id: listaId };
  document.getElementById("confirm-message").textContent =
    `Apagar a lista "${lista?.nome || formatDatePT(lista?.date)}"? Esta acção não pode ser desfeita.`;
  openModal("modal-confirm");
}

// ═══════════════════════════════════════════════════
// VIEW: LISTA DETALHE (realtime catalog + lista)
// ═══════════════════════════════════════════════════
async function initListaView(listaId) {
  if (!listaId) { switchView("listas"); return; }
  state.currentListaId = listaId;
  state.currentLista   = null;

  document.getElementById("lista-loading").classList.remove("hidden");
  document.getElementById("lista-empty").classList.add("hidden");
  document.getElementById("lista-content").classList.add("hidden");
  document.getElementById("lista-summary").classList.add("hidden");
  document.getElementById("lista-budget").classList.add("hidden");
  document.getElementById("lista-search").value = "";
  document.getElementById("lista-shop-filter").value = "";

  // Load shops once (they rarely change)
  await loadSupermercados();
  populateShopSelects();

  // Subscribe to catalog changes → re-render lista
  subscribeToCatalog(() => {
    populateCategorySelects();
    populateShopSelects();
    if (state.currentLista) renderLista(state.currentLista);
  });

  // Subscribe to lista changes
  subscribeToLista(listaId, listaData => {
    document.getElementById("lista-loading").classList.add("hidden");
    if (!listaData) {
      document.getElementById("lista-empty").classList.remove("hidden");
      return;
    }
    state.currentLista = listaData;
    document.getElementById("lista-view-title").textContent = listaData.nome || formatDatePT(listaData.date);
    document.getElementById("lista-view-date").textContent  = formatDatePT(listaData.date);
    document.getElementById("lista-view-shop").textContent  = listaData.supermercado ? `🛍️ ${listaData.supermercado}` : "";
    renderLista(listaData);
  });
}

function getListaFilters() {
  return {
    search: document.getElementById("lista-search").value.toLowerCase().trim(),
    shopId: document.getElementById("lista-shop-filter").value,
    sort:   document.getElementById("lista-sort").value,
  };
}

function renderLista(listaData) {
  const { search, shopId, sort } = getListaFilters();
  const container = document.getElementById("lista-content");
  container.innerHTML = "";

  const rawItems = listaData?.items || {};
  if (!Object.keys(rawItems).length) {
    document.getElementById("lista-empty").classList.remove("hidden");
    container.classList.add("hidden");
    document.getElementById("lista-budget").classList.add("hidden");
    return;
  }

  document.getElementById("lista-empty").classList.add("hidden");
  container.classList.remove("hidden");
  document.getElementById("lista-summary").classList.remove("hidden");
  document.getElementById("lista-budget").classList.remove("hidden");

  // Resolve all items from catalog
  const resolved = [];
  Object.entries(rawItems).forEach(([key, listaItem]) => {
    // Support legacy items (had name/unit/preco copied)
    let r;
    if (listaItem.catId !== undefined && listaItem.itemIdx !== undefined) {
      r = resolveItem(listaItem);
      if (r) r._key = key;
    } else {
      // Legacy fallback: use stored data directly
      r = { ...listaItem, _key: key, categoria: listaItem.categoria || "Sem categoria",
             shopNome: listaItem.bestShop || "", shopCor: "#888", shopId: "" };
    }
    if (!r) return;

    // Filter
    const matchSearch = !search || r.name.toLowerCase().includes(search);
    const matchShop   = !shopId || r.shopId === shopId;
    if (matchSearch && matchShop) resolved.push(r);
  });

  // Budget (all items, not just filtered)
  const budgetVal = calcBudgetFromLista(rawItems);
  document.getElementById("budget-total").textContent = fmtKz(budgetVal);

  // Group
  const byGroup = {};
  resolved.forEach(r => {
    const key = sort === "supermercado" ? (r.shopNome || "Sem supermercado") : (r.categoria || "Sem categoria");
    if (!byGroup[key]) byGroup[key] = [];
    byGroup[key].push(r);
  });

  Object.entries(byGroup).sort((a, b) => a[0].localeCompare(b[0])).forEach(([groupName, items]) => {
    const group = document.createElement("div"); group.className = "lista-category-group";
    const checked = items.filter(i => i.checked).length;
    group.innerHTML = `<div class="lista-cat-header">
      <h3>${groupName}</h3>
      <span class="cat-badge">${checked}/${items.length}</span>
    </div>`;

    items.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
      const row = document.createElement("div");
      row.className = `lista-item${item.checked ? " checked" : ""}`;
      const lineTotal = (item.qty || 0) * (item.preco || 0);
      const shopDot   = item.shopCor ? `<span class="shop-dot" style="background:${item.shopCor}"></span>` : "";
      row.innerHTML = `
        <input type="checkbox" class="item-checkbox" ${item.checked ? "checked" : ""}/>
        <div class="item-info">
          <span class="item-name">${item.name}</span>
          ${item.shopNome ? `<span class="item-shop-tag">${shopDot}${item.shopNome}</span>` : ""}
        </div>
        <div class="item-qty-wrap">
          <input type="number" class="item-qty-input" value="${item.qty ?? item.defaultQty}" min="0" step="0.1"/>
          <span class="item-unit">${item.unit}</span>
        </div>
        ${item.preco ? `<span class="item-line-total">${fmtKz(lineTotal)}</span>` : ""}
        <button class="btn-icon btn-remove-item danger" title="Remover" data-key="${item._key}">✕</button>`;

      const cb = row.querySelector(".item-checkbox");
      cb.addEventListener("change", async () => {
        row.classList.toggle("checked", cb.checked);
        await updateListaItemFields(listaData.id, item._key, { checked: cb.checked });
      });

      const qi = row.querySelector(".item-qty-input");
      let timer;
      qi.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const qty = parseFloat(qi.value) || 0;
          await updateListaItemFields(listaData.id, item._key, { qty });
          const lt = row.querySelector(".item-line-total");
          if (lt) lt.textContent = fmtKz(qty * (item.preco || 0));
        }, 500);
      });

      row.querySelector(".btn-remove-item").addEventListener("click", async () => {
        if (!confirm(`Remover "${item.name}" da lista?`)) return;
        await removeListaItemKey(listaData.id, item._key);
      });

      group.appendChild(row);
    });
    container.appendChild(group);
  });

  updateListaSummary(rawItems);
}

function updateListaSummary(rawItems) {
  const all = Object.values(rawItems);
  const checked = all.filter(i => i.checked).length, total = all.length;
  document.getElementById("summary-checked").textContent = checked;
  document.getElementById("summary-total").textContent   = total;
  document.getElementById("progress-fill").style.width   = `${total ? (checked / total) * 100 : 0}%`;
}

// Lista filters
document.getElementById("lista-search").addEventListener("input",      () => { if (state.currentLista) renderLista(state.currentLista); });
document.getElementById("lista-shop-filter").addEventListener("change", () => { if (state.currentLista) renderLista(state.currentLista); });
document.getElementById("lista-sort").addEventListener("change",        () => { if (state.currentLista) renderLista(state.currentLista); });
document.getElementById("btn-back-listas").addEventListener("click",    () => switchView("listas"));
document.getElementById("btn-share-lista").addEventListener("click", () => {
  if (!state.currentListaId) return;
  navigator.clipboard.writeText(shareUrl(state.currentListaId))
    .then(() => showToast("Link copiado!", "success"))
    .catch(() => prompt("Copia:", shareUrl(state.currentListaId)));
});

// ── Add product to existing lista ───────────────────
document.getElementById("btn-add-to-lista").addEventListener("click", () => {
  state.addProductSel.clear();
  document.getElementById("add-product-search").value = "";
  document.getElementById("add-product-cat").value    = "";
  renderAddProductList();
  openModal("modal-add-to-lista");
});

function renderAddProductList() {
  const search = document.getElementById("add-product-search").value.toLowerCase().trim();
  const cat    = document.getElementById("add-product-cat").value;
  const container = document.getElementById("add-product-list");
  container.innerHTML = "";

  // Keys already in lista
  const existingKeys = new Set(
    state.currentLista ? Object.keys(state.currentLista.items || {}) : []
  );

  const cats = Object.entries(state.catalog)
    .filter(([id]) => !cat || id === cat)
    .sort((a, b) => a[1].nome.localeCompare(b[1].nome));

  cats.forEach(([catId, catData]) => {
    const items = catData.items
      .map((item, i) => ({ item, i }))
      .filter(({ i }) => {
        const key = itemKey(catId, i);
        return !existingKeys.has(key) && (!search || catData.items[i].name.toLowerCase().includes(search));
      });
    if (!items.length) return;

    const groupEl = document.createElement("div"); groupEl.className = "add-product-group";
    groupEl.innerHTML = `<div class="add-product-cat-label">${catData.nome}</div>`;
    items.forEach(({ item, i }) => {
      const key   = `${catId}|${i}`;
      const isSel = state.addProductSel.has(key);
      const shop  = state.supermercados[item.bestShopId];
      const row   = document.createElement("div");
      row.className = `add-product-row${isSel ? " selected" : ""}`;
      row.innerHTML = `
        <input type="checkbox" ${isSel ? "checked" : ""} data-key="${key}"/>
        <div class="add-product-info">
          <span class="add-product-name">${item.name}</span>
          <span class="add-product-meta">
            ${item.defaultQty} ${item.unit}
            ${shop    ? `· <span style="color:${shop.cor};font-weight:600">${shop.nome}</span>` : ""}
            ${item.preco ? `· ${fmtKz(item.preco)}` : ""}
          </span>
        </div>`;
      const cb = row.querySelector("input");
      const toggle = () => {
        if (cb.checked) { state.addProductSel.add(key); row.classList.add("selected"); }
        else            { state.addProductSel.delete(key); row.classList.remove("selected"); }
      };
      cb.addEventListener("change", toggle);
      row.addEventListener("click", e => { if (e.target !== cb) { cb.checked = !cb.checked; toggle(); } });
      groupEl.appendChild(row);
    });
    container.appendChild(groupEl);
  });

  if (!container.children.length) {
    container.innerHTML = `<div class="empty-state" style="padding:30px 0"><p>Sem produtos disponíveis.</p></div>`;
  }
}

document.getElementById("add-product-search").addEventListener("input",  renderAddProductList);
document.getElementById("add-product-cat").addEventListener("change",     renderAddProductList);

document.getElementById("btn-confirm-add-products").addEventListener("click", async () => {
  if (!state.addProductSel.size) return showToast("Seleccione pelo menos um produto.", "error");
  if (!state.currentListaId)    return;
  const upd = {};
  state.addProductSel.forEach(key => {
    const [catId, idxStr] = key.split("|");
    const idx = parseInt(idxStr);
    const catData = state.catalog[catId]; if (!catData) return;
    const item    = catData.items[idx];   if (!item)    return;
    const k = itemKey(catId, idx);
    upd[`items.${k}`] = { catId, itemIdx: idx, qty: item.defaultQty, checked: false };
  });
  try {
    await updateDoc(doc(db, "listas", state.currentListaId), upd);
    closeModal("modal-add-to-lista");
    showToast(`${state.addProductSel.size} produto(s) adicionado(s)!`, "success");
    state.addProductSel.clear();
  } catch (e) { console.error(e); showToast("Erro ao adicionar.", "error"); }
});

// ═══════════════════════════════════════════════════
// VIEW: GERAR
// ═══════════════════════════════════════════════════
let gerarSelections = new Set(); // "catId|itemIdx"

async function initGerarView() {
  await Promise.all([loadCatalog(), loadSupermercados()]);
  populateCategorySelects(); populateShopSelects();
  gerarSelections.clear(); updateGerarCount(); updateGerarBudget();
  const input = document.getElementById("gerar-date");
  input.value = todayStr(); input.min = todayStr();
  document.getElementById("gerar-nome").value = "";
  document.getElementById("gerar-supermercado").value = "";
  document.getElementById("gerar-shop-dist").classList.add("hidden");
  document.getElementById("gerar-budget-preview").classList.add("hidden");
  renderGerarCatalog();
}

function getGerarFilters() {
  return {
    search: document.getElementById("gerar-search").value.toLowerCase().trim(),
    cat:    document.getElementById("gerar-cat-filter").value,
    shopId: document.getElementById("gerar-shop-filter").value,
  };
}

function renderGerarCatalog() {
  const { search, cat, shopId } = getGerarFilters();
  const container = document.getElementById("gerar-catalog");
  container.innerHTML = "";
  const cats = Object.entries(state.catalog)
    .filter(([id]) => !cat || id === cat)
    .sort((a, b) => a[1].nome.localeCompare(b[1].nome));

  if (!cats.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><p>Nenhum produto.</p></div>`;
    return;
  }

  cats.forEach(([catId, catData]) => {
    const filteredItems = catData.items.map((item, i) => ({ item, i }))
      .filter(({ item }) =>
        (!search || item.name.toLowerCase().includes(search)) &&
        (!shopId || item.bestShopId === shopId)
      );
    if (!filteredItems.length) return;

    const group  = document.createElement("div"); group.className = "gerar-cat-group";
    const header = document.createElement("div"); header.className = "gerar-cat-header";
    header.innerHTML = `<h3>${catData.nome}</h3><span class="gerar-cat-toggle">▾</span>`;
    const grid = document.createElement("div"); grid.className = "gerar-items-grid";
    header.addEventListener("click", () => {
      header.classList.toggle("collapsed");
      grid.style.display = header.classList.contains("collapsed") ? "none" : "grid";
    });
    group.appendChild(header);

    filteredItems.forEach(({ item, i }) => {
      const key   = `${catId}|${i}`;
      const isSel = gerarSelections.has(key);
      const shop  = state.supermercados[item.bestShopId];
      const el    = document.createElement("div");
      el.className = `gerar-item${isSel ? " selected" : ""}`;
      el.innerHTML = `
        <input type="checkbox" ${isSel ? "checked" : ""} data-key="${key}"/>
        <div class="gerar-item-info">
          <div class="gerar-item-name">${item.name}</div>
          <div class="gerar-item-meta">
            ${item.defaultQty} ${item.unit}
            ${shop ? `· <span class="shop-pill" style="background:${shop.cor}20;color:${shop.cor};border:1px solid ${shop.cor}40">${shop.nome}</span>` : ""}
            ${item.preco ? `· <span class="price-pill">${fmtKz(item.preco)}</span>` : ""}
          </div>
        </div>`;
      const cb = el.querySelector("input");
      const toggle = () => {
        if (cb.checked) { gerarSelections.add(key); el.classList.add("selected"); }
        else            { gerarSelections.delete(key); el.classList.remove("selected"); }
        updateGerarCount(); updateGerarBudget(); updateShopSuggestion();
      };
      cb.addEventListener("change", toggle);
      el.addEventListener("click", e => { if (e.target !== cb) { cb.checked = !cb.checked; toggle(); } });
      grid.appendChild(el);
    });
    group.appendChild(grid); container.appendChild(group);
  });
  updateSelectAllState();
}

function updateGerarCount() {
  const n = gerarSelections.size;
  document.getElementById("gerar-count").textContent = `${n} produto${n !== 1 ? "s" : ""} seleccionado${n !== 1 ? "s" : ""}`;
  document.getElementById("btn-create-list").disabled = n === 0;
}

function updateGerarBudget() {
  const preview = document.getElementById("gerar-budget-preview");
  if (!gerarSelections.size) { preview.classList.add("hidden"); return; }
  let total = 0;
  gerarSelections.forEach(key => {
    const [catId, idxStr] = key.split("|");
    const item = state.catalog[catId]?.items[parseInt(idxStr)];
    if (item) total += (item.preco || 0) * (item.defaultQty || 1);
  });
  document.getElementById("gerar-budget-total").textContent = fmtKz(total);
  preview.classList.remove("hidden");
}

function updateShopSuggestion() {
  const dist = calcShopDist(gerarSelections);
  const top  = topShop(dist);
  document.getElementById("gerar-supermercado").value = top;
  renderShopDist(dist);
}

function updateSelectAllState() {
  const cbs = document.querySelectorAll("#gerar-catalog input[type=checkbox]");
  document.getElementById("gerar-select-all").checked =
    cbs.length > 0 && [...cbs].every(cb => cb.checked);
}

document.getElementById("gerar-select-all").addEventListener("change", e => {
  const checked = e.target.checked;
  document.querySelectorAll("#gerar-catalog input[type=checkbox]").forEach(cb => {
    const key = cb.dataset.key; cb.checked = checked;
    const el  = cb.closest(".gerar-item");
    if (checked) { gerarSelections.add(key); el?.classList.add("selected"); }
    else         { gerarSelections.delete(key); el?.classList.remove("selected"); }
  });
  updateGerarCount(); updateGerarBudget(); updateShopSuggestion();
});
document.getElementById("gerar-search").addEventListener("input",      renderGerarCatalog);
document.getElementById("gerar-cat-filter").addEventListener("change",  renderGerarCatalog);
document.getElementById("gerar-shop-filter").addEventListener("change", renderGerarCatalog);
document.getElementById("gerar-date").addEventListener("change", e => {
  if (e.target.value < todayStr()) { e.target.value = todayStr(); showToast("Não pode seleccionar data passada.", "error"); }
});

document.getElementById("btn-create-list").addEventListener("click", async () => {
  const dateStr = document.getElementById("gerar-date").value;
  let   nome    = document.getElementById("gerar-nome").value.trim();
  const superM  = document.getElementById("gerar-supermercado").value.trim();
  if (!dateStr)             return showToast("Seleccione uma data.", "error");
  if (!gerarSelections.size) return showToast("Seleccione pelo menos um produto.", "error");
  if (!nome) { await loadAllListas(); nome = generateListaName(dateStr); }

  const btn = document.getElementById("btn-create-list");
  btn.disabled = true; btn.querySelector("span").textContent = "A criar…";
  try {
    const items = {};
    gerarSelections.forEach(key => {
      const [catId, idxStr] = key.split("|");
      const idx = parseInt(idxStr);
      const catData = state.catalog[catId]; if (!catData) return;
      const item    = catData.items[idx];   if (!item)    return;
      const k = itemKey(catId, idx);
      // Store only reference + user data, NO product data copy
      items[k] = { catId, itemIdx: idx, qty: item.defaultQty, checked: false };
    });
    const listaId = await saveNewLista({ date: dateStr, nome, supermercado: superM, items });
    showToast(`Lista "${nome}" criada!`, "success");
    setTimeout(() => switchView("lista", listaId), 700);
  } catch (e) {
    console.error(e); showToast("Erro ao criar lista.", "error");
    btn.disabled = false; btn.querySelector("span").textContent = "Criar Lista";
  }
});

// ═══════════════════════════════════════════════════
// VIEW: ADMIN — TABS
// ═══════════════════════════════════════════════════
async function initAdminView() {
  await Promise.all([loadCatalog(), loadSupermercados()]);
  populateCategorySelects(); populateShopSelects();
  renderAdminCatalog(); renderAdminShops();
}

document.querySelectorAll(".admin-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".admin-tab-panel").forEach(p => p.classList.add("hidden"));
    tab.classList.add("active");
    document.getElementById(`admin-tab-${tab.dataset.tab}`).classList.remove("hidden");
  });
});

// ── ADMIN: SUPERMERCADOS ────────────────────────────
function renderAdminShops() {
  const container = document.getElementById("admin-shops-list");
  container.innerHTML = "";
  const shops = Object.entries(state.supermercados).sort((a, b) => a[1].nome.localeCompare(b[1].nome));
  if (!shops.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏪</div>
      <p>Nenhum supermercado.</p><small>Use "Seed Supermercados" para começar.</small></div>`;
    return;
  }
  shops.forEach(([shopId, shop]) => {
    const row = document.createElement("div"); row.className = "shop-admin-row";
    row.innerHTML = `
      <span class="shop-color-swatch" style="background:${shop.cor}"></span>
      <span class="shop-admin-nome">${shop.nome}</span>
      <span class="shop-admin-id">${shopId}</span>
      <div class="admin-item-actions" style="opacity:1">
        <button class="btn-icon" data-action="edit-shop"   data-id="${shopId}">✏️</button>
        <button class="btn-icon danger" data-action="delete-shop" data-id="${shopId}">🗑️</button>
      </div>`;
    row.querySelectorAll("[data-action]").forEach(btn => btn.addEventListener("click", handleShopAction));
    container.appendChild(row);
  });
}

function handleShopAction(e) {
  const action = e.currentTarget.dataset.action;
  const shopId = e.currentTarget.dataset.id;
  if (action === "edit-shop")   openEditShopModal(shopId);
  if (action === "delete-shop") confirmDeleteShop(shopId);
}

document.getElementById("btn-add-shop").addEventListener("click", () => {
  document.getElementById("modal-shop-title").textContent = "Novo Supermercado";
  document.getElementById("shop-name-input").value  = "";
  document.getElementById("shop-color-input").value = "#2D6A4F";
  document.getElementById("shop-id-input").value    = "";
  openModal("modal-shop");
});

function openEditShopModal(shopId) {
  const shop = state.supermercados[shopId];
  document.getElementById("modal-shop-title").textContent = "Editar Supermercado";
  document.getElementById("shop-name-input").value  = shop.nome;
  document.getElementById("shop-color-input").value = shop.cor;
  document.getElementById("shop-id-input").value    = shopId;
  openModal("modal-shop");
}

document.getElementById("btn-save-shop").addEventListener("click", async () => {
  const nome  = document.getElementById("shop-name-input").value.trim();
  const cor   = document.getElementById("shop-color-input").value;
  const oldId = document.getElementById("shop-id-input").value;
  if (!nome) return showToast("Insira o nome.", "error");
  const newId = slugify(nome);
  try {
    if (oldId && oldId !== newId) {
      await saveSupermercado(newId, { nome, cor });
      await deleteSupermercado(oldId);
    } else {
      await saveSupermercado(newId, { nome, cor });
    }
    await loadSupermercados(); renderAdminShops(); populateShopSelects();
    closeModal("modal-shop"); showToast("Supermercado guardado!", "success");
  } catch (e) { console.error(e); showToast("Erro.", "error"); }
});

function confirmDeleteShop(shopId) {
  state.pendingDelete = { type: "shop", id: shopId };
  document.getElementById("confirm-message").textContent =
    `Eliminar o supermercado "${state.supermercados[shopId]?.nome}"?`;
  openModal("modal-confirm");
}

document.getElementById("btn-seed-shops").addEventListener("click", seedSupermercados);

// ── ADMIN: CATÁLOGO ────────────────────────────────
function getAdminFilters() {
  return {
    search: document.getElementById("admin-search").value.toLowerCase().trim(),
    cat:    document.getElementById("admin-cat-filter").value,
  };
}

function renderAdminCatalog() {
  const { search, cat } = getAdminFilters();
  const container = document.getElementById("admin-catalog");
  container.innerHTML = "";
  const cats = Object.entries(state.catalog)
    .filter(([id]) => !cat || id === cat)
    .sort((a, b) => a[1].nome.localeCompare(b[1].nome));

  if (!cats.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div>
      <p>Nenhuma categoria.</p><small>Use "Seed Padrão".</small></div>`;
    return;
  }

  cats.forEach(([catId, catData]) => {
    const filteredItems = catData.items.filter(it => !search || it.name.toLowerCase().includes(search));
    if (search && !filteredItems.length) return;
    const card = document.createElement("div"); card.className = "admin-cat-card";
    card.innerHTML = `
      <div class="admin-cat-header">
        <h3>${catData.nome}</h3>
        <div class="admin-cat-actions">
          <button class="btn-icon" data-action="edit-cat"   data-cat="${catId}">✏️</button>
          <button class="btn-icon danger" data-action="delete-cat" data-cat="${catId}">🗑️</button>
        </div>
      </div>
      <div class="admin-items-list">
        ${filteredItems.map(item => {
          const realIdx = catData.items.indexOf(item);
          const shop    = state.supermercados[item.bestShopId];
          return `<div class="admin-item-row">
            <span class="admin-item-name">${item.name}</span>
            <span class="admin-item-meta">${item.defaultQty} ${item.unit}</span>
            ${item.preco ? `<span class="price-pill">${fmtKz(item.preco)}</span>` : ""}
            ${shop ? `<span class="shop-pill" style="background:${shop.cor}20;color:${shop.cor};border:1px solid ${shop.cor}40">${shop.nome}</span>` : ""}
            <div class="admin-item-actions">
              <button class="btn-icon" data-action="edit-item"   data-cat="${catId}" data-idx="${realIdx}">✏️</button>
              <button class="btn-icon danger" data-action="delete-item" data-cat="${catId}" data-idx="${realIdx}">🗑️</button>
            </div>
          </div>`;
        }).join("")}
      </div>
      <div class="admin-add-item">
        <button class="btn-add-item" data-action="add-item" data-cat="${catId}">+ Adicionar produto</button>
      </div>`;
    container.appendChild(card);
  });
  container.querySelectorAll("[data-action]").forEach(el => el.addEventListener("click", handleAdminAction));
}

function handleAdminAction(e) {
  const el = e.currentTarget, action = el.dataset.action, catId = el.dataset.cat;
  const idx = el.dataset.idx !== undefined ? parseInt(el.dataset.idx) : null;
  if (action === "edit-cat")    openEditCategoryModal(catId);
  if (action === "delete-cat")  confirmDeleteCat(catId);
  if (action === "add-item")    openAddItemModal(catId);
  if (action === "edit-item")   openEditItemModal(catId, idx);
  if (action === "delete-item") confirmDeleteItem(catId, idx);
}

document.getElementById("btn-add-category").addEventListener("click", () => {
  document.getElementById("modal-cat-title").textContent = "Nova Categoria";
  document.getElementById("cat-name-input").value = "";
  document.getElementById("cat-id-input").value   = "";
  openModal("modal-category");
});
function openEditCategoryModal(catId) {
  document.getElementById("modal-cat-title").textContent = "Editar Categoria";
  document.getElementById("cat-name-input").value = state.catalog[catId].nome;
  document.getElementById("cat-id-input").value   = catId;
  openModal("modal-category");
}
document.getElementById("btn-save-category").addEventListener("click", async () => {
  const name = document.getElementById("cat-name-input").value.trim();
  const oldId = document.getElementById("cat-id-input").value;
  if (!name) return showToast("Insira o nome.", "error");
  const newId = slugify(name);
  try {
    if (oldId && oldId !== newId) {
      await saveCategoryToFirestore(newId, { ...state.catalog[oldId], nome: name });
      await deleteCategoryFromFirestore(oldId);
    } else {
      await saveCategoryToFirestore(newId, { ...(state.catalog[oldId] || { items: [] }), nome: name });
    }
    await loadCatalog(); populateCategorySelects(); renderAdminCatalog();
    closeModal("modal-category"); showToast("Categoria guardada!", "success");
  } catch (e) { console.error(e); showToast("Erro.", "error"); }
});

function openAddItemModal(catId) {
  document.getElementById("modal-item-title").textContent = "Novo Produto";
  document.getElementById("item-name-input").value   = "";
  document.getElementById("item-qty-input").value    = "1";
  document.getElementById("item-unit-input").value   = "un";
  document.getElementById("item-preco-input").value  = "0";
  document.getElementById("item-shop-input").value   = "";
  document.getElementById("item-cat-input").value    = catId;
  document.getElementById("item-id-input").value     = "";
  document.getElementById("item-original-cat-input").value = catId;
  openModal("modal-item");
}
function openEditItemModal(catId, idx) {
  const item = state.catalog[catId].items[idx];
  document.getElementById("modal-item-title").textContent = "Editar Produto";
  document.getElementById("item-name-input").value   = item.name;
  document.getElementById("item-qty-input").value    = item.defaultQty;
  document.getElementById("item-unit-input").value   = item.unit;
  document.getElementById("item-preco-input").value  = item.preco || 0;
  document.getElementById("item-shop-input").value   = item.bestShopId || "";
  document.getElementById("item-cat-input").value    = catId;
  document.getElementById("item-id-input").value     = idx;
  document.getElementById("item-original-cat-input").value = catId;
  openModal("modal-item");
}
document.getElementById("btn-save-item").addEventListener("click", async () => {
  const name     = document.getElementById("item-name-input").value.trim();
  const qty      = parseFloat(document.getElementById("item-qty-input").value)  || 1;
  const unit     = document.getElementById("item-unit-input").value;
  const preco    = parseFloat(document.getElementById("item-preco-input").value) || 0;
  const bestShopId = document.getElementById("item-shop-input").value;
  const catId    = document.getElementById("item-cat-input").value;
  const idxRaw   = document.getElementById("item-id-input").value;
  const origCat  = document.getElementById("item-original-cat-input").value;
  if (!name) return showToast("Insira o nome.", "error");
  try {
    const newItem = { name, defaultQty: qty, unit, preco, bestShopId };
    if (idxRaw === "") {
      state.catalog[catId].items.push(newItem);
      await saveCategoryToFirestore(catId, state.catalog[catId]);
    } else {
      const idx = parseInt(idxRaw);
      if (origCat === catId) {
        state.catalog[catId].items[idx] = newItem;
        await saveCategoryToFirestore(catId, state.catalog[catId]);
      } else {
        state.catalog[origCat].items.splice(idx, 1);
        await saveCategoryToFirestore(origCat, state.catalog[origCat]);
        state.catalog[catId].items.push(newItem);
        await saveCategoryToFirestore(catId, state.catalog[catId]);
      }
    }
    await loadCatalog(); populateCategorySelects(); renderAdminCatalog();
    closeModal("modal-item"); showToast("Produto guardado!", "success");
  } catch (e) { console.error(e); showToast("Erro.", "error"); }
});

function confirmDeleteCat(catId) {
  state.pendingDelete = { type: "category", catId };
  document.getElementById("confirm-message").textContent =
    `Eliminar a categoria "${state.catalog[catId]?.nome}" e todos os seus produtos?`;
  openModal("modal-confirm");
}
function confirmDeleteItem(catId, itemIdx) {
  state.pendingDelete = { type: "item", catId, itemIdx };
  document.getElementById("confirm-message").textContent =
    `Eliminar o produto "${state.catalog[catId]?.items[itemIdx]?.name}"?`;
  openModal("modal-confirm");
}

document.getElementById("btn-confirm-delete").addEventListener("click", async () => {
  const p = state.pendingDelete;
  try {
    if (p.type === "lista") {
      await deleteListaById(p.id);
      closeModal("modal-confirm"); showToast("Lista eliminada.", "success");
      await loadAllListas(); renderListasGrid();
    } else if (p.type === "shop") {
      await deleteSupermercado(p.id);
      await loadSupermercados(); renderAdminShops(); populateShopSelects();
      closeModal("modal-confirm"); showToast("Supermercado eliminado.", "success");
    } else if (p.type === "category") {
      await deleteCategoryFromFirestore(p.catId);
      await loadCatalog(); populateCategorySelects(); renderAdminCatalog();
      closeModal("modal-confirm"); showToast("Categoria eliminada.", "success");
    } else if (p.type === "item") {
      state.catalog[p.catId].items.splice(p.itemIdx, 1);
      await saveCategoryToFirestore(p.catId, state.catalog[p.catId]);
      await loadCatalog(); populateCategorySelects(); renderAdminCatalog();
      closeModal("modal-confirm"); showToast("Produto eliminado.", "success");
    }
  } catch (e) { console.error(e); showToast("Erro.", "error"); }
});

document.getElementById("admin-search").addEventListener("input",      renderAdminCatalog);
document.getElementById("admin-cat-filter").addEventListener("change",  renderAdminCatalog);
document.getElementById("btn-seed").addEventListener("click",           seedCatalog);

// ═══════════════════════════════════════════════════
// MODAL CLOSE
// ═══════════════════════════════════════════════════
document.querySelectorAll(".modal-close,[data-modal]").forEach(el => {
  el.addEventListener("click", () => closeModal(el.dataset.modal));
});
document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(overlay.id); });
});

// ═══════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════
(async () => {
  try {
    await Promise.all([loadCatalog(), loadSupermercados()]);
    switchView("listas");
  } catch (e) {
    console.error("Erro:", e);
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;background:#F5F3EE">
      <div><div style="font-size:3rem">🔥</div><h2 style="margin:12px 0 8px">${e.message}</h2>
      <p style="color:#8C857A;font-size:.875rem">Verifique a configuração do Firebase e as permissões do Firestore.</p></div></div>`;
  }
})();

// ═══════════════════════════════════════════════════
// ITINERÁRIO INTELIGENTE
// ═══════════════════════════════════════════════════
import { buildItinerary, formatDuration, formatDistance, renderMap } from "./itinerario.js";

// ── State ───────────────────────────────────────────
const itiState = {
  originLatLng: null,
  result:       null,
  mapRendered:  false,
};

// ── Open modal ──────────────────────────────────────
document.getElementById("btn-itinerario").addEventListener("click", () => {
  if (!state.currentLista) return;

  // Reset to config step
  showItiStep("config");
  itiState.originLatLng = null;
  itiState.result       = null;
  itiState.mapRendered  = false;
  document.getElementById("iti-config-error").classList.add("hidden");
  document.getElementById("iti-gps-status").textContent = "";

  // Populate shop chips from current lista
  populateItiShops();
  openModal("modal-itinerario");
});

// ── Step navigation ─────────────────────────────────
function showItiStep(name) {
  ["config", "loading", "result"].forEach(s => {
    document.getElementById(`iti-step-${s}`).classList.toggle("hidden", s !== name);
  });
}

// ── Origin tabs ─────────────────────────────────────
document.querySelectorAll(".iti-origin-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".iti-origin-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const mode = tab.dataset.origin;
    document.getElementById("iti-origin-gps").classList.toggle("hidden",    mode !== "gps");
    document.getElementById("iti-origin-manual").classList.toggle("hidden",  mode !== "manual");
  });
});

// ── Get GPS location ─────────────────────────────────
document.getElementById("btn-get-location").addEventListener("click", () => {
  const statusEl = document.getElementById("iti-gps-status");
  if (!navigator.geolocation) {
    statusEl.textContent = "⚠️ Geolocalização não suportada neste dispositivo.";
    statusEl.className   = "iti-status-line error";
    return;
  }
  statusEl.textContent = "A obter localização…";
  statusEl.className   = "iti-status-line";
  navigator.geolocation.getCurrentPosition(
    pos => {
      itiState.originLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      statusEl.textContent  = `✅ Localização obtida: ${itiState.originLatLng.lat.toFixed(4)}, ${itiState.originLatLng.lng.toFixed(4)}`;
      statusEl.className    = "iti-status-line success";
    },
    err => {
      statusEl.textContent = `⚠️ ${err.message}`;
      statusEl.className   = "iti-status-line error";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ── Populate shop chips ───────────────────────────────
function populateItiShops() {
  const container = document.getElementById("iti-shops-list");
  container.innerHTML = "";
  const shops = getShopsFromLista();
  if (!shops.length) {
    container.innerHTML = `<span class="iti-no-shops">Nenhum supermercado identificado na lista.</span>`;
    return;
  }
  shops.forEach(s => {
    const chip = document.createElement("span");
    chip.className = "iti-shop-chip";
    chip.style.setProperty("--chip-color", s.cor || "#2D6A4F");
    chip.innerHTML = `<span class="chip-dot" style="background:${s.cor||"#2D6A4F"}"></span>${s.nome}`;
    container.appendChild(chip);
  });
}

// Extract unique shops from current lista (resolved via catalog)
function getShopsFromLista() {
  if (!state.currentLista?.items) return [];
  const seen  = new Set();
  const shops = [];
  Object.values(state.currentLista.items).forEach(listaItem => {
    const r = resolveItem(listaItem);
    if (!r || !r.shopId) return;
    if (seen.has(r.shopId)) return;
    seen.add(r.shopId);
    const shop = state.supermercados[r.shopId];
    shops.push({ shopId: r.shopId, nome: shop?.nome || r.shopId, cor: shop?.cor || "#888" });
  });
  return shops;
}

// ── Calculate itinerary ───────────────────────────────
document.getElementById("btn-calc-itinerario").addEventListener("click", async () => {
  const errorEl = document.getElementById("iti-config-error");
  errorEl.classList.add("hidden");

  // Determine origin
  const activeTab = document.querySelector(".iti-origin-tab.active")?.dataset.origin;
  let origin;

  if (activeTab === "gps") {
    if (!itiState.originLatLng) {
      errorEl.textContent = "Clique em 'Obter localização' primeiro.";
      errorEl.classList.remove("hidden");
      return;
    }
    origin = itiState.originLatLng;
  } else {
    const lat = parseFloat(document.getElementById("iti-lat").value);
    const lng = parseFloat(document.getElementById("iti-lng").value);
    if (isNaN(lat) || isNaN(lng)) {
      errorEl.textContent = "Introduza coordenadas válidas.";
      errorEl.classList.remove("hidden");
      return;
    }
    origin = { lat, lng };
  }

  const shops = getShopsFromLista();
  if (!shops.length) {
    errorEl.textContent = "A lista não tem supermercados identificados nos produtos.";
    errorEl.classList.remove("hidden");
    return;
  }

  const returnToOrigin = document.querySelector("input[name='iti-dest']:checked")?.value === "return";

  showItiStep("loading");
  document.getElementById("iti-map-container").classList.add("hidden");
  itiState.mapRendered = false;
  document.getElementById("btn-toggle-map").querySelector("span").textContent = "🗺️ Ver no mapa";

  try {
    const result = await buildItinerary({
      shops,
      origin,
      returnToOrigin,
      onStatus: msg => { document.getElementById("iti-loading-status").textContent = msg; },
    });

    itiState.result       = result;
    itiState.originLatLng = origin;
    renderItiResult(result);
    showItiStep("result");
  } catch (e) {
    console.error(e);
    showItiStep("config");
    errorEl.textContent = `❌ ${e.message}`;
    errorEl.classList.remove("hidden");
  }
});

// ── Render result ─────────────────────────────────────
function renderItiResult(result) {
  document.getElementById("iti-total-time").textContent  = formatDuration(result.totalDuration);
  document.getElementById("iti-total-dist").textContent  = formatDistance(result.totalDistance);
  document.getElementById("iti-total-stops").textContent = result.stops.length;

  // Route steps
  const stepsEl = document.getElementById("iti-route-steps");
  stepsEl.innerHTML = "";

  // Origin node
  const originNode = document.createElement("div");
  originNode.className = "iti-step-node origin";
  originNode.innerHTML = `
    <div class="iti-step-dot origin-dot">⬤</div>
    <div class="iti-step-info">
      <span class="iti-step-label">Ponto de partida</span>
      <span class="iti-step-coords">${result.origin.lat.toFixed(4)}, ${result.origin.lng.toFixed(4)}</span>
    </div>`;
  stepsEl.appendChild(originNode);

  result.stops.forEach((stop, i) => {
    const shop    = Object.values(state.supermercados).find(s => s.nome === stop.shopName) || {};
    const cor     = shop.cor || "#2D6A4F";
    const leg     = result.legs[i] || {};
    const legSecs = parseDuration(leg.duration || "0s");
    const legDist = leg.distanceMeters || 0;

    // Connector line
    const connector = document.createElement("div");
    connector.className = "iti-connector";
    connector.innerHTML = `<div class="iti-connector-line"></div>
      <div class="iti-connector-info">${formatDuration(legSecs)} · ${formatDistance(legDist)}</div>`;
    stepsEl.appendChild(connector);

    // Stop node
    const node = document.createElement("div");
    node.className = "iti-step-node";
    node.innerHTML = `
      <div class="iti-step-num" style="background:${cor}">${i + 1}</div>
      <div class="iti-step-info">
        <span class="iti-step-label">${stop.displayName}</span>
        <span class="iti-step-address">${stop.address}</span>
      </div>`;
    stepsEl.appendChild(node);
  });

  // Return node (if applicable)
  if (result.returnToOrigin) {
    const lastLeg  = result.legs[result.stops.length] || {};
    const legSecs  = parseDuration(lastLeg.duration || "0s");
    const legDist  = lastLeg.distanceMeters || 0;
    const connector = document.createElement("div");
    connector.className = "iti-connector";
    connector.innerHTML = `<div class="iti-connector-line"></div>
      <div class="iti-connector-info">${formatDuration(legSecs)} · ${formatDistance(legDist)}</div>`;
    stepsEl.appendChild(connector);
    const returnNode = document.createElement("div");
    returnNode.className = "iti-step-node origin";
    returnNode.innerHTML = `
      <div class="iti-step-dot origin-dot">⬤</div>
      <div class="iti-step-info"><span class="iti-step-label">Regressar ao ponto de partida</span></div>`;
    stepsEl.appendChild(returnNode);
  }

  // Skipped shops
  const skippedEl = document.getElementById("iti-skipped");
  if (result.skipped?.length) {
    skippedEl.textContent = `⚠️ Não encontradas filiais para: ${result.skipped.map(s => s.shopName).join(", ")}`;
    skippedEl.classList.remove("hidden");
  } else {
    skippedEl.classList.add("hidden");
  }
}

function parseDuration(s) {
  const m = s.match(/(\d+)s/); return m ? parseInt(m[1]) : 0;
}

// ── Map toggle ────────────────────────────────────────
document.getElementById("btn-toggle-map").addEventListener("click", async () => {
  const container = document.getElementById("iti-map-container");
  const label     = document.getElementById("iti-map-toggle-label");
  const hidden    = container.classList.contains("hidden");

  if (hidden) {
    container.classList.remove("hidden");
    label.textContent = "🗺️ Ocultar mapa";
    if (!itiState.mapRendered && itiState.result) {
      label.textContent = "⏳ A carregar mapa…";
      try {
        await renderMap("iti-map", itiState.result);
        itiState.mapRendered = true;
        label.textContent = "🗺️ Ocultar mapa";
      } catch (e) {
        label.textContent = "⚠️ Erro ao carregar mapa";
        console.error(e);
      }
    }
  } else {
    container.classList.add("hidden");
    label.textContent = "🗺️ Ver no mapa";
  }
});

// ── Back to config ────────────────────────────────────
document.getElementById("btn-iti-back").addEventListener("click", () => {
  itiState.mapRendered = false;
  document.getElementById("iti-map-container").classList.add("hidden");
  showItiStep("config");
});