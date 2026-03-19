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
  citiesByState: new Map(),
  neighborhoodsByCity: new Map(),
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

  const response = await fetch(`/api/proxy${path}`, {
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
      if (me.role !== 'ADMIN') {
        clearAuth();
        errorEl.textContent = 'Somente contas ADMIN podem entrar neste painel.';
        errorEl.classList.remove('hidden');
        return;
      }
      state.currentUser = me;
      saveJson(STORAGE_KEYS.user, me);
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
  await loadStates();
}

function bindForms() {
  document.getElementById('restaurantAccountForm').addEventListener('submit', handleRestaurantAccountCreate);
  document.getElementById('restaurantForm').addEventListener('submit', handleRestaurantCreate);
  document.getElementById('stateForm').addEventListener('submit', handleStateCreate);
  document.getElementById('cityForm').addEventListener('submit', handleCityCreate);
  document.getElementById('neighborhoodForm').addEventListener('submit', handleNeighborhoodCreate);

  document.getElementById('restaurantAccountState').addEventListener('change', (e) => populateCities('restaurantAccountCity', e.target.value));
  document.getElementById('restaurantState').addEventListener('change', (e) => populateCities('restaurantCity', e.target.value));
  document.getElementById('cityStateSelect').addEventListener('change', (e) => renderCitiesList(e.target.value));
  document.getElementById('neighborhoodStateSelect').addEventListener('change', async (e) => {
    await populateCities('neighborhoodCitySelect', e.target.value);
    renderNeighborhoodsList(document.getElementById('neighborhoodCitySelect').value);
  });
  document.getElementById('neighborhoodCitySelect').addEventListener('change', (e) => renderNeighborhoodsList(e.target.value));
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
  } catch (error) {
    setStatus(error.message || 'Erro ao carregar estados.', true);
  }
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
  select.innerHTML = ['<option value="">Selecione</option>'].concat(cities.map((city) => `<option value="${city.id}">${city.name}</option>`)).join('');
  return cities;
}


function renderStatesList() {
  const el = document.getElementById('statesList');
  el.innerHTML = state.states.length
    ? state.states.map((item) => `<div class="list-item"><strong>${item.name}</strong><span class="tag">${item.code}</span></div>`).join('')
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
    ? resolved.map((item) => `<div class="list-item"><strong>${item.name}</strong><small>${findStateName(stateId)}</small></div>`).join('')
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
    ? neighborhoods.map((item) => `<div class="list-item"><strong>${item.name}</strong><small>${findCityName(cityId)}</small></div>`).join('')
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
  el.innerHTML = state.createdAccounts.map((entry, index) => {
    const date = new Date(entry.createdAt).toLocaleString('pt-BR');
    return `
      <div class="created-item">
        <strong>${entry.user?.name || 'Usuário'} • ${entry.user?.email || ''}</strong>
        <div class="copy-row">
          <span class="copy-chip">ownerId: ${entry.user?.id || '-'}</span>
          <button class="btn-link" type="button" data-copy="${entry.user?.id || ''}">Copiar ID</button>
          <button class="btn-link" type="button" data-use-owner="${entry.user?.id || ''}">Usar</button>
        </div>
        <div class="copy-row">
          <span class="tag">Restaurante: ${entry.restaurant?.name || '-'}</span>
          <span class="tag">Criado em ${date}</span>
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
    { title: 'Estados carregados', text: `${state.states.length} estado(s) disponíveis.` },
  ].map((item) => `<div class="summary-item"><strong>${item.title}</strong><p>${item.text}</p></div>`).join('');
}

(async function boot() {
  if (state.currentUser && state.accessToken) {
    try {
      const me = await apiRequest('GET', '/auth/me', null, true);
      if (me.role !== 'ADMIN') throw new Error('Somente ADMIN pode usar este painel.');
      state.currentUser = me;
      saveJson(STORAGE_KEYS.user, me);
    } catch {
      clearAuth();
    }
  }
  render();
})();
