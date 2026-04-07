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
  activePage: 'inicio',
  states: [],
  restaurants: [],
  storeCategories: [],
  promotionalCoupons: [],
  citiesByState: new Map(),
  neighborhoodsByCity: new Map(),
  appMetrics: null,
};

function setBooting(isBooting, message = 'Preparando painel...') {
  document.body.classList.toggle('app-booting', isBooting);
  document.getElementById('bootSplash')?.classList.toggle('hidden', !isBooting);
  const label = document.getElementById('bootSplashText');
  if (label) label.textContent = message;
}

function setGlobalLoading(isLoading, message = 'Aguarde um instante...') {
  document.getElementById('globalLoader')?.classList.toggle('hidden', !isLoading);
  const label = document.getElementById('globalLoaderText');
  if (label) label.textContent = message;
}

function setButtonLoading(button, isLoading, text = 'Carregando...') {
  if (!button) return;
  if (isLoading) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.classList.add('is-loading');
    button.disabled = true;
    button.innerHTML = `<span class="inline-spinner" aria-hidden="true"></span>${escapeHtml(text)}`;
    return;
  }
  if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
  button.classList.remove('is-loading');
  button.disabled = false;
}

async function runWithButtonLoading(button, text, task) {
  setButtonLoading(button, true, text);
  try {
    return await task();
  } finally {
    setButtonLoading(button, false);
  }
}

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

function setStatus(message, isError = false, tone = isError ? 'danger' : 'success') {
  const statusText = document.getElementById('statusText');
  const statusBadge = document.getElementById('statusBadge');
  if (statusText) statusText.textContent = message;
  if (statusBadge) {
    statusBadge.textContent = isError ? 'Atenção' : tone === 'loading' ? 'Sincronizando' : 'Pronto';
    statusBadge.className = `status-badge${isError ? ' danger' : tone === 'success' ? ' success' : ''}`;
  }
}

async function apiRequest(method, path, body, auth = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;

  const proxyBase =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? '/proxy'
      : '/api/proxy';

  const proxyUrl = `${proxyBase}?path=${encodeURIComponent(path)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(proxyUrl, {
      method,
      headers: {
        ...headers,
        'x-target-base-url': API_BASE_URL,
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('A requisição demorou demais para responder.');
    throw error;
  }
  clearTimeout(timeoutId);

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

function cloneTemplate(id) {
  const template = document.getElementById(id);
  return template.content.cloneNode(true);
}

async function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  if (!state.currentUser || !state.accessToken) {
    app.appendChild(cloneTemplate('loginTemplate'));
    initLogin();
    return;
  }

  app.appendChild(cloneTemplate('dashboardTemplate'));
  await initDashboard();
}

function initLogin() {
  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('loginError');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.classList.add('hidden');
    await runWithButtonLoading(event.submitter, 'Entrando...', async () => {
      try {
        const body = Object.fromEntries(new FormData(form).entries());
        const auth = await apiRequest('POST', '/auth/login', body);
        persistAuth(auth);

        let me = null;
        try {
          me = await apiRequest('GET', '/auth/me', null, true);
        } catch (error) {
          // Se /auth/me falhar logo após o login, ainda usamos os dados vindos do próprio /auth/login.
          // Isso evita travar a entrada quando o token acabou de ser emitido e a checagem extra falha.
          me = null;
        }

        const resolvedRole = extractResolvedRole(me, auth, state.currentUser);
        if (resolvedRole !== 'ADMIN') {
          clearAuth();
          throw new Error('Somente ADMIN pode usar este painel.');
        }
        state.currentUser = { ...(auth.user || {}), ...(typeof me === 'object' ? me : {}), role: resolvedRole };
        saveJson(STORAGE_KEYS.user, state.currentUser);
        await render();
      } catch (error) {
        errorEl.textContent = error.message || 'Não foi possível entrar.';
        errorEl.classList.remove('hidden');
      }
    });
  });
}

async function initDashboard() {
  document.getElementById('adminBadge').textContent = `${state.currentUser.name || 'Admin'} • ADMIN`;
  document.getElementById('logoutBtn').addEventListener('click', () => { clearAuth(); render(); });
  document.getElementById('clearCreatedUsers').addEventListener('click', () => {
    state.createdAccounts = [];
    saveJson(STORAGE_KEYS.created, state.createdAccounts);
    renderCreatedAccounts();
  });

  bindNavigation();
  bindForms();
  bindToolbar();
  renderCreatedAccounts();
  setStatus('Carregando estados, restaurantes, categorias e cupons...', false, 'loading');
  setGlobalLoading(true, 'Carregando dados do painel administrativo...');
  try {
    await loadInitialData();
    setStatus('Painel sincronizado.');
  } catch (error) {
    setStatus(error.message || 'Erro ao carregar o painel.', true);
  } finally {
    setGlobalLoading(false);
  }
}

function bindNavigation() {
  document.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      setActivePage(button.dataset.page);
    });
  });
  setActivePage(state.activePage);
}

function setActivePage(page) {
  state.activePage = page;
  document.querySelectorAll('[data-page]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.page === page);
  });
  document.querySelectorAll('[data-page-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.pagePanel !== page);
  });
  if (page === 'status' && !state.appMetrics) {
    refreshStatusMetrics();
  }
}

function bindForms() {
  document.getElementById('restaurantAccountForm')?.addEventListener('submit', handleRestaurantAccountCreate);
  document.getElementById('stateForm')?.addEventListener('submit', handleStateCreate);
  document.getElementById('cityForm')?.addEventListener('submit', handleCityCreate);
  document.getElementById('neighborhoodForm')?.addEventListener('submit', handleNeighborhoodCreate);
  document.getElementById('couponForm')?.addEventListener('submit', handleCouponCreate);
  document.getElementById('storeCategoryForm')?.addEventListener('submit', handleStoreCategoryCreate);
  document.getElementById('uploadStoreCategoryIconBtn')?.addEventListener('click', () => document.getElementById('storeCategoryIconFile').click());
  document.getElementById('storeCategoryIconFile')?.addEventListener('change', handleStoreCategoryIconUpload);
  document.getElementById('storeCategoriesList')?.addEventListener('click', handleStoreCategoryListActions);

  document.getElementById('restaurantAccountState')?.addEventListener('change', (e) => populateCities('restaurantAccountCity', e.target.value));
  document.getElementById('cityStateSelect')?.addEventListener('change', (e) => renderCitiesList(e.target.value));
  document.getElementById('neighborhoodStateSelect')?.addEventListener('change', async (e) => {
    await populateCities('neighborhoodCitySelect', e.target.value);
    renderNeighborhoodsList(document.getElementById('neighborhoodCitySelect').value);
  });
  document.getElementById('neighborhoodCitySelect')?.addEventListener('change', (e) => renderNeighborhoodsList(e.target.value));
}

function bindToolbar() {
  document.getElementById('restaurantSearchInput')?.addEventListener('input', renderRestaurantAdminList);
  document.getElementById('restaurantStatusFilter')?.addEventListener('change', renderRestaurantAdminList);
  document.getElementById('refreshRestaurantsBtn')?.addEventListener('click', async (event) => {
    await runWithButtonLoading(event.currentTarget, 'Atualizando...', async () => {
      await loadRestaurants();
      setStatus('Lista de restaurantes atualizada.');
    });
  });
  document.getElementById('refreshStatusBtn')?.addEventListener('click', async (event) => {
    await runWithButtonLoading(event.currentTarget, 'Atualizando...', async () => {
      await refreshStatusMetrics();
    });
  });
}

async function loadInitialData() {
  await Promise.all([loadStates(), loadRestaurants(), loadStoreCategories(), loadCoupons()]);
}

async function handleRestaurantAccountCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  if (!body.cityId) delete body.cityId;
  await runWithButtonLoading(event.submitter || form.querySelector('button[type="submit"]'), 'Criando conta...', async () => {
    try {
      const result = await apiRequest('POST', '/auth/register-restaurant', body);
      const entry = { createdAt: new Date().toISOString(), user: result.user, restaurant: result.restaurant };
      state.createdAccounts.unshift(entry);
      state.createdAccounts = state.createdAccounts.slice(0, 12);
      saveJson(STORAGE_KEYS.created, state.createdAccounts);
      form.reset();
      setStatus('Conta de restaurante criada com sucesso.');
      renderCreatedAccounts();
      await loadRestaurants();
    } catch (error) {
      setStatus(error.message || 'Erro ao criar conta restaurante.', true);
    }
  });
}

async function handleStateCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  body.code = String(body.code || '').toUpperCase();
  await runWithButtonLoading(event.submitter || form.querySelector('button[type="submit"]'), 'Adicionando...', async () => {
    try {
      await apiRequest('POST', '/locations/states', body, true);
      form.reset();
      setStatus('Estado criado com sucesso.');
      await loadStates();
    } catch (error) {
      setStatus(error.message || 'Erro ao criar estado.', true);
    }
  });
}

async function handleCityCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  await runWithButtonLoading(event.submitter || form.querySelector('button[type="submit"]'), 'Adicionando...', async () => {
    try {
      await apiRequest('POST', '/locations/cities', body, true);
      form.reset();
      setStatus('Cidade criada com sucesso.');
      await loadStates();
      if (body.stateId) renderCitiesList(body.stateId);
    } catch (error) {
      setStatus(error.message || 'Erro ao criar cidade.', true);
    }
  });
}

async function handleNeighborhoodCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  await runWithButtonLoading(event.submitter || form.querySelector('button[type="submit"]'), 'Adicionando...', async () => {
    try {
      await apiRequest('POST', '/locations/neighborhoods', body, true);
      form.reset();
      setStatus('Bairro criado com sucesso.');
      if (body.cityId) await renderNeighborhoodsList(body.cityId);
    } catch (error) {
      setStatus(error.message || 'Erro ao criar bairro.', true);
    }
  });
}

async function handleCouponCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  const body = {
    code: String(data.code || '').toUpperCase().trim(),
    discountPercent: Number(data.discountPercent || 0),
    maxDiscountAmount: Number(data.maxDiscountAmount || 0),
    minOrderAmount: Number(data.minOrderAmount || 0),
    maxUses: Number(data.maxUses || 0),
    isActive: String(data.isActive) !== 'false',
  };
  if (data.startsAt) body.startsAt = new Date(data.startsAt).toISOString();
  if (data.endsAt) body.endsAt = new Date(data.endsAt).toISOString();

  await runWithButtonLoading(event.submitter || form.querySelector('button[type="submit"]'), 'Criando cupom...', async () => {
    try {
      await apiRequest('POST', '/admin/coupons', body, true);
      form.reset();
      setStatus(`Cupom ${body.code} criado com sucesso.`);
      await loadCoupons();
    } catch (error) {
      setStatus(error.message || 'Erro ao criar cupom.', true);
    }
  });
}

async function loadCoupons() {
  try {
    const response = await apiRequest('GET', '/admin/coupons?page=1&limit=12', null, true);
    state.promotionalCoupons = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
    renderCouponList();
  } catch (error) {
    state.promotionalCoupons = [];
    renderCouponList(error.message || 'Não foi possível carregar os cupons agora.');
  }
}

function renderCouponList(errorMessage = '') {
  const el = document.getElementById('couponList');
  if (!el) return;
  if (errorMessage) {
    el.innerHTML = `<div class="empty-state">${escapeHtml(errorMessage)}</div>`;
    return;
  }
  if (!state.promotionalCoupons.length) {
    el.innerHTML = '<div class="empty-state">Nenhum cupom criado até o momento.</div>';
    return;
  }
  const now = Date.now();
  el.innerHTML = state.promotionalCoupons.map((coupon) => {
    const isExpired = coupon.endsAt ? new Date(coupon.endsAt).getTime() < now : false;
    const remaining = Math.max(0, Number(coupon.maxUses || 0) - Number(coupon.usedCount || 0));
    return `
      <div class="coupon-item">
        <div class="row-wrap" style="justify-content:space-between;align-items:flex-start;">
          <div>
            <strong class="coupon-code">${escapeHtml(coupon.code)}</strong>
            <p>${Number(coupon.discountValue ?? coupon.discountPercent ?? 0).toFixed(2)}% de desconto • mínimo ${formatMoney(coupon.minOrderAmount)}</p>
          </div>
          <span class="state-pill ${coupon.isActive && !isExpired ? 'active' : 'inactive'}">${coupon.isActive && !isExpired ? 'Ativo' : isExpired ? 'Expirado' : 'Inativo'}</span>
        </div>
        <div class="coupon-meta">
          <div class="list-item"><strong>Teto</strong><small>${formatMoney(coupon.maxDiscountAmount)}</small></div>
          <div class="list-item"><strong>Usos restantes</strong><small>${remaining} de ${coupon.maxUses}</small></div>
          <div class="list-item"><strong>Início</strong><small>${coupon.startsAt ? formatDateTime(coupon.startsAt) : 'Imediato'}</small></div>
          <div class="list-item"><strong>Fim</strong><small>${coupon.endsAt ? formatDateTime(coupon.endsAt) : 'Sem data'}</small></div>
        </div>
      </div>`;
  }).join('');
}

async function loadStates() {
  state.states = await apiRequest('GET', '/locations/states');
  populateStateSelects();
  renderStatesList();
  const firstStateId = state.states[0]?.id || '';
  if (firstStateId) {
    document.getElementById('restaurantAccountState').value = firstStateId;
    document.getElementById('cityStateSelect').value = firstStateId;
    document.getElementById('neighborhoodStateSelect').value = firstStateId;
    await populateCities('restaurantAccountCity', firstStateId);
    await populateCities('neighborhoodCitySelect', firstStateId);
    await renderCitiesList(firstStateId);
    await renderNeighborhoodsList(document.getElementById('neighborhoodCitySelect').value);
  }
}

async function loadRestaurants() {
  try {
    const restaurants = await apiRequest('GET', '/restaurants', null, true);
    state.restaurants = Array.isArray(restaurants) ? restaurants : [];
  } catch {
    const restaurants = await apiRequest('GET', '/restaurants');
    state.restaurants = Array.isArray(restaurants) ? restaurants : [];
  }
  renderRestaurantAdminList();
  renderRestaurantAdminStats();
  state.appMetrics = null;
  if (state.activePage === 'status') await refreshStatusMetrics();
}

function populateStateSelects() {
  const selects = ['restaurantAccountState', 'cityStateSelect', 'neighborhoodStateSelect'];
  selects.forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = state.states.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} • ${escapeHtml(item.code)}</option>`).join('');
  });
}

async function populateCities(selectId, stateId) {
  const select = document.getElementById(selectId);
  if (!select) return [];
  if (!stateId) {
    select.innerHTML = '<option value="">Selecione</option>';
    return [];
  }
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
  if (!el) return;
  el.innerHTML = state.states.length
    ? state.states.map((item) => `<div class="list-item"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.code)}</small></div>`).join('')
    : '<div class="empty-state">Nenhum estado encontrado.</div>';
}

async function renderCitiesList(stateId) {
  const el = document.getElementById('citiesList');
  if (!el) return;
  if (!stateId) {
    el.innerHTML = '<div class="empty-state">Selecione um estado.</div>';
    return;
  }
  let cities = state.citiesByState.get(stateId);
  if (!cities) {
    try {
      cities = await apiRequest('GET', `/locations/states/${stateId}/cities`);
      state.citiesByState.set(stateId, cities);
    } catch {
      cities = [];
    }
  }
  el.innerHTML = cities.length
    ? cities.map((item) => `<div class="list-item"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(findStateName(stateId))}</small></div>`).join('')
    : '<div class="empty-state">Nenhuma cidade neste estado.</div>';
}

async function renderNeighborhoodsList(cityId) {
  const el = document.getElementById('neighborhoodsList');
  if (!el) return;
  if (!cityId) {
    el.innerHTML = '<div class="empty-state">Selecione uma cidade.</div>';
    return;
  }
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
    const createdAt = entry.createdAt ? new Date(entry.createdAt).toLocaleString('pt-BR') : '-';
    return `
      <div class="created-item">
        <strong>${escapeHtml(entry.restaurant?.name || 'Restaurante')}</strong>
        <p class="soft-text">${escapeHtml(entry.user?.name || 'Responsável')} • ${escapeHtml(entry.user?.email || '')}</p>
        <div class="copy-row">
          <span class="copy-chip">ID: ${escapeHtml(entry.user?.id || '-')}</span>
          <button class="btn-link" type="button" data-copy="${escapeAttribute(entry.user?.id || '')}">Copiar ID</button>
        </div>
        <div class="copy-row">
          <span class="tag">Criado em ${escapeHtml(createdAt)}</span>
        </div>
      </div>`;
  }).join('');
  el.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(btn.dataset.copy || '');
    setStatus('ID copiado para a área de transferência.');
  }));
}

function renderRestaurantAdminStats() {
  const el = document.getElementById('restaurantAdminStats');
  if (!el) return;
  const total = state.restaurants.length;
  const active = state.restaurants.filter((item) => item.isActive !== false).length;
  const inactive = total - active;
  el.innerHTML = [
    { title: 'Restaurantes na base', value: total },
    { title: 'Ativos', value: active },
    { title: 'Inativos', value: inactive },
  ].map((item) => `<div class="summary-item metric-card-accent"><strong>${escapeHtml(item.title)}</strong><div class="metric-value">${item.value}</div></div>`).join('');
}

function getFilteredRestaurants() {
  const query = String(document.getElementById('restaurantSearchInput')?.value || '').trim().toLowerCase();
  const filter = document.getElementById('restaurantStatusFilter')?.value || 'all';
  return state.restaurants.filter((restaurant) => {
    const haystack = [restaurant.name, restaurant.phone, restaurant.address, restaurant.city?.name, restaurant.city?.state?.code].filter(Boolean).join(' ').toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesStatus = filter === 'all' || (filter === 'active' ? restaurant.isActive !== false : restaurant.isActive === false);
    return matchesQuery && matchesStatus;
  });
}

function renderRestaurantAdminList() {
  const el = document.getElementById('restaurantList');
  if (!el) return;
  const restaurants = getFilteredRestaurants();
  if (!restaurants.length) {
    el.innerHTML = '<div class="empty-state">Nenhum restaurante encontrado com esse filtro.</div>';
    return;
  }
  el.innerHTML = restaurants.map((restaurant) => {
    const categories = Array.isArray(restaurant.categoryNames) && restaurant.categoryNames.length ? restaurant.categoryNames.join(', ') : 'Sem categorias';
    return `
      <div class="restaurant-card">
        <div class="restaurant-card-head">
          <div class="restaurant-title-wrap">
            <strong>${escapeHtml(restaurant.name || 'Restaurante')}</strong>
            <div class="restaurant-meta">
              <span class="state-pill ${restaurant.isActive !== false ? 'active' : 'inactive'}">${restaurant.isActive !== false ? 'Ativo' : 'Inativo'}</span>
              <span class="metric-chip">${escapeHtml(restaurant.city?.name || 'Cidade não definida')}</span>
              <span class="metric-chip">${escapeHtml(restaurant.city?.state?.code || 'UF')}</span>
            </div>
          </div>
          <span class="info-chip">${restaurant.acceptsOrdersNow ? 'Aceita pedidos agora' : 'Sem pedidos no momento'}</span>
        </div>
        <p class="restaurant-subline">${escapeHtml(restaurant.description || restaurant.address || 'Sem descrição cadastrada.')}</p>
        <div class="restaurant-meta">
          <span class="tag">${escapeHtml(restaurant.phone || 'Sem telefone')}</span>
          <span class="tag">Categorias: ${escapeHtml(categories)}</span>
          <span class="tag">Horário: ${escapeHtml(restaurant.openingStatusLabel || 'Não informado')}</span>
        </div>
        <div class="restaurant-actions">
          <span class="soft-text">${restaurant.isActive !== false ? 'Admin pode desativar este restaurante agora.' : 'Restaurante desativado pelo admin. O restaurante não pode se reativar sozinho.'}</span>
          <button
            type="button"
            class="status-toggle ${restaurant.isActive !== false ? 'turn-off' : 'turn-on'}"
            data-restaurant-status="${escapeAttribute(restaurant.id)}"
            data-next-active="${restaurant.isActive === false ? 'true' : 'false'}"
          >
            ${restaurant.isActive !== false ? 'Desativar restaurante' : 'Reativar restaurante'}
          </button>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('[data-restaurant-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      const restaurant = state.restaurants.find((item) => item.id === button.dataset.restaurantStatus);
      const nextActive = button.dataset.nextActive === 'true';
      const question = nextActive
        ? `Reativar ${restaurant?.name || 'este restaurante'}?`
        : `Desativar ${restaurant?.name || 'este restaurante'}?`;
      if (!window.confirm(question)) return;
      await runWithButtonLoading(button, nextActive ? 'Reativando...' : 'Desativando...', async () => {
        try {
          await apiRequest('PATCH', `/restaurants/${button.dataset.restaurantStatus}/status`, { isActive: nextActive }, true);
          setStatus(nextActive ? 'Restaurante reativado pelo admin.' : 'Restaurante desativado pelo admin.');
          await loadRestaurants();
        } catch (error) {
          setStatus(error.message || 'Não foi possível alterar o status do restaurante.', true);
        }
      });
    });
  });
}

async function refreshStatusMetrics() {
  setStatus('Atualizando métricas da aplicação...', false, 'loading');
  const cardsEl = document.getElementById('appStatusCards');
  if (cardsEl) cardsEl.innerHTML = '<div class="empty-state">Calculando métricas...</div>';
  try {
    const metrics = await buildAppMetrics();
    state.appMetrics = metrics;
    renderStatusMetrics();
    setStatus('Métricas atualizadas com sucesso.');
  } catch (error) {
    setStatus(error.message || 'Não foi possível atualizar as métricas.', true);
  }
}

async function buildAppMetrics() {
  const restaurants = state.restaurants || [];
  const totalRestaurants = restaurants.length;
  const activeRestaurants = restaurants.filter((item) => item.isActive !== false).length;
  const inactiveRestaurants = totalRestaurants - activeRestaurants;

  const allOrders = [];
  for (const restaurant of restaurants) {
    const restaurantOrders = await fetchAllOrdersForRestaurant(restaurant.id);
    allOrders.push(...restaurantOrders);
  }

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startWeek = new Date(startToday);
  startWeek.setDate(startWeek.getDate() - 6);
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const ordersToday = allOrders.filter((order) => new Date(order.createdAt) >= startToday).length;
  const ordersWeek = allOrders.filter((order) => new Date(order.createdAt) >= startWeek).length;
  const ordersMonth = allOrders.filter((order) => new Date(order.createdAt) >= startMonth).length;
  const deliveredMonth = allOrders.filter((order) => order.status === 'DELIVERED' && new Date(order.createdAt) >= startMonth).length;
  const canceledMonth = allOrders.filter((order) => order.status === 'CANCELED' && new Date(order.createdAt) >= startMonth).length;
  const recentCustomerCount = new Set(allOrders.map((order) => order.user?.id).filter(Boolean)).size;

  return {
    totalRestaurants,
    activeRestaurants,
    inactiveRestaurants,
    ordersToday,
    ordersWeek,
    ordersMonth,
    deliveredMonth,
    canceledMonth,
    recentCustomerCount,
    totalOrdersLoaded: allOrders.length,
  };
}

async function fetchAllOrdersForRestaurant(restaurantId) {
  const collected = [];
  let page = 1;
  let totalPages = 1;
  do {
    const response = await apiRequest('GET', `/orders/restaurant/${restaurantId}?page=${page}&limit=100`, null, true);
    const data = Array.isArray(response?.data) ? response.data : [];
    const pagination = response?.pagination || { totalPages: 1 };
    collected.push(...data);
    totalPages = pagination.totalPages || 1;
    page += 1;
  } while (page <= totalPages);
  return collected;
}

function renderStatusMetrics() {
  const metrics = state.appMetrics;
  const cardsEl = document.getElementById('appStatusCards');
  const highlightsEl = document.getElementById('statusHighlights');
  const narrativeEl = document.getElementById('statusNarrative');
  if (!cardsEl || !highlightsEl || !narrativeEl) return;
  if (!metrics) {
    cardsEl.innerHTML = '<div class="empty-state">As métricas ainda não foram carregadas.</div>';
    highlightsEl.innerHTML = '';
    narrativeEl.innerHTML = '<div class="empty-state">Sem resumo disponível.</div>';
    return;
  }

  cardsEl.innerHTML = [
    ['Restaurantes', metrics.totalRestaurants, 'Total cadastrado na base'],
    ['Pedidos hoje', metrics.ordersToday, 'Volume do dia corrente'],
    ['Pedidos na semana', metrics.ordersWeek, 'Últimos 7 dias'],
    ['Pedidos no mês', metrics.ordersMonth, 'Mês atual'],
    ['Clientes com pedidos', metrics.recentCustomerCount, 'Contagem a partir dos pedidos carregados'],
    ['Ativos', metrics.activeRestaurants, 'Restaurantes aptos a operar'],
    ['Inativos', metrics.inactiveRestaurants, 'Restaurantes pausados ou desligados'],
    ['Cancelados no mês', metrics.canceledMonth, 'Pedidos cancelados no período'],
  ].map(([title, value, text]) => `
    <div class="summary-item metric-card-accent">
      <strong>${escapeHtml(title)}</strong>
      <div class="metric-value">${escapeHtml(String(value))}</div>
      <p>${escapeHtml(text)}</p>
    </div>`).join('');

  const deliveryRate = metrics.ordersMonth ? Math.round((metrics.deliveredMonth / metrics.ordersMonth) * 100) : 0;
  highlightsEl.innerHTML = [
    `<div class="list-item"><strong>Base de restaurantes</strong><small>${metrics.activeRestaurants} ativos de ${metrics.totalRestaurants} cadastrados.</small></div>`,
    `<div class="list-item"><strong>Pedidos carregados</strong><small>${metrics.totalOrdersLoaded} pedido(s) consolidados em todas as páginas dos restaurantes.</small></div>`,
    `<div class="list-item"><strong>Entrega no mês</strong><small>${metrics.deliveredMonth} entregues • taxa aproximada de sucesso ${deliveryRate}%.</small></div>`,
    `<div class="list-item"><strong>Leitura de usuários</strong><small>${metrics.recentCustomerCount} clientes únicos identificados nos pedidos carregados. Total geral de usuários exige endpoint próprio.</small></div>`,
  ].join('');

  narrativeEl.innerHTML = `
    <p>Hoje o painel mostra <strong>${metrics.totalRestaurants}</strong> restaurantes, sendo <strong>${metrics.activeRestaurants}</strong> ativos e <strong>${metrics.inactiveRestaurants}</strong> inativos.</p>
    <ul>
      <li>No dia foram vistos <strong>${metrics.ordersToday}</strong> pedidos.</li>
      <li>Na semana, o acumulado está em <strong>${metrics.ordersWeek}</strong> pedidos.</li>
      <li>No mês atual, a operação soma <strong>${metrics.ordersMonth}</strong> pedidos, com <strong>${metrics.canceledMonth}</strong> cancelados.</li>
      <li>Clientes únicos identificados nos pedidos carregados: <strong>${metrics.recentCustomerCount}</strong>.</li>
    </ul>`;
}

async function loadStoreCategories() {
  try {
    state.storeCategories = await apiRequest('GET', '/store-categories', null, true);
    renderStoreCategoriesList();
  } catch (error) {
    state.storeCategories = [];
    renderStoreCategoriesList();
    setStatus(error.message || 'Erro ao carregar categorias de loja.', true);
  }
}

async function handleStoreCategoryCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = document.getElementById('storeCategoryName').value.trim();
  const iconUrl = document.getElementById('storeCategoryIconUrl').value.trim();
  const sortOrder = Number(document.getElementById('storeCategorySortOrder').value || 0);
  if (!name) {
    setStatus('Informe o nome da categoria.', true);
    return;
  }
  await runWithButtonLoading(event.submitter || form.querySelector('button[type="submit"]'), 'Criando...', async () => {
    try {
      await apiRequest('POST', '/store-categories', { name, iconUrl: iconUrl || undefined, sortOrder }, true);
      form.reset();
      document.getElementById('storeCategoryIconPreviewWrap').classList.add('hidden');
      setStatus(`Categoria "${name}" criada com sucesso.`);
      await loadStoreCategories();
    } catch (error) {
      setStatus(error.message || 'Erro ao criar categoria.', true);
    }
  });
}

async function handleStoreCategoryIconUpload(event) {
  const file = event.target?.files?.[0];
  event.target.value = '';
  if (!file) return;
  const btn = document.getElementById('uploadStoreCategoryIconBtn');
  await runWithButtonLoading(btn, 'Enviando ícone...', async () => {
    try {
      const proxyBase = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? '/proxy' : '/api/proxy';
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${proxyBase}?path=${encodeURIComponent('/uploads/store-category-icon')}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.accessToken}`, 'x-target-base-url': API_BASE_URL },
        body: formData,
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!response.ok) throw new Error(data?.message || data?.data?.message || `Erro ${response.status}`);
      const url = (data?.data || data)?.url || '';
      document.getElementById('storeCategoryIconUrl').value = url;
      const previewWrap = document.getElementById('storeCategoryIconPreviewWrap');
      const preview = document.getElementById('storeCategoryIconPreview');
      if (url) {
        preview.src = url;
        previewWrap.classList.remove('hidden');
      }
      setStatus('Ícone enviado com sucesso.');
    } catch (error) {
      setStatus(error.message || 'Erro ao enviar ícone.', true);
    }
  });
}

async function handleStoreCategoryListActions(event) {
  const deleteBtn = event.target.closest('[data-delete-category]');
  if (!deleteBtn) return;
  const id = deleteBtn.dataset.deleteCategory;
  const name = deleteBtn.dataset.categoryName || '';
  if (!window.confirm(`Remover a categoria "${name}"?`)) return;
  await runWithButtonLoading(deleteBtn, 'Removendo...', async () => {
    try {
      await apiRequest('DELETE', `/store-categories/${id}`, null, true);
      setStatus(`Categoria "${name}" removida.`);
      await loadStoreCategories();
    } catch (error) {
      setStatus(error.message || 'Erro ao remover categoria.', true);
    }
  });
}

function renderStoreCategoriesList() {
  const el = document.getElementById('storeCategoriesList');
  if (!el) return;
  const list = state.storeCategories || [];
  if (!list.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma categoria criada ainda.</div>';
    return;
  }
  el.innerHTML = list
    .slice()
    .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name))
    .map((cat) => `
      <div class="list-item">
        <div class="row-wrap" style="justify-content:space-between;align-items:center;">
          <div class="row-wrap">
            ${cat.iconUrl ? `<img src="${escapeAttribute(cat.iconUrl)}" alt="${escapeAttribute(cat.name)}" style="width:36px;height:36px;border-radius:10px;object-fit:cover;">` : '<div style="width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,.08);"></div>'}
            <div>
              <strong>${escapeHtml(cat.name)}</strong>
              <small>Ordem ${cat.sortOrder}</small>
            </div>
          </div>
          <button class="btn-link" type="button" data-delete-category="${escapeAttribute(cat.id)}" data-category-name="${escapeAttribute(cat.name)}">Remover</button>
        </div>
      </div>`)
    .join('');
}

function formatMoney(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
}

function formatDateTime(value, withTime = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', ...(withTime ? { timeStyle: 'short' } : {}) }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

(async function boot() {
  setBooting(true, 'Validando sua sessão...');
  if (state.currentUser && state.accessToken) {
    try {
      const me = await apiRequest('GET', '/auth/me', null, true);
      const resolvedRole = extractResolvedRole(me, state.currentUser);
      if (resolvedRole !== 'ADMIN') throw new Error('Somente ADMIN pode usar este painel.');
      state.currentUser = {
        ...(typeof state.currentUser === 'object' ? state.currentUser : {}),
        ...(typeof me === 'object' ? me : {}),
        ...(me?.user || {}),
        role: resolvedRole,
      };
      saveJson(STORAGE_KEYS.user, state.currentUser);
    } catch {
      clearAuth();
    }
  }
  await render();
  setBooting(false);
})();
