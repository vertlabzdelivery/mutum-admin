const API_BASE_URL = window.__API_BASE_URL__ || '';
const STORAGE_KEYS = {
  token: 'admin_panel_access_token',
  refresh: 'admin_panel_refresh_token',
  user: 'admin_panel_user',
  created: 'admin_panel_created_accounts',
};

const state = {
  accessToken: localStorage.getItem(STORAGE_KEYS.token) || '',
  refreshToken: localStorage.getItem(STORAGE_KEYS.refresh) || '',
  currentUser: readJson(STORAGE_KEYS.user, null),
  createdAccounts: readJson(STORAGE_KEYS.created, []),
  states: [],
  restaurants: [],
  citiesByState: new Map(),
  neighborhoodsByCity: new Map(),
  billingReport: null,
};

function readJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

function extractResolvedRole(...sources) {
  for (const source of sources) {
    const role = source?.role ?? source?.user?.role ?? source?.data?.role ?? source?.data?.user?.role;
    const normalized = normalizeRole(role);
    if (normalized) return normalized;
  }
  return '';
}


function setStatus(message, isError = false) {
  const box = document.getElementById('statusBox');
  if (!box) return;
  box.textContent = message;
  box.style.color = isError ? '#b31413' : '#2e2b28';
  box.style.borderColor = isError ? 'rgba(221,28,26,.35)' : '#f2d998';
  box.style.background = isError ? '#fff0ef' : '#fff6dc';
}

async function apiRequest(method, path, body, auth = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;

  const proxyBase =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
      ? '/proxy'
      : '/api/proxy';

  const proxyUrl = `${proxyBase}?path=${encodeURIComponent(path)}`;
  const response = await fetch(proxyUrl, {
    method,
    headers: {
      ...headers,
      'x-target-base-url': API_BASE_URL,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const payload = data && typeof data === 'object' && data.data !== undefined ? data.data : data;

  if (!response.ok) {
    const message = payload?.message || data?.message || `Erro ${response.status}`;
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return payload;
}

function persistAuth(auth) {
  state.accessToken = auth.accessToken || '';
  state.refreshToken = auth.refreshToken || '';
  state.currentUser = auth.user || null;
  localStorage.setItem(STORAGE_KEYS.token, state.accessToken);
  localStorage.setItem(STORAGE_KEYS.refresh, state.refreshToken);
  saveJson(STORAGE_KEYS.user, state.currentUser);
}

function clearAuth() {
  state.accessToken = '';
  state.refreshToken = '';
  state.currentUser = null;
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.refresh);
  localStorage.removeItem(STORAGE_KEYS.user);
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const template = document.getElementById(state.currentUser ? 'dashboardTemplate' : 'loginTemplate');
  app.appendChild(template.content.cloneNode(true));
  if (state.currentUser) initDashboard(); else initLogin();
}

function initLogin() {
  const form = document.getElementById('loginForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('loginError');
    errorEl.classList.add('hidden');
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const auth = await apiRequest('POST', '/auth/login', body);
      persistAuth(auth);
      const me = await apiRequest('GET', '/auth/me', null, true);
      const resolvedRole = extractResolvedRole(me, auth, state.currentUser);
      if (resolvedRole !== 'ADMIN') {
        clearAuth();
        errorEl.textContent = 'Somente contas ADMIN podem entrar neste painel.';
        errorEl.classList.remove('hidden');
        return;
      }
      state.currentUser = { ...(typeof auth === 'object' ? auth : {}), ...(auth?.user || {}), ...(typeof me === 'object' ? me : {}), ...(me?.user || {}), role: resolvedRole };
      saveJson(STORAGE_KEYS.user, state.currentUser);
      render();
    } catch (error) {
      errorEl.textContent = error.message || 'Não foi possível entrar.';
      errorEl.classList.remove('hidden');
    }
  });
}

async function initDashboard() {
  document.getElementById('adminBadge').textContent = `${state.currentUser.name} • ADMIN`;
  document.getElementById('logoutBtn').addEventListener('click', () => { clearAuth(); render(); });
  document.getElementById('clearCreatedUsers').addEventListener('click', () => {
    state.createdAccounts = [];
    saveJson(STORAGE_KEYS.created, state.createdAccounts);
    renderCreatedAccounts();
    renderSummary();
  });
  document.getElementById('useLastOwnerBtn').addEventListener('click', () => {
    const last = state.createdAccounts[0];
    if (!last?.user?.id) return;
    document.getElementById('restaurantOwnerId').value = last.user.id;
  });

  bindForms();
  renderCreatedAccounts();
  renderSummary();
  renderBillingReport(null);
  await loadInitialData();
}

function bindForms() {
  document.getElementById('restaurantAccountForm').addEventListener('submit', handleRestaurantAccountCreate);
  document.getElementById('restaurantForm').addEventListener('submit', handleRestaurantCreate);
  document.getElementById('stateForm').addEventListener('submit', handleStateCreate);
  document.getElementById('cityForm').addEventListener('submit', handleCityCreate);
  document.getElementById('neighborhoodForm').addEventListener('submit', handleNeighborhoodCreate);
  document.getElementById('billingFilterForm').addEventListener('submit', handleGenerateBillingReport);
  document.getElementById('billingExportCsvBtn').addEventListener('click', exportBillingCsv);
  document.getElementById('billingExportPdfBtn').addEventListener('click', exportBillingPdf);
  document.getElementById('billingSaveCycleBtn').addEventListener('click', saveBillingCycle);

  document.getElementById('restaurantAccountState').addEventListener('change', (e) => populateCities('restaurantAccountCity', e.target.value));
  document.getElementById('restaurantState').addEventListener('change', (e) => populateCities('restaurantCity', e.target.value));
  document.getElementById('cityStateSelect').addEventListener('change', (e) => renderCitiesList(e.target.value));
  document.getElementById('neighborhoodStateSelect').addEventListener('change', async (e) => {
    await populateCities('neighborhoodCitySelect', e.target.value);
    renderNeighborhoodsList(document.getElementById('neighborhoodCitySelect').value);
  });
  document.getElementById('neighborhoodCitySelect').addEventListener('change', (e) => renderNeighborhoodsList(e.target.value));
}

async function loadInitialData() {
  await Promise.all([loadStates(), loadRestaurants()]);
  applyBillingDefaults();
}

function applyBillingDefaults() {
  const startInput = document.getElementById('billingStartDate');
  const endInput = document.getElementById('billingEndDate');
  const commissionInput = document.getElementById('billingCommissionPercent');
  const dueDateInput = document.getElementById('billingDueDate');
  if (!startInput || !endInput) return;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  startInput.value = toInputDate(firstDay);
  endInput.value = toInputDate(lastDay);
  if (commissionInput && !commissionInput.value) commissionInput.value = '7';
  if (dueDateInput && !dueDateInput.value) dueDateInput.value = toInputDate(new Date(year, month + 1, 5));
}

async function handleRestaurantAccountCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  if (!body.cityId) delete body.cityId;
  try {
    const result = await apiRequest('POST', '/auth/register-restaurant', body);
    const entry = { createdAt: new Date().toISOString(), user: result.user, restaurant: result.restaurant };
    state.createdAccounts.unshift(entry);
    state.createdAccounts = state.createdAccounts.slice(0, 12);
    saveJson(STORAGE_KEYS.created, state.createdAccounts);
    form.reset();
    setStatus('Conta RESTAURANT criada com sucesso.');
    renderCreatedAccounts();
    renderSummary();
    await loadRestaurants();
  } catch (error) {
    setStatus(error.message || 'Erro ao criar conta restaurante.', true);
  }
}

async function handleRestaurantCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  if (!body.cityId) delete body.cityId;
  if (!body.description) delete body.description;
  if (!body.logoUrl) delete body.logoUrl;
  if (!body.phone) delete body.phone;
  if (!body.minOrder) delete body.minOrder; else body.minOrder = Number(body.minOrder);
  try {
    const result = await apiRequest('POST', '/restaurants', body, true);
    setStatus(`Restaurante ${result.name || ''} criado com sucesso.`);
    form.reset();
    renderSummary(result);
    await loadRestaurants();
  } catch (error) {
    setStatus(error.message || 'Erro ao criar restaurante.', true);
  }
}

async function handleStateCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  body.code = String(body.code || '').toUpperCase();
  try {
    await apiRequest('POST', '/locations/states', body, true);
    form.reset();
    setStatus('Estado criado com sucesso.');
    await loadStates();
  } catch (error) {
    setStatus(error.message || 'Erro ao criar estado.', true);
  }
}

async function handleCityCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    await apiRequest('POST', '/locations/cities', body, true);
    form.reset();
    setStatus('Cidade criada com sucesso.');
    await loadStates();
    if (body.stateId) renderCitiesList(body.stateId);
  } catch (error) {
    setStatus(error.message || 'Erro ao criar cidade.', true);
  }
}

async function handleNeighborhoodCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    await apiRequest('POST', '/locations/neighborhoods', body, true);
    form.reset();
    setStatus('Bairro criado com sucesso.');
    if (body.cityId) await renderNeighborhoodsList(body.cityId);
  } catch (error) {
    setStatus(error.message || 'Erro ao criar bairro.', true);
  }
}

async function loadStates() {
  try {
    state.states = await apiRequest('GET', '/locations/states');
    populateStateSelects();
    renderStatesList();
    const firstStateId = state.states[0]?.id || '';
    if (firstStateId) {
      document.getElementById('restaurantAccountState').value = firstStateId;
      document.getElementById('restaurantState').value = firstStateId;
      document.getElementById('cityStateSelect').value = firstStateId;
      document.getElementById('neighborhoodStateSelect').value = firstStateId;
      await populateCities('restaurantAccountCity', firstStateId);
      await populateCities('restaurantCity', firstStateId);
      await populateCities('neighborhoodCitySelect', firstStateId);
      await renderCitiesList(firstStateId);
      await renderNeighborhoodsList(document.getElementById('neighborhoodCitySelect').value);
    }
    renderSummary();
  } catch (error) {
    setStatus(error.message || 'Erro ao carregar estados.', true);
  }
}

async function loadRestaurants() {
  try {
    const restaurants = await apiRequest('GET', '/restaurants', null, true);
    state.restaurants = Array.isArray(restaurants) ? restaurants : [];
    populateRestaurantSelect();
  } catch (error) {
    state.restaurants = [];
    populateRestaurantSelect();
    setStatus(error.message || 'Erro ao carregar restaurantes.', true);
  }
}

function populateRestaurantSelect() {
  const select = document.getElementById('billingRestaurantId');
  if (!select) return;
  select.innerHTML = ['<option value="">Selecione um restaurante</option>']
    .concat(state.restaurants.map((restaurant) => `<option value="${restaurant.id}">${escapeHtml(restaurant.name)}</option>`))
    .join('');
}

function populateStateSelects() {
  const selects = ['restaurantAccountState', 'restaurantState', 'cityStateSelect', 'neighborhoodStateSelect'];
  selects.forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = state.states.map((item) => `<option value="${item.id}">${item.name} • ${item.code}</option>`).join('');
  });
}

async function populateCities(selectId, stateId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  if (!stateId) { select.innerHTML = '<option value="">Selecione</option>'; return []; }
  let cities = state.citiesByState.get(stateId);
  if (!cities) {
    cities = await apiRequest('GET', `/locations/states/${stateId}/cities`);
    state.citiesByState.set(stateId, cities);
  }
  select.innerHTML = ['<option value="">Selecione</option>']
    .concat(cities.map((city) => `<option value="${city.id}">${escapeHtml(city.name)}</option>`))
    .join('');
  return cities;
}

function renderStatesList() {
  const el = document.getElementById('statesList');
  el.innerHTML = state.states.length
    ? state.states.map((item) => `<div class="list-item"><strong>${escapeHtml(item.name)}</strong><span class="tag">${escapeHtml(item.code)}</span></div>`).join('')
    : '<div class="empty-state">Nenhum estado encontrado.</div>';
}

async function renderCitiesList(stateId) {
  const el = document.getElementById('citiesList');
  if (!stateId) { el.innerHTML = '<div class="empty-state">Selecione um estado.</div>'; return; }
  let resolved = state.citiesByState.get(stateId);
  if (!resolved) {
    try {
      resolved = await apiRequest('GET', `/locations/states/${stateId}/cities`);
      state.citiesByState.set(stateId, resolved);
    } catch {
      resolved = [];
    }
  }
  el.innerHTML = resolved.length
    ? resolved.map((item) => `<div class="list-item"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(findStateName(stateId))}</small></div>`).join('')
    : '<div class="empty-state">Nenhuma cidade neste estado.</div>';
}

async function renderNeighborhoodsList(cityId) {
  const el = document.getElementById('neighborhoodsList');
  if (!cityId) { el.innerHTML = '<div class="empty-state">Selecione uma cidade.</div>'; return; }
  let neighborhoods = state.neighborhoodsByCity.get(cityId);
  if (!neighborhoods) {
    neighborhoods = await apiRequest('GET', `/locations/cities/${cityId}/neighborhoods`);
    state.neighborhoodsByCity.set(cityId, neighborhoods);
  }
  el.innerHTML = neighborhoods.length
    ? neighborhoods.map((item) => `<div class="list-item"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(findCityName(cityId))}</small></div>`).join('')
    : '<div class="empty-state">Nenhum bairro nesta cidade.</div>';
}

function findStateName(stateId) {
  return state.states.find((item) => item.id === stateId)?.name || 'Estado';
}
function findCityName(cityId) {
  for (const cities of state.citiesByState.values()) {
    const city = cities.find((item) => item.id === cityId);
    if (city) return city.name;
  }
  return 'Cidade';
}

function renderCreatedAccounts() {
  const el = document.getElementById('createdUsersList');
  if (!el) return;
  if (!state.createdAccounts.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma conta criada ainda.</div>';
    return;
  }
  el.innerHTML = state.createdAccounts.map((entry) => {
    const date = new Date(entry.createdAt).toLocaleString('pt-BR');
    return `
      <div class="created-item">
        <strong>${escapeHtml(entry.user?.name || 'Usuário')} • ${escapeHtml(entry.user?.email || '')}</strong>
        <div class="copy-row">
          <span class="copy-chip">ownerId: ${escapeHtml(entry.user?.id || '-')}</span>
          <button class="btn-link" type="button" data-copy="${escapeAttribute(entry.user?.id || '')}">Copiar ID</button>
          <button class="btn-link" type="button" data-use-owner="${escapeAttribute(entry.user?.id || '')}">Usar</button>
        </div>
        <div class="copy-row">
          <span class="tag">Restaurante: ${escapeHtml(entry.restaurant?.name || '-')}</span>
          <span class="tag">Criado em ${escapeHtml(date)}</span>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(btn.dataset.copy || '');
    setStatus('ID copiado.');
  }));
  el.querySelectorAll('[data-use-owner]').forEach((btn) => btn.addEventListener('click', () => {
    document.getElementById('restaurantOwnerId').value = btn.dataset.useOwner || '';
    setStatus('ownerId preenchido no formulário de restaurante.');
  }));
}

function renderSummary(lastRestaurant) {
  const el = document.getElementById('summaryCards');
  if (!el) return;
  const latestUser = state.createdAccounts[0]?.user;
  const latestRestaurant = lastRestaurant || state.createdAccounts[0]?.restaurant;
  el.innerHTML = [
    { title: 'Usuário RESTAURANT recente', text: latestUser ? `${latestUser.name} • ${latestUser.id}` : 'Nenhum criado ainda.' },
    { title: 'Restaurante recente', text: latestRestaurant ? `${latestRestaurant.name} • ${latestRestaurant.id}` : 'Nenhum restaurante recente.' },
    { title: 'Restaurantes cadastrados', text: `${state.restaurants.length} restaurante(s) na base.` },
  ].map((item) => `<div class="summary-item"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div>`).join('');
}

async function handleGenerateBillingReport(event) {
  event.preventDefault();
  const restaurantId = document.getElementById('billingRestaurantId').value;
  const startDate = document.getElementById('billingStartDate').value;
  const endDate = document.getElementById('billingEndDate').value;
  const commissionPercent = Number(document.getElementById('billingCommissionPercent').value || 7);

  if (!restaurantId) {
    setStatus('Selecione um restaurante para gerar o faturamento.', true);
    return;
  }

  try {
    setStatus('Gerando relatório de faturamento...');
    const query = new URLSearchParams({
      restaurantId,
      startDate,
      endDate,
      commissionPercent: String(commissionPercent),
    });
    state.billingReport = await apiRequest('GET', `/billing/report?${query.toString()}`, null, true);
    renderBillingReport(state.billingReport);
    setStatus('Relatório de faturamento gerado com sucesso.');
  } catch (error) {
    renderBillingReport(null);
    setStatus(error.message || 'Erro ao gerar relatório de faturamento.', true);
  }
}

function renderBillingReport(report) {
  const bodyEl = document.getElementById('billingReportBody');
  const cardsEl = document.getElementById('billingSummaryCards');
  const metaEl = document.getElementById('billingReportMeta');
  const actionsEl = document.getElementById('billingReportActions');
  if (!bodyEl || !cardsEl || !metaEl || !actionsEl) return;

  if (!report) {
    metaEl.innerHTML = '<p class="muted">Escolha o restaurante e o período para ver o fechamento com taxa de 7% ou a taxa que você informar.</p>';
    cardsEl.innerHTML = '';
    bodyEl.innerHTML = '<tr><td colspan="9" class="empty-cell">Nenhum relatório carregado.</td></tr>';
    actionsEl.classList.add('hidden');
    return;
  }

  const start = formatDateTime(report.period.startDate, false);
  const end = formatDateTime(report.period.endDate, false);
  metaEl.innerHTML = `
    <div class="billing-meta-grid">
      <div><strong>Restaurante</strong><span>${escapeHtml(report.restaurant.name)}</span></div>
      <div><strong>Período</strong><span>${escapeHtml(start)} até ${escapeHtml(end)}</span></div>
      <div><strong>Taxa aplicada</strong><span>${Number(report.commission.percent).toFixed(2)}%</span></div>
    </div>`;

  cardsEl.innerHTML = [
    ['Pedidos totais', String(report.totals.totalOrders)],
    ['Pedidos faturáveis', String(report.totals.billableOrders)],
    ['Cancelados', String(report.totals.canceledOrders)],
    ['Total válido', formatMoney(report.totals.grossSales)],
    ['Cancelados descontados', formatMoney(report.totals.canceledSales)],
    ['Sua taxa', formatMoney(report.commission.amount)],
    ['Líquido do restaurante', formatMoney(report.totals.netSalesAfterCommission)],
  ].map(([title, value]) => `<div class="summary-item summary-item-accent"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(value)}</p></div>`).join('');

  bodyEl.innerHTML = report.orders.length
    ? report.orders.map((order) => `
      <tr>
        <td>${order.line}</td>
        <td><strong>#${escapeHtml(String(order.id).slice(0, 8))}</strong><br><small>${escapeHtml(formatDateTime(order.createdAt))}</small></td>
        <td>${escapeHtml(order.customerName || '-')}</td>
        <td>${escapeHtml(statusLabel(order.status))}</td>
        <td>${escapeHtml(paymentLabel(order.paymentMethod))}</td>
        <td>${formatMoney(order.total)}</td>
        <td>${order.isCanceled ? '<span class="pill-flag danger">Sim</span>' : '<span class="pill-flag success">Não</span>'}</td>
        <td>${formatMoney(order.commissionBase)}</td>
        <td>${formatMoney(order.commissionAmount)}</td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="empty-cell">Nenhum pedido no período informado.</td></tr>';

  actionsEl.classList.remove('hidden');
}

async function saveBillingCycle() {
  if (!state.billingReport) {
    setStatus('Gere o relatório antes de salvar o fechamento.', true);
    return;
  }

  const dueDate = document.getElementById('billingDueDate').value;
  const notes = document.getElementById('billingNotes').value;
  try {
    setStatus('Salvando fechamento no backend...');
    const payload = {
      restaurantId: state.billingReport.restaurant.id,
      startDate: document.getElementById('billingStartDate').value,
      endDate: document.getElementById('billingEndDate').value,
      commissionPercent: Number(document.getElementById('billingCommissionPercent').value || 7),
      dueDate: dueDate || undefined,
      notes: notes || undefined,
    };
    const cycle = await apiRequest('POST', '/billing/cycles/save', payload, true);
    setStatus(`Fechamento salvo com sucesso. Ciclo ${cycle.id.slice(0, 8)} criado/atualizado.`);
  } catch (error) {
    setStatus(error.message || 'Erro ao salvar fechamento.', true);
  }
}

function exportBillingCsv() {
  if (!state.billingReport) {
    setStatus('Gere o relatório antes de exportar.', true);
    return;
  }

  const rows = [
    ['Restaurante', state.billingReport.restaurant.name],
    ['Período inicial', formatDateTime(state.billingReport.period.startDate, false)],
    ['Período final', formatDateTime(state.billingReport.period.endDate, false)],
    ['Taxa (%)', Number(state.billingReport.commission.percent).toFixed(2)],
    ['Pedidos totais', state.billingReport.totals.totalOrders],
    ['Pedidos faturáveis', state.billingReport.totals.billableOrders],
    ['Pedidos cancelados', state.billingReport.totals.canceledOrders],
    ['Total válido', state.billingReport.totals.grossSales],
    ['Cancelados descontados', state.billingReport.totals.canceledSales],
    ['Sua taxa', state.billingReport.commission.amount],
    ['Líquido restaurante', state.billingReport.totals.netSalesAfterCommission],
    [],
    ['Linha', 'Pedido', 'Data', 'Cliente', 'Status', 'Pagamento', 'Total', 'Cancelado', 'Base comissão', 'Valor comissão'],
    ...state.billingReport.orders.map((order) => [
      order.line,
      order.id,
      formatDateTime(order.createdAt),
      order.customerName || '',
      statusLabel(order.status),
      paymentLabel(order.paymentMethod),
      order.total,
      order.isCanceled ? 'Sim' : 'Não',
      order.commissionBase,
      order.commissionAmount,
    ]),
  ];

  downloadCsv(rows, `faturamento-${slugify(state.billingReport.restaurant.name)}-${document.getElementById('billingStartDate').value}-${document.getElementById('billingEndDate').value}.csv`);
  setStatus('Planilha CSV gerada com sucesso.');
}

function exportBillingPdf() {
  if (!state.billingReport) {
    setStatus('Gere o relatório antes de exportar.', true);
    return;
  }

  const report = state.billingReport;
  const win = window.open('', '_blank', 'width=1080,height=820');
  if (!win) {
    setStatus('O navegador bloqueou a janela de impressão. Libere pop-up para gerar PDF.', true);
    return;
  }

  const rows = report.orders.map((order) => `
    <tr>
      <td>${order.line}</td>
      <td>#${escapeHtml(String(order.id).slice(0, 8))}</td>
      <td>${escapeHtml(formatDateTime(order.createdAt))}</td>
      <td>${escapeHtml(order.customerName || '-')}</td>
      <td>${escapeHtml(statusLabel(order.status))}</td>
      <td>${formatMoney(order.total)}</td>
      <td>${order.isCanceled ? 'Sim' : 'Não'}</td>
      <td>${formatMoney(order.commissionAmount)}</td>
    </tr>`).join('');

  win.document.write(`<!doctype html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Faturamento • ${escapeHtml(report.restaurant.name)}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #231f20; padding: 28px; }
      h1 { margin: 0 0 8px; }
      .muted { color: #666; }
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 18px 0 22px; }
      .card { border: 1px solid #ddd; border-radius: 12px; padding: 12px; }
      table { width: 100%; border-collapse: collapse; margin-top: 18px; }
      th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; text-align: left; }
      th { background: #f7efe6; }
      .totals { margin-top: 22px; display: grid; gap: 6px; }
    </style>
  </head>
  <body>
    <h1>Fechamento de faturamento</h1>
    <p class="muted">Restaurante: ${escapeHtml(report.restaurant.name)} • Período: ${escapeHtml(formatDateTime(report.period.startDate, false))} até ${escapeHtml(formatDateTime(report.period.endDate, false))}</p>
    <div class="grid">
      <div class="card"><strong>Pedidos totais</strong><div>${report.totals.totalOrders}</div></div>
      <div class="card"><strong>Pedidos faturáveis</strong><div>${report.totals.billableOrders}</div></div>
      <div class="card"><strong>Cancelados</strong><div>${report.totals.canceledOrders}</div></div>
      <div class="card"><strong>Total válido</strong><div>${formatMoney(report.totals.grossSales)}</div></div>
      <div class="card"><strong>Taxa aplicada</strong><div>${Number(report.commission.percent).toFixed(2)}%</div></div>
      <div class="card"><strong>Valor da taxa</strong><div>${formatMoney(report.commission.amount)}</div></div>
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th><th>Pedido</th><th>Data</th><th>Cliente</th><th>Status</th><th>Total</th><th>Cancelado</th><th>Comissão</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="8">Nenhum pedido no período.</td></tr>'}</tbody>
    </table>
    <div class="totals">
      <strong>Cancelados descontados: ${formatMoney(report.totals.canceledSales)}</strong>
      <strong>Líquido do restaurante: ${formatMoney(report.totals.netSalesAfterCommission)}</strong>
    </div>
  </body>
  </html>`);
  win.document.close();
  win.focus();
  win.print();
  setStatus('Janela de impressão aberta. Salve como PDF no navegador.');
}

function formatMoney(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
}

function formatDateTime(value, withTime = true) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    ...(withTime ? { timeStyle: 'short' } : {}),
  }).format(date);
}

function paymentLabel(value) {
  return {
    CASH: 'Dinheiro',
    PIX: 'PIX',
    CREDIT_CARD: 'Cartão crédito',
    DEBIT_CARD: 'Cartão débito',
  }[value] || value || '-';
}

function statusLabel(value) {
  return {
    PENDING: 'Pendente',
    ACCEPTED: 'Aceito',
    PREPARING: 'Em preparo',
    DELIVERY: 'Saiu para entrega',
    DELIVERED: 'Entregue',
    CANCELED: 'Cancelado',
  }[value] || value || '-';
}

function downloadCsv(rows, filename) {
  const content = rows.map((row) => row.map(csvEscape).join(';')).join('\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[,;"\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function slugify(value) {
  return String(value || 'restaurante')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'restaurante';
}

function toInputDate(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

(async function boot() {
  if (state.currentUser && state.accessToken) {
    try {
      const me = await apiRequest('GET', '/auth/me', null, true);
      const resolvedRole = me?.role || me?.user?.role || state.currentUser?.role;
      if (resolvedRole !== 'ADMIN') throw new Error('Somente ADMIN pode usar este painel.');
      state.currentUser = { ...(typeof auth === 'object' ? auth : {}), ...(auth?.user || {}), ...(typeof me === 'object' ? me : {}), ...(me?.user || {}), role: resolvedRole };
      saveJson(STORAGE_KEYS.user, state.currentUser);
    } catch {
      clearAuth();
    }
  }
  render();
})();
