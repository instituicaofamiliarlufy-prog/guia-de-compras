// app.js — Guia de Compras v5.2
// ─────────────────────────────────────────────
import { db } from "./firebase.js";
import { defaultCatalog } from "./data-default.js";
import {
  collection, doc, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy
} from "./firebase.js";

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const state = {
  catalog: {},           // { catId: { nome, items: [] } }
  listaDates: new Set(), // set of "YYYY-MM-DD" strings that have lists
  currentLista: null,    // { date, items: {} }
  currentListaDate: null,
  unsubLista: null,      // firestore listener cleanup
  pendingDelete: null,   // { type: 'category'|'item', catId, itemIndex }
};

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function formatDatePT(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function slugify(text) {
  return text.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function generateItemId(catId, name) {
  return `${catId}_${slugify(name)}`;
}

function showToast(msg, type = "default") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = "toast"; }, 3000);
}

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}
function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
const views = { lista: "view-lista", gerar: "view-gerar", admin: "view-admin" };

function switchView(name) {
  Object.values(views).forEach(id => {
    document.getElementById(id).classList.add("hidden");
    document.getElementById(id).classList.remove("active");
  });
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));

  const el = document.getElementById(views[name]);
  el.classList.remove("hidden");
  el.classList.add("active");
  document.querySelector(`[data-view="${name}"]`).classList.add("active");

  if (name === "lista") initListaView();
  if (name === "gerar") initGerarView();
  if (name === "admin") initAdminView();
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// ═══════════════════════════════════════════
// FIRESTORE — CATALOG
// ═══════════════════════════════════════════
async function loadCatalog() {
  const snap = await getDocs(collection(db, "catalogo"));
  state.catalog = {};
  snap.forEach(d => { state.catalog[d.id] = d.data(); });
  return state.catalog;
}

async function saveCategoryToFirestore(catId, data) {
  await setDoc(doc(db, "catalogo", catId), data);
}

async function deleteCategoryFromFirestore(catId) {
  await deleteDoc(doc(db, "catalogo", catId));
}

// ═══════════════════════════════════════════
// FIRESTORE — LISTS
// ═══════════════════════════════════════════
async function loadListaDates() {
  const snap = await getDocs(collection(db, "listas"));
  state.listaDates = new Set();
  snap.forEach(d => state.listaDates.add(d.id));
}

async function getListaDoc(dateStr) {
  const snap = await getDoc(doc(db, "listas", dateStr));
  return snap.exists() ? snap.data() : null;
}

async function getMostRecentLista() {
  // Sort dates descending, pick first
  const sorted = [...state.listaDates].sort().reverse();
  if (!sorted.length) return null;
  return { date: sorted[0], ...(await getListaDoc(sorted[0])) };
}

function subscribeToLista(dateStr, callback) {
  if (state.unsubLista) { state.unsubLista(); state.unsubLista = null; }
  state.unsubLista = onSnapshot(doc(db, "listas", dateStr), snap => {
    if (snap.exists()) callback(snap.data());
    else callback(null);
  });
}

async function updateListaItem(dateStr, itemId, fields) {
  const ref = doc(db, "listas", dateStr);
  const update = {};
  Object.entries(fields).forEach(([k, v]) => { update[`items.${itemId}.${k}`] = v; });
  await updateDoc(ref, update);
}

async function saveNewLista(dateStr, items) {
  await setDoc(doc(db, "listas", dateStr), { date: dateStr, items });
}

// ═══════════════════════════════════════════
// SEED
// ═══════════════════════════════════════════
async function seedCatalog() {
  const btn = document.getElementById("btn-seed");
  btn.disabled = true;
  btn.textContent = "A carregar…";
  try {
    for (const [catName, items] of Object.entries(defaultCatalog)) {
      const catId = slugify(catName);
      await saveCategoryToFirestore(catId, { nome: catName, items });
    }
    await loadCatalog();
    renderAdminCatalog();
    populateCategorySelects();
    showToast("Catálogo carregado com sucesso!", "success");
  } catch (e) {
    console.error(e);
    showToast("Erro ao carregar catálogo.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🌱 Seed Padrão";
  }
}

// ═══════════════════════════════════════════
// SHARED: POPULATE CATEGORY SELECTS
// ═══════════════════════════════════════════
function populateCategorySelects() {
  const cats = Object.entries(state.catalog)
    .sort((a, b) => a[1].nome.localeCompare(b[1].nome));

  // Admin filter
  const adminFilter = document.getElementById("admin-cat-filter");
  const adminVal = adminFilter.value;
  adminFilter.innerHTML = '<option value="">Todas as categorias</option>' +
    cats.map(([id, c]) => `<option value="${id}">${c.nome}</option>`).join("");
  adminFilter.value = adminVal;

  // Gerar filter
  const gerarFilter = document.getElementById("gerar-cat-filter");
  const gerarVal = gerarFilter.value;
  gerarFilter.innerHTML = '<option value="">Todas as categorias</option>' +
    cats.map(([id, c]) => `<option value="${id}">${c.nome}</option>`).join("");
  gerarFilter.value = gerarVal;

  // Item modal category select
  const itemCatSel = document.getElementById("item-cat-input");
  itemCatSel.innerHTML = cats.map(([id, c]) => `<option value="${id}">${c.nome}</option>`).join("");
}

// ═══════════════════════════════════════════
// VIEW: ADMIN
// ═══════════════════════════════════════════
async function initAdminView() {
  await loadCatalog();
  populateCategorySelects();
  renderAdminCatalog();
}

function getAdminFilters() {
  const search = document.getElementById("admin-search").value.toLowerCase().trim();
  const cat    = document.getElementById("admin-cat-filter").value;
  return { search, cat };
}

function renderAdminCatalog() {
  const { search, cat } = getAdminFilters();
  const container = document.getElementById("admin-catalog");
  container.innerHTML = "";

  const cats = Object.entries(state.catalog)
    .filter(([id]) => !cat || id === cat)
    .sort((a, b) => a[1].nome.localeCompare(b[1].nome));

  if (!cats.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><p>Nenhuma categoria encontrada.</p><small>Use "Seed Padrão" para adicionar dados de exemplo.</small></div>`;
    return;
  }

  cats.forEach(([catId, catData]) => {
    const filteredItems = catData.items.filter(it =>
      !search || it.name.toLowerCase().includes(search)
    );
    if (search && !filteredItems.length) return;

    const card = document.createElement("div");
    card.className = "admin-cat-card";
    card.innerHTML = `
      <div class="admin-cat-header">
        <h3>${catData.nome}</h3>
        <div class="admin-cat-actions">
          <button class="btn-icon" title="Editar categoria" data-action="edit-cat" data-cat="${catId}">✏️</button>
          <button class="btn-icon danger" title="Eliminar categoria" data-action="delete-cat" data-cat="${catId}">🗑️</button>
        </div>
      </div>
      <div class="admin-items-list">
        ${filteredItems.map((item, i) => {
          const realIdx = catData.items.indexOf(item);
          return `
          <div class="admin-item-row">
            <span class="admin-item-name">${item.name}</span>
            <span class="admin-item-meta">${item.defaultQty} ${item.unit}</span>
            <div class="admin-item-actions">
              <button class="btn-icon" title="Editar" data-action="edit-item" data-cat="${catId}" data-idx="${realIdx}">✏️</button>
              <button class="btn-icon danger" title="Eliminar" data-action="delete-item" data-cat="${catId}" data-idx="${realIdx}">🗑️</button>
            </div>
          </div>`;
        }).join("")}
      </div>
      <div class="admin-add-item">
        <button class="btn-add-item" data-action="add-item" data-cat="${catId}">+ Adicionar produto</button>
      </div>
    `;
    container.appendChild(card);
  });

  // Events
  container.querySelectorAll("[data-action]").forEach(el => {
    el.addEventListener("click", handleAdminAction);
  });
}

function handleAdminAction(e) {
  const el = e.currentTarget;
  const action = el.dataset.action;
  const catId  = el.dataset.cat;
  const idx    = el.dataset.idx !== undefined ? parseInt(el.dataset.idx) : null;

  switch (action) {
    case "edit-cat":    openEditCategoryModal(catId); break;
    case "delete-cat":  confirmDelete("category", catId); break;
    case "add-item":    openAddItemModal(catId); break;
    case "edit-item":   openEditItemModal(catId, idx); break;
    case "delete-item": confirmDelete("item", catId, idx); break;
  }
}

// ── Category Modal ───────────────────────────
document.getElementById("btn-add-category").addEventListener("click", () => {
  document.getElementById("modal-cat-title").textContent = "Nova Categoria";
  document.getElementById("cat-name-input").value = "";
  document.getElementById("cat-id-input").value = "";
  openModal("modal-category");
});

function openEditCategoryModal(catId) {
  document.getElementById("modal-cat-title").textContent = "Editar Categoria";
  document.getElementById("cat-name-input").value = state.catalog[catId].nome;
  document.getElementById("cat-id-input").value = catId;
  openModal("modal-category");
}

document.getElementById("btn-save-category").addEventListener("click", async () => {
  const name  = document.getElementById("cat-name-input").value.trim();
  const oldId = document.getElementById("cat-id-input").value;
  if (!name) return showToast("Insira o nome da categoria.", "error");

  const newId = slugify(name);
  try {
    if (oldId && oldId !== newId) {
      // Rename: copy to new id, delete old
      const oldData = state.catalog[oldId];
      await saveCategoryToFirestore(newId, { ...oldData, nome: name });
      await deleteCategoryFromFirestore(oldId);
    } else {
      const existing = state.catalog[oldId] || { items: [] };
      await saveCategoryToFirestore(newId, { ...existing, nome: name });
    }
    await loadCatalog();
    populateCategorySelects();
    renderAdminCatalog();
    closeModal("modal-category");
    showToast("Categoria guardada!", "success");
  } catch (e) {
    console.error(e); showToast("Erro ao guardar.", "error");
  }
});

// ── Item Modal ───────────────────────────────
function openAddItemModal(catId) {
  document.getElementById("modal-item-title").textContent = "Novo Produto";
  document.getElementById("item-name-input").value = "";
  document.getElementById("item-qty-input").value = "1";
  document.getElementById("item-unit-input").value = "un";
  document.getElementById("item-cat-input").value = catId;
  document.getElementById("item-id-input").value = "";
  document.getElementById("item-original-cat-input").value = catId;
  openModal("modal-item");
}

function openEditItemModal(catId, idx) {
  const item = state.catalog[catId].items[idx];
  document.getElementById("modal-item-title").textContent = "Editar Produto";
  document.getElementById("item-name-input").value = item.name;
  document.getElementById("item-qty-input").value = item.defaultQty;
  document.getElementById("item-unit-input").value = item.unit;
  document.getElementById("item-cat-input").value = catId;
  document.getElementById("item-id-input").value = idx;
  document.getElementById("item-original-cat-input").value = catId;
  openModal("modal-item");
}

document.getElementById("btn-save-item").addEventListener("click", async () => {
  const name    = document.getElementById("item-name-input").value.trim();
  const qty     = parseFloat(document.getElementById("item-qty-input").value) || 1;
  const unit    = document.getElementById("item-unit-input").value;
  const catId   = document.getElementById("item-cat-input").value;
  const idxRaw  = document.getElementById("item-id-input").value;
  const origCat = document.getElementById("item-original-cat-input").value;

  if (!name) return showToast("Insira o nome do produto.", "error");

  try {
    const newItem = { name, defaultQty: qty, unit };
    if (idxRaw === "") {
      // Add new
      const cat = state.catalog[catId];
      cat.items.push(newItem);
      await saveCategoryToFirestore(catId, cat);
    } else {
      const idx = parseInt(idxRaw);
      if (origCat === catId) {
        // Same category: update in place
        state.catalog[catId].items[idx] = newItem;
        await saveCategoryToFirestore(catId, state.catalog[catId]);
      } else {
        // Moved to different category: remove from old, add to new
        state.catalog[origCat].items.splice(idx, 1);
        await saveCategoryToFirestore(origCat, state.catalog[origCat]);
        state.catalog[catId].items.push(newItem);
        await saveCategoryToFirestore(catId, state.catalog[catId]);
      }
    }
    await loadCatalog();
    populateCategorySelects();
    renderAdminCatalog();
    closeModal("modal-item");
    showToast("Produto guardado!", "success");
  } catch (e) {
    console.error(e); showToast("Erro ao guardar produto.", "error");
  }
});

// ── Confirm Delete ───────────────────────────
function confirmDelete(type, catId, itemIdx) {
  state.pendingDelete = { type, catId, itemIdx };
  const msgs = {
    category: `Eliminar a categoria "${state.catalog[catId]?.nome}" e todos os seus produtos?`,
    item:     `Eliminar o produto "${state.catalog[catId]?.items[itemIdx]?.name}"?`
  };
  document.getElementById("confirm-message").textContent = msgs[type];
  openModal("modal-confirm");
}

document.getElementById("btn-confirm-delete").addEventListener("click", async () => {
  const { type, catId, itemIdx } = state.pendingDelete;
  try {
    if (type === "category") {
      await deleteCategoryFromFirestore(catId);
    } else {
      state.catalog[catId].items.splice(itemIdx, 1);
      await saveCategoryToFirestore(catId, state.catalog[catId]);
    }
    await loadCatalog();
    populateCategorySelects();
    renderAdminCatalog();
    closeModal("modal-confirm");
    showToast("Eliminado com sucesso.", "success");
  } catch (e) {
    console.error(e); showToast("Erro ao eliminar.", "error");
  }
});

// ── Admin search/filter ──────────────────────
document.getElementById("admin-search").addEventListener("input", renderAdminCatalog);
document.getElementById("admin-cat-filter").addEventListener("change", renderAdminCatalog);
document.getElementById("btn-seed").addEventListener("click", seedCatalog);

// ═══════════════════════════════════════════
// VIEW: LISTA
// ═══════════════════════════════════════════
async function initListaView() {
  await loadListaDates();
  buildCalendarStrip();

  const input = document.getElementById("lista-date");
  // Set default to today if has list, else most recent
  if (state.listaDates.has(todayStr())) {
    input.value = todayStr();
  } else {
    const sorted = [...state.listaDates].sort().reverse();
    input.value = sorted[0] || todayStr();
  }

  loadListaForDate(input.value);
}

function buildCalendarStrip() {
  const strip = document.getElementById("calendar-strip");
  strip.innerHTML = "";

  // Show last 30 days + next 7
  const today = new Date();
  const days = [];
  for (let i = -30; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d.toISOString().split("T")[0]);
  }

  const dayNames = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];

  days.forEach(dateStr => {
    const d = new Date(dateStr + "T12:00:00");
    const hasLista = state.listaDates.has(dateStr);
    if (!hasLista) return; // Only show days with lists in strip

    const el = document.createElement("div");
    el.className = "cal-day has-list";
    el.dataset.date = dateStr;
    el.innerHTML = `
      <span class="cal-day-label">${dayNames[d.getDay()]}</span>
      <span class="cal-day-num">${d.getDate()}</span>
      <span class="cal-day-dot"></span>
    `;
    el.addEventListener("click", () => {
      document.getElementById("lista-date").value = dateStr;
      loadListaForDate(dateStr);
    });
    strip.appendChild(el);
  });

  if (!strip.children.length) {
    strip.innerHTML = `<span style="color:var(--ink-3);font-size:.85rem;">Nenhuma lista encontrada.</span>`;
  }
}

function updateCalendarStrip(selectedDate) {
  document.querySelectorAll(".cal-day").forEach(el => {
    el.classList.toggle("selected", el.dataset.date === selectedDate);
  });
}

function loadListaForDate(dateStr) {
  document.getElementById("lista-loading").classList.remove("hidden");
  document.getElementById("lista-empty").classList.add("hidden");
  document.getElementById("lista-content").classList.add("hidden");
  document.getElementById("lista-summary").classList.add("hidden");

  updateCalendarStrip(dateStr);
  state.currentListaDate = dateStr;

  // If no list exists for this date, try most recent
  if (!state.listaDates.has(dateStr)) {
    getMostRecentLista().then(data => {
      document.getElementById("lista-loading").classList.add("hidden");
      if (!data) {
        document.getElementById("lista-empty").classList.remove("hidden");
        return;
      }
      // Subscribe to most recent
      subscribeToLista(data.date, renderLista);
    });
    return;
  }

  subscribeToLista(dateStr, listaData => {
    document.getElementById("lista-loading").classList.add("hidden");
    if (!listaData) {
      document.getElementById("lista-empty").classList.remove("hidden");
      return;
    }
    renderLista(listaData);
  });
}

function renderLista(listaData) {
  state.currentLista = listaData;
  const sort = document.getElementById("lista-sort").value;
  const container = document.getElementById("lista-content");
  container.innerHTML = "";

  if (!listaData || !listaData.items || !Object.keys(listaData.items).length) {
    document.getElementById("lista-empty").classList.remove("hidden");
    container.classList.add("hidden");
    return;
  }

  document.getElementById("lista-empty").classList.add("hidden");
  container.classList.remove("hidden");
  document.getElementById("lista-summary").classList.remove("hidden");

  // Group by category
  const byCategory = {};
  Object.entries(listaData.items).forEach(([itemId, item]) => {
    const cat = item.categoria || "Sem categoria";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({ itemId, ...item });
  });

  const sortedCats = Object.entries(byCategory).sort((a, b) =>
    sort === "categoria" ? a[0].localeCompare(b[0]) : a[0].localeCompare(b[0])
  );

  sortedCats.forEach(([catName, items]) => {
    const group = document.createElement("div");
    group.className = "lista-category-group";

    const checked = items.filter(i => i.checked).length;
    group.innerHTML = `
      <div class="lista-cat-header">
        <h3>${catName}</h3>
        <span class="cat-badge">${checked}/${items.length}</span>
      </div>
    `;

    items.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
      const row = document.createElement("div");
      row.className = `lista-item${item.checked ? " checked" : ""}`;
      row.innerHTML = `
        <input type="checkbox" class="item-checkbox" ${item.checked ? "checked" : ""} data-id="${item.itemId}" />
        <span class="item-name">${item.name}</span>
        <div class="item-qty-wrap">
          <input type="number" class="item-qty-input" value="${item.qty}" min="0" step="0.1" data-id="${item.itemId}" />
          <span class="item-unit">${item.unit}</span>
        </div>
      `;

      const checkbox = row.querySelector(".item-checkbox");
      checkbox.addEventListener("change", async () => {
        await updateListaItem(listaData.date, item.itemId, { checked: checkbox.checked });
      });

      const qtyInput = row.querySelector(".item-qty-input");
      let qtyTimer;
      qtyInput.addEventListener("input", () => {
        clearTimeout(qtyTimer);
        qtyTimer = setTimeout(async () => {
          const val = parseFloat(qtyInput.value) || 0;
          await updateListaItem(listaData.date, item.itemId, { qty: val });
        }, 600);
      });

      group.appendChild(row);
    });

    container.appendChild(group);
  });

  updateListaSummary(listaData);
}

function updateListaSummary(listaData) {
  const all = Object.values(listaData.items);
  const checked = all.filter(i => i.checked).length;
  const total = all.length;
  document.getElementById("summary-checked").textContent = checked;
  document.getElementById("summary-total").textContent = total;
  const pct = total ? (checked / total) * 100 : 0;
  document.getElementById("progress-fill").style.width = `${pct}%`;
}

document.getElementById("lista-date").addEventListener("change", e => {
  loadListaForDate(e.target.value);
});
document.getElementById("lista-sort").addEventListener("change", () => {
  if (state.currentLista) renderLista(state.currentLista);
});

// ═══════════════════════════════════════════
// VIEW: GERAR
// ═══════════════════════════════════════════
let gerarSelections = new Set(); // set of "catId|itemIndex"

async function initGerarView() {
  await loadCatalog();
  populateCategorySelects();
  gerarSelections.clear();
  updateGerarCount();

  // Default date = today, min = today
  const input = document.getElementById("gerar-date");
  const today = todayStr();
  input.value = today;
  input.min = today;

  renderGerarCatalog();
}

function getGerarFilters() {
  const search = document.getElementById("gerar-search").value.toLowerCase().trim();
  const cat    = document.getElementById("gerar-cat-filter").value;
  return { search, cat };
}

function renderGerarCatalog() {
  const { search, cat } = getGerarFilters();
  const container = document.getElementById("gerar-catalog");
  container.innerHTML = "";

  const cats = Object.entries(state.catalog)
    .filter(([id]) => !cat || id === cat)
    .sort((a, b) => a[1].nome.localeCompare(b[1].nome));

  if (!cats.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><p>Nenhum produto encontrado.</p></div>`;
    return;
  }

  cats.forEach(([catId, catData]) => {
    const filteredItems = catData.items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => !search || item.name.toLowerCase().includes(search));

    if (!filteredItems.length) return;

    const group = document.createElement("div");
    group.className = "gerar-cat-group";

    const header = document.createElement("div");
    header.className = "gerar-cat-header";
    header.innerHTML = `<h3>${catData.nome}</h3><span class="gerar-cat-toggle">▾</span>`;
    header.addEventListener("click", () => {
      header.classList.toggle("collapsed");
      grid.style.display = header.classList.contains("collapsed") ? "none" : "grid";
    });
    group.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "gerar-items-grid";

    filteredItems.forEach(({ item, i }) => {
      const key = `${catId}|${i}`;
      const isSelected = gerarSelections.has(key);

      const el = document.createElement("div");
      el.className = `gerar-item${isSelected ? " selected" : ""}`;
      el.innerHTML = `
        <input type="checkbox" ${isSelected ? "checked" : ""} data-key="${key}" />
        <div class="gerar-item-info">
          <div class="gerar-item-name">${item.name}</div>
          <div class="gerar-item-meta">${item.defaultQty} ${item.unit}</div>
        </div>
      `;

      const cb = el.querySelector("input");
      const toggle = () => {
        if (cb.checked) { gerarSelections.add(key); el.classList.add("selected"); }
        else { gerarSelections.delete(key); el.classList.remove("selected"); }
        updateGerarCount();
        updateSelectAllState();
      };
      cb.addEventListener("change", toggle);
      el.addEventListener("click", e => {
        if (e.target !== cb) { cb.checked = !cb.checked; toggle(); }
      });

      grid.appendChild(el);
    });

    group.appendChild(grid);
    container.appendChild(group);
  });

  updateSelectAllState();
}

function updateGerarCount() {
  const n = gerarSelections.size;
  document.getElementById("gerar-count").textContent = `${n} produto${n !== 1 ? "s" : ""} seleccionado${n !== 1 ? "s" : ""}`;
  document.getElementById("btn-create-list").disabled = n === 0;
}

function updateSelectAllState() {
  const allCbs = document.querySelectorAll("#gerar-catalog input[type=checkbox]");
  const allChecked = allCbs.length > 0 && [...allCbs].every(cb => cb.checked);
  document.getElementById("gerar-select-all").checked = allChecked;
}

document.getElementById("gerar-select-all").addEventListener("change", e => {
  const checked = e.target.checked;
  document.querySelectorAll("#gerar-catalog input[type=checkbox]").forEach(cb => {
    const key = cb.dataset.key;
    cb.checked = checked;
    const el = cb.closest(".gerar-item");
    if (checked) { gerarSelections.add(key); el?.classList.add("selected"); }
    else { gerarSelections.delete(key); el?.classList.remove("selected"); }
  });
  updateGerarCount();
});

document.getElementById("gerar-search").addEventListener("input", renderGerarCatalog);
document.getElementById("gerar-cat-filter").addEventListener("change", renderGerarCatalog);

// Enforce min date
document.getElementById("gerar-date").addEventListener("change", e => {
  if (e.target.value < todayStr()) {
    e.target.value = todayStr();
    showToast("Não é possível seleccionar uma data passada.", "error");
  }
});

document.getElementById("btn-create-list").addEventListener("click", async () => {
  const dateStr = document.getElementById("gerar-date").value;
  if (!dateStr) return showToast("Seleccione uma data.", "error");
  if (dateStr < todayStr()) return showToast("Data inválida.", "error");
  if (!gerarSelections.size) return showToast("Seleccione pelo menos um produto.", "error");

  const btn = document.getElementById("btn-create-list");
  btn.disabled = true;
  btn.querySelector("span").textContent = "A criar…";

  try {
    const items = {};
    gerarSelections.forEach(key => {
      const [catId, idxStr] = key.split("|");
      const idx = parseInt(idxStr);
      const catData = state.catalog[catId];
      if (!catData) return;
      const item = catData.items[idx];
      const itemId = generateItemId(catId, item.name);
      items[itemId] = {
        name:      item.name,
        qty:       item.defaultQty,
        unit:      item.unit,
        checked:   false,
        categoria: catData.nome
      };
    });

    await saveNewLista(dateStr, items);
    state.listaDates.add(dateStr);
    showToast(`Lista para ${formatDatePT(dateStr)} criada!`, "success");

    // Switch to Lista view on that date
    setTimeout(() => {
      document.getElementById("lista-date").value = dateStr;
      switchView("lista");
    }, 800);
  } catch (e) {
    console.error(e);
    showToast("Erro ao criar lista.", "error");
    btn.disabled = false;
    btn.querySelector("span").textContent = "Criar Lista";
  }
});

// ═══════════════════════════════════════════
// MODAL CLOSE (generic)
// ═══════════════════════════════════════════
document.querySelectorAll(".modal-close, [data-modal]").forEach(el => {
  el.addEventListener("click", () => closeModal(el.dataset.modal));
});
document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// ═══════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════
(async () => {
  try {
    // Start on Lista view
    await loadCatalog();
    await loadListaDates();
    switchView("lista");
  } catch (e) {
    console.error("Erro de inicialização:", e);
    // Show a user-friendly error if Firebase is not configured
    if (e.message && (e.message.includes("projectId") || e.message.includes("API key") || e.message.includes("YOUR_"))) {
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;background:#F5F3EE;">
          <div style="max-width:480px;">
            <div style="font-size:3rem;margin-bottom:16px;">🔥</div>
            <h2 style="font-family:Syne,sans-serif;margin-bottom:12px;">Firebase não configurado</h2>
            <p style="color:#4A453F;margin-bottom:16px;">Edite o ficheiro <code style="background:#E2DDD5;padding:2px 6px;border-radius:4px;">firebase.js</code> e substitua os valores de <code>YOUR_*</code> pelas credenciais do seu projecto Firebase.</p>
            <p style="color:#8C857A;font-size:.875rem;">Consulte a <a href="https://firebase.google.com/docs/web/setup" target="_blank" style="color:#2D6A4F;">documentação do Firebase</a> para obter as suas credenciais.</p>
          </div>
        </div>
      `;
    }
  }
})();