// app.js — Guia de Compras v5.4
import { db } from "./firebase.js";
import { defaultCatalog } from "./data-default.js";
import {
  collection, doc, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, onSnapshot
} from "./firebase.js";

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const state = {
  catalog:        {},
  allListas:      [],
  currentLista:   null,
  currentListaId: null,
  unsubLista:     null,
  pendingDelete:  null,
  addProductSel:  new Set(), // selections in add-product modal
};

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════
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

function generateItemId(catId, name) { return `${catId}_${slugify(name)}`; }

function fmtKz(val) {
  return "Kz " + Math.round(val).toLocaleString("pt-AO");
}

function showToast(msg, type = "default") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = "toast"; }, 3200);
}

function openModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

// ── Auto name generation ─────────────────────
const PT_DAYS  = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];
const PT_MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
                   "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function generateListaName(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const base = `Compras ${PT_DAYS[d.getDay()]} ${d.getDate()} de ${PT_MONTHS[d.getMonth()]}`;
  // Count existing with same date
  const sameDate = state.allListas.filter(l => l.date === dateStr);
  const names = sameDate.map(l => l.nome);
  if (!names.includes(base)) return base;
  let n = 2;
  while (names.includes(`${base} #${n}`)) n++;
  return `${base} #${n}`;
}

// ── Shop distribution ───────────────────────
function calcShopDistribution(selections) {
  // Returns { shopName: totalValue } sorted desc
  const totals = {};
  selections.forEach(key => {
    const [catId, idxStr] = key.split("|");
    const catData = state.catalog[catId]; if (!catData) return;
    const item = catData.items[parseInt(idxStr)]; if (!item) return;
    const shop = item.bestShop || "Outro";
    const val  = (item.preco || 0) * (item.defaultQty || 1);
    totals[shop] = (totals[shop] || 0) + val;
  });
  return totals;
}

function topShop(dist) {
  let top = "", topVal = 0;
  Object.entries(dist).forEach(([s, v]) => { if (v > topVal) { top = s; topVal = v; } });
  return top;
}

const SHOP_COLORS = [
  "#2D6A4F","#E07A5F","#C9A84C","#5B7FA6","#8E6BBF",
  "#3D9970","#E8743B","#6495ED","#BC8C4C","#708090"
];

function renderShopDist(dist) {
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (!total) { document.getElementById("gerar-shop-dist").classList.add("hidden"); return; }
  document.getElementById("gerar-shop-dist").classList.remove("hidden");

  const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  const barsEl  = document.getElementById("shop-dist-bars");
  const legendEl = document.getElementById("shop-dist-legend");
  barsEl.innerHTML = "";
  legendEl.innerHTML = "";

  sorted.forEach(([shop, val], i) => {
    const pct = (val / total) * 100;
    const color = SHOP_COLORS[i % SHOP_COLORS.length];
    const seg = document.createElement("div");
    seg.className = "dist-seg";
    seg.style.cssText = `width:${pct}%;background:${color};`;
    seg.title = `${shop}: ${fmtKz(val)} (${pct.toFixed(0)}%)`;
    barsEl.appendChild(seg);

    const leg = document.createElement("div");
    leg.className = "dist-leg-item";
    leg.innerHTML = `<span class="dist-dot" style="background:${color}"></span>${shop} <strong>${pct.toFixed(0)}%</strong>`;
    legendEl.appendChild(leg);
  });
}

// ── Budget calculation ──────────────────────
function calcBudget(items) {
  // items: object { itemId: { qty, preco, ... } } OR array of item objects
  const arr = Array.isArray(items) ? items : Object.values(items);
  return arr.reduce((sum, it) => sum + (it.qty || it.defaultQty || 0) * (it.preco || 0), 0);
}

function getShopsFromCatalog() {
  const shops = new Set();
  Object.values(state.catalog).forEach(cat =>
    (cat.items || []).forEach(it => { if (it.bestShop) shops.add(it.bestShop); })
  );
  return [...shops].sort();
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
const views = { listas:"view-listas", lista:"view-lista", gerar:"view-gerar", admin:"view-admin" };

function switchView(name, param) {
  if (state.unsubLista) { state.unsubLista(); state.unsubLista = null; }
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

// ═══════════════════════════════════════════
// FIRESTORE — CATALOG
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
// FIRESTORE — LISTAS
// ═══════════════════════════════════════════
async function loadAllListas() {
  const snap = await getDocs(collection(db, "listas"));
  state.allListas = [];
  snap.forEach(d => {
    const data = d.data();
    state.allListas.push({
      id:           d.id,
      date:         data.date || "",
      nome:         data.nome || "",
      supermercado: data.supermercado || "",
      itemCount:    data.items ? Object.keys(data.items).length : 0,
      budget:       data.items ? calcBudget(data.items) : 0,
    });
  });
  state.allListas.sort((a, b) => b.date.localeCompare(a.date));
}

function subscribeToLista(id, cb) {
  if (state.unsubLista) { state.unsubLista(); state.unsubLista = null; }
  state.unsubLista = onSnapshot(doc(db, "listas", id), snap => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

async function updateListaItem(listaId, itemId, fields) {
  const upd = {};
  Object.entries(fields).forEach(([k, v]) => { upd[`items.${itemId}.${k}`] = v; });
  await updateDoc(doc(db, "listas", listaId), upd);
}

async function removeListaItem(listaId, itemId) {
  // Firestore: set field to deleteField() via FieldValue — use updateDoc with deleteField
  const { deleteField } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const upd = {};
  upd[`items.${itemId}`] = deleteField();
  await updateDoc(doc(db, "listas", listaId), upd);
}

async function saveNewLista(listaDoc) {
  const id = crypto.randomUUID();
  await setDoc(doc(db, "listas", id), listaDoc);
  return id;
}

async function deleteListaById(id) { await deleteDoc(doc(db, "listas", id)); }

// ═══════════════════════════════════════════
// SEED
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
// SHARED SELECTS
// ═══════════════════════════════════════════
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

function populateShopFilter(selId) {
  const sel = document.getElementById(selId); if (!sel) return;
  const val = sel.value, shops = getShopsFromCatalog();
  sel.innerHTML = '<option value="">Todos os supermercados</option>' +
    shops.map(s => `<option value="${s}">${s}</option>`).join("");
  sel.value = val;
}

// ═══════════════════════════════════════════
// VIEW: LISTAGEM
// ═══════════════════════════════════════════
async function initListasView() {
  await loadAllListas();
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
  state.allListas.forEach(l => {
    if (!byDate[l.date]) byDate[l.date] = [];
    byDate[l.date].push(l);
  });
  Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).forEach(([date, listas]) => {
    const group = document.createElement("div");
    group.className = "listas-date-group";
    group.innerHTML = `<div class="listas-date-label">📅 ${formatDatePT(date)}</div>`;
    listas.forEach(lista => {
      const card = document.createElement("div");
      card.className = "lista-card";
      card.innerHTML = `
        <div class="lista-card-body" data-id="${lista.id}">
          <div class="lista-card-top">
            <span class="lista-card-nome">${lista.nome || "Lista sem nome"}</span>
            ${lista.supermercado ? `<span class="lista-card-shop">🛍️ ${lista.supermercado}</span>` : ""}
          </div>
          <div class="lista-card-meta">
            ${lista.itemCount} produtos
            ${lista.budget > 0 ? `· <strong>${fmtKz(lista.budget)}</strong>` : ""}
          </div>
        </div>
        <div class="lista-card-actions">
          <button class="btn-icon" title="Partilhar" data-action="share" data-id="${lista.id}">🔗</button>
          <button class="btn-icon" title="Editar" data-action="edit-lista" data-id="${lista.id}">✏️</button>
          <button class="btn-icon danger" title="Apagar" data-action="delete-lista" data-id="${lista.id}">🗑️</button>
        </div>`;
      card.querySelector(".lista-card-body").addEventListener("click", () => switchView("lista", lista.id));
      card.querySelectorAll("[data-action]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          handleListaCardAction(btn.dataset.action, btn.dataset.id);
        });
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
    const url = shareUrl(listaId);
    navigator.clipboard.writeText(url)
      .then(() => showToast("Link copiado!", "success"))
      .catch(() => prompt("Copia este link:", url));
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
    closeModal("modal-edit-lista");
    showToast("Lista actualizada!", "success");
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

// ═══════════════════════════════════════════
// VIEW: LISTA DETALHE
// ═══════════════════════════════════════════
async function initListaView(listaId) {
  if (!listaId) { switchView("listas"); return; }
  state.currentListaId = listaId;
  document.getElementById("lista-loading").classList.remove("hidden");
  document.getElementById("lista-empty").classList.add("hidden");
  document.getElementById("lista-content").classList.add("hidden");
  document.getElementById("lista-summary").classList.add("hidden");
  document.getElementById("lista-budget").classList.add("hidden");
  document.getElementById("lista-search").value = "";
  document.getElementById("lista-shop-filter").value = "";

  await loadCatalog();
  populateShopFilter("lista-shop-filter");

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
    shop:   document.getElementById("lista-shop-filter").value,
    sort:   document.getElementById("lista-sort").value,
  };
}

function renderLista(listaData) {
  const { search, shop, sort } = getListaFilters();
  const container = document.getElementById("lista-content");
  container.innerHTML = "";

  if (!listaData?.items || !Object.keys(listaData.items).length) {
    document.getElementById("lista-empty").classList.remove("hidden");
    container.classList.add("hidden");
    document.getElementById("lista-budget").classList.add("hidden");
    return;
  }

  document.getElementById("lista-empty").classList.add("hidden");
  container.classList.remove("hidden");
  document.getElementById("lista-summary").classList.remove("hidden");
  document.getElementById("lista-budget").classList.remove("hidden");

  // Budget
  const budgetVal = calcBudget(listaData.items);
  document.getElementById("budget-total").textContent = fmtKz(budgetVal);

  // Filter
  let entries = Object.entries(listaData.items).filter(([, item]) =>
    (!search || item.name.toLowerCase().includes(search)) &&
    (!shop   || item.bestShop === shop)
  );

  // Group
  const byGroup = {};
  entries.forEach(([itemId, item]) => {
    const key = sort === "supermercado"
      ? (item.bestShop || "Sem supermercado")
      : (item.categoria || "Sem categoria");
    if (!byGroup[key]) byGroup[key] = [];
    byGroup[key].push({ itemId, ...item });
  });

  Object.entries(byGroup).sort((a, b) => a[0].localeCompare(b[0])).forEach(([groupName, items]) => {
    const group = document.createElement("div");
    group.className = "lista-category-group";
    const checked = items.filter(i => i.checked).length;
    group.innerHTML = `<div class="lista-cat-header"><h3>${groupName}</h3><span class="cat-badge">${checked}/${items.length}</span></div>`;

    items.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
      const row = document.createElement("div");
      row.className = `lista-item${item.checked ? " checked" : ""}`;
      const lineTotal = (item.qty || 0) * (item.preco || 0);
      row.innerHTML = `
        <input type="checkbox" class="item-checkbox" ${item.checked ? "checked" : ""} />
        <div class="item-info">
          <span class="item-name">${item.name}</span>
          ${item.bestShop ? `<span class="item-shop-tag">${item.bestShop}</span>` : ""}
        </div>
        <div class="item-qty-wrap">
          <input type="number" class="item-qty-input" value="${item.qty}" min="0" step="0.1" />
          <span class="item-unit">${item.unit}</span>
        </div>
        ${item.preco ? `<span class="item-line-total">${fmtKz(lineTotal)}</span>` : ""}
        <button class="btn-icon btn-remove-item danger" title="Remover da lista" data-itemid="${item.itemId}">✕</button>`;

      const cb = row.querySelector(".item-checkbox");
      cb.addEventListener("change", async () => {
        row.classList.toggle("checked", cb.checked);
        await updateListaItem(listaData.id, item.itemId, { checked: cb.checked });
      });

      const qi = row.querySelector(".item-qty-input");
      let timer;
      qi.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const qty = parseFloat(qi.value) || 0;
          await updateListaItem(listaData.id, item.itemId, { qty });
          // Update line total immediately
          const lt = row.querySelector(".item-line-total");
          if (lt) lt.textContent = fmtKz(qty * (item.preco || 0));
        }, 500);
      });

      row.querySelector(".btn-remove-item").addEventListener("click", async () => {
        if (!confirm(`Remover "${item.name}" da lista?`)) return;
        await removeListaItem(listaData.id, item.itemId);
      });

      group.appendChild(row);
    });
    container.appendChild(group);
  });

  updateListaSummary(listaData);
}

function updateListaSummary(listaData) {
  const all = Object.values(listaData.items);
  const checked = all.filter(i => i.checked).length, total = all.length;
  document.getElementById("summary-checked").textContent = checked;
  document.getElementById("summary-total").textContent   = total;
  document.getElementById("progress-fill").style.width   = `${total ? (checked / total) * 100 : 0}%`;
}

document.getElementById("lista-search").addEventListener("input", () => { if (state.currentLista) renderLista(state.currentLista); });
document.getElementById("lista-shop-filter").addEventListener("change", () => { if (state.currentLista) renderLista(state.currentLista); });
document.getElementById("lista-sort").addEventListener("change", () => { if (state.currentLista) renderLista(state.currentLista); });
document.getElementById("btn-back-listas").addEventListener("click", () => switchView("listas"));
document.getElementById("btn-share-lista").addEventListener("click", () => {
  if (!state.currentListaId) return;
  const url = shareUrl(state.currentListaId);
  navigator.clipboard.writeText(url).then(() => showToast("Link copiado!", "success")).catch(() => prompt("Copia:", url));
});

// ── Add product to existing lista ────────────
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

  const existingIds = new Set(
    state.currentLista ? Object.keys(state.currentLista.items || {}) : []
  );

  const cats = Object.entries(state.catalog)
    .filter(([id]) => !cat || id === cat)
    .sort((a, b) => a[1].nome.localeCompare(b[1].nome));

  cats.forEach(([catId, catData]) => {
    const items = catData.items
      .map((item, i) => ({ item, i }))
      .filter(({ item, i }) => {
        const itemId = generateItemId(catId, item.name);
        return !existingIds.has(itemId) &&
          (!search || item.name.toLowerCase().includes(search));
      });
    if (!items.length) return;

    const groupEl = document.createElement("div");
    groupEl.className = "add-product-group";
    groupEl.innerHTML = `<div class="add-product-cat-label">${catData.nome}</div>`;

    items.forEach(({ item, i }) => {
      const key    = `${catId}|${i}`;
      const isSel  = state.addProductSel.has(key);
      const row    = document.createElement("div");
      row.className = `add-product-row${isSel ? " selected" : ""}`;
      row.innerHTML = `
        <input type="checkbox" ${isSel ? "checked" : ""} data-key="${key}" />
        <div class="add-product-info">
          <span class="add-product-name">${item.name}</span>
          <span class="add-product-meta">${item.defaultQty} ${item.unit}${item.bestShop ? ` · ${item.bestShop}` : ""}${item.preco ? ` · ${fmtKz(item.preco)}` : ""}</span>
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
    container.innerHTML = `<div class="empty-state" style="padding:30px 0;"><p>Nenhum produto disponível para adicionar.</p></div>`;
  }
}

document.getElementById("add-product-search").addEventListener("input", renderAddProductList);
document.getElementById("add-product-cat").addEventListener("change", renderAddProductList);

document.getElementById("btn-confirm-add-products").addEventListener("click", async () => {
  if (!state.addProductSel.size) return showToast("Seleccione pelo menos um produto.", "error");
  if (!state.currentListaId)    return;
  const upd = {};
  state.addProductSel.forEach(key => {
    const [catId, idxStr] = key.split("|");
    const catData = state.catalog[catId]; if (!catData) return;
    const item    = catData.items[parseInt(idxStr)]; if (!item) return;
    const itemId  = generateItemId(catId, item.name);
    upd[`items.${itemId}`] = {
      name:      item.name,
      qty:       item.defaultQty,
      unit:      item.unit,
      checked:   false,
      categoria: catData.nome,
      bestShop:  item.bestShop || "",
      preco:     item.preco || 0,
    };
  });
  try {
    await updateDoc(doc(db, "listas", state.currentListaId), upd);
    closeModal("modal-add-to-lista");
    showToast(`${state.addProductSel.size} produto(s) adicionado(s)!`, "success");
    state.addProductSel.clear();
  } catch (e) { console.error(e); showToast("Erro ao adicionar.", "error"); }
});

// ═══════════════════════════════════════════
// VIEW: GERAR
// ═══════════════════════════════════════════
let gerarSelections = new Set();

async function initGerarView() {
  await loadCatalog();
  populateCategorySelects();
  populateShopFilter("gerar-shop-filter");
  gerarSelections.clear();
  updateGerarCount();
  updateGerarBudget();

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
    shop:   document.getElementById("gerar-shop-filter").value,
  };
}

function renderGerarCatalog() {
  const { search, cat, shop } = getGerarFilters();
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
        (!shop   || item.bestShop === shop)
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
      const el    = document.createElement("div");
      el.className = `gerar-item${isSel ? " selected" : ""}`;
      el.innerHTML = `
        <input type="checkbox" ${isSel ? "checked" : ""} data-key="${key}" />
        <div class="gerar-item-info">
          <div class="gerar-item-name">${item.name}</div>
          <div class="gerar-item-meta">
            ${item.defaultQty} ${item.unit}
            ${item.bestShop ? `· <span class="shop-pill">${item.bestShop}</span>` : ""}
            ${item.preco    ? `· <span class="price-pill">${fmtKz(item.preco)}</span>` : ""}
          </div>
        </div>`;
      const cb = el.querySelector("input");
      const toggle = () => {
        if (cb.checked) { gerarSelections.add(key); el.classList.add("selected"); }
        else            { gerarSelections.delete(key); el.classList.remove("selected"); }
        updateGerarCount();
        updateSelectAllState();
        updateGerarBudget();
        updateShopSuggestion();
      };
      cb.addEventListener("change", toggle);
      el.addEventListener("click", e => { if (e.target !== cb) { cb.checked = !cb.checked; toggle(); } });
      grid.appendChild(el);
    });

    group.appendChild(grid);
    container.appendChild(group);
  });
  updateSelectAllState();
}

function updateGerarCount() {
  const n = gerarSelections.size;
  document.getElementById("gerar-count").textContent =
    `${n} produto${n !== 1 ? "s" : ""} seleccionado${n !== 1 ? "s" : ""}`;
  document.getElementById("btn-create-list").disabled = n === 0;
}

function updateGerarBudget() {
  const preview = document.getElementById("gerar-budget-preview");
  if (!gerarSelections.size) { preview.classList.add("hidden"); return; }
  let total = 0;
  gerarSelections.forEach(key => {
    const [catId, idxStr] = key.split("|");
    const catData = state.catalog[catId]; if (!catData) return;
    const item    = catData.items[parseInt(idxStr)]; if (!item) return;
    total += (item.preco || 0) * (item.defaultQty || 1);
  });
  document.getElementById("gerar-budget-total").textContent = fmtKz(total);
  preview.classList.remove("hidden");
}

function updateShopSuggestion() {
  const dist = calcShopDistribution(gerarSelections);
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

document.getElementById("gerar-search").addEventListener("input", renderGerarCatalog);
document.getElementById("gerar-cat-filter").addEventListener("change", renderGerarCatalog);
document.getElementById("gerar-shop-filter").addEventListener("change", renderGerarCatalog);
document.getElementById("gerar-date").addEventListener("change", e => {
  if (e.target.value < todayStr()) {
    e.target.value = todayStr();
    showToast("Não pode seleccionar data passada.", "error");
  }
});

document.getElementById("btn-create-list").addEventListener("click", async () => {
  const dateStr = document.getElementById("gerar-date").value;
  let   nome    = document.getElementById("gerar-nome").value.trim();
  const superM  = document.getElementById("gerar-supermercado").value.trim();

  if (!dateStr) return showToast("Seleccione uma data.", "error");
  if (!gerarSelections.size) return showToast("Seleccione pelo menos um produto.", "error");

  // Auto-generate name if blank
  if (!nome) {
    await loadAllListas(); // refresh for sequential check
    nome = generateListaName(dateStr);
  }

  const btn = document.getElementById("btn-create-list");
  btn.disabled = true; btn.querySelector("span").textContent = "A criar…";
  try {
    const items = {};
    gerarSelections.forEach(key => {
      const [catId, idxStr] = key.split("|");
      const catData = state.catalog[catId]; if (!catData) return;
      const item    = catData.items[parseInt(idxStr)];
      const itemId  = generateItemId(catId, item.name);
      items[itemId] = {
        name:      item.name,
        qty:       item.defaultQty,
        unit:      item.unit,
        checked:   false,
        categoria: catData.nome,
        bestShop:  item.bestShop || "",
        preco:     item.preco    || 0,
      };
    });
    const listaId = await saveNewLista({ date: dateStr, nome, supermercado: superM, items });
    showToast(`Lista "${nome}" criada!`, "success");
    setTimeout(() => switchView("lista", listaId), 700);
  } catch (e) {
    console.error(e); showToast("Erro ao criar lista.", "error");
    btn.disabled = false; btn.querySelector("span").textContent = "Criar Lista";
  }
});

// ═══════════════════════════════════════════
// VIEW: ADMIN
// ═══════════════════════════════════════════
async function initAdminView() {
  await loadCatalog(); populateCategorySelects(); renderAdminCatalog();
}

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
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><p>Nenhuma categoria.</p><small>Use "Seed Padrão".</small></div>`;
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
          <button class="btn-icon" data-action="edit-cat" data-cat="${catId}">✏️</button>
          <button class="btn-icon danger" data-action="delete-cat" data-cat="${catId}">🗑️</button>
        </div>
      </div>
      <div class="admin-items-list">
        ${filteredItems.map(item => {
          const realIdx = catData.items.indexOf(item);
          return `<div class="admin-item-row">
            <span class="admin-item-name">${item.name}</span>
            <span class="admin-item-meta">${item.defaultQty} ${item.unit}</span>
            ${item.preco    ? `<span class="price-pill">${fmtKz(item.preco)}</span>` : ""}
            ${item.bestShop ? `<span class="shop-pill">${item.bestShop}</span>`       : ""}
            <div class="admin-item-actions">
              <button class="btn-icon" data-action="edit-item" data-cat="${catId}" data-idx="${realIdx}">✏️</button>
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
  const name  = document.getElementById("cat-name-input").value.trim();
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
  ["item-name-input", "item-shop-input"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("item-qty-input").value   = "1";
  document.getElementById("item-unit-input").value  = "un";
  document.getElementById("item-preco-input").value = "0";
  document.getElementById("item-cat-input").value   = catId;
  document.getElementById("item-id-input").value    = "";
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
  document.getElementById("item-shop-input").value   = item.bestShop || "";
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
  const bestShop = document.getElementById("item-shop-input").value.trim();
  const catId    = document.getElementById("item-cat-input").value;
  const idxRaw   = document.getElementById("item-id-input").value;
  const origCat  = document.getElementById("item-original-cat-input").value;
  if (!name) return showToast("Insira o nome.", "error");
  try {
    const newItem = { name, defaultQty: qty, unit, preco, bestShop };
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

document.getElementById("admin-search").addEventListener("input", renderAdminCatalog);
document.getElementById("admin-cat-filter").addEventListener("change", renderAdminCatalog);
document.getElementById("btn-seed").addEventListener("click", seedCatalog);

// ═══════════════════════════════════════════
// MODAL CLOSE
// ═══════════════════════════════════════════
document.querySelectorAll(".modal-close,[data-modal]").forEach(el => {
  el.addEventListener("click", () => closeModal(el.dataset.modal));
});
document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(overlay.id); });
});

// ═══════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════
(async () => {
  try {
    await loadCatalog();
    switchView("listas");
  } catch (e) {
    console.error("Erro:", e);
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;background:#F5F3EE;"><div><div style="font-size:3rem">🔥</div><h2>${e.message}</h2></div></div>`;
  }
})();