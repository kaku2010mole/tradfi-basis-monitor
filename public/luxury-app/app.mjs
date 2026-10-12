import { normalizeRates, calculatePrice, sortRows, csvCell } from './core.mjs?v=20261012-2';

const $ = id => document.getElementById(id);
const appBase = new URL('.', import.meta.url);
const ratesEndpoint = document.documentElement.dataset.ratesEndpoint || '/api/rates';
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const safeUrl = url => typeof url === 'string' && /^https:\/\//.test(url) ? e(url) : '#';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const defaults = () => ({ residence:'cn', tripDate:today(), feePercent:0, usSalesTax:0 });
const money = amount => Number.isFinite(amount) ? '¥ ' + new Intl.NumberFormat('zh-CN', { maximumFractionDigits:0 }).format(amount) : '—';
const localMoney = (amount, currency) => Number.isFinite(amount) ? new Intl.NumberFormat('en-US', { style:'currency', currency, currencyDisplay:'narrowSymbol', maximumFractionDigits:0 }).format(amount) : '—';
const percent = value => (value * 100).toFixed(2) + '%';
const icons = {
  heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  'check-circle':'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  refresh:'<path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5M4 16a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
  search:'<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>',
  left:'<path d="m14 6-6 6 6 6"/>', right:'<path d="m10 6 6 6-6 6"/>', down:'<path d="m6 9 6 6 6-6"/>',
  sort:'<path d="M4 5h14M4 10h10M4 15h6M18 10v11m-3-3 3 3 3-3"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  sliders:'<path d="M4 6h5m4 0h7M4 12h10m4 0h2M4 18h3m4 0h9"/><circle cx="11" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>', close:'<path d="m6 6 12 12M18 6 6 18"/>',
  arrow:'<path d="M5 19 19 5M8 5h11v11"/>'
};
const icon = name => `<span class="icon" data-icon="${name}"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg></span>`;
function decorate(root = document) { root.querySelectorAll('.icon[data-icon]').forEach(node => { if (!node.children.length) node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[node.dataset.icon] || ''}</svg>`; }); }
function readStorage(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeStorage(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browser mode still supports comparison */ } }
let catalogue, taxData, fx, state, toastTimer;
function showToast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3000); }
function product(id = state.comparedId) { return catalogue.products.find(p => p.id === id); }
function brand(id) { return catalogue.brands.find(b => b.id === id); }
function saveState() { writeStorage('atelier-settings-v1', state.settings); writeStorage('atelier-favorites-v1', [...state.favorites]); $('saved-count').textContent = state.favorites.size; }
function buildRows(all = false) {
  const p = product();
  return catalogue.regions.filter(r => all || state.regions.has(r.id)).map(region => {
    const price = p.prices.find(v => v.regionId === region.id);
    const rule = taxData.rules[region.id];
    return { region, price, rule, calculation:calculatePrice(price, region, rule, fx, state.settings) };
  });
}
function renderBrands() {
  $('coverage-text').textContent = `${catalogue.regions.length} 个国家与地区`;
  $('brand-tabs').innerHTML = [{id:'all', name:'全部品牌'}, ...catalogue.brands].map(b => `<button class="brand-tab ${state.brand === b.id ? 'active':''}" data-brand="${e(b.id)}" aria-pressed="${state.brand === b.id}">${e(b.name)}</button>`).join('');
}
function renderProducts() {
  const query = state.query.trim().toLocaleLowerCase();
  const products = catalogue.products.filter(p => (state.brand === 'all' || state.brand === p.brandId) && (!query || [p.nameEn,p.nameZh,p.sku,brand(p.brandId).name,brand(p.brandId).nameZh].join(' ').toLocaleLowerCase().includes(query)));
  $('product-count').textContent = `${products.length} 款精选`;
  $('product-grid').innerHTML = products.length ? products.map(p => `<article class="product-card ${state.selectedId === p.id ? 'selected':''}" data-brand="${e(p.brandId)}"><button class="product-select" data-select="${e(p.id)}" aria-pressed="${state.selectedId === p.id}" aria-label="选择 ${e(brand(p.brandId).name)} ${e(p.nameZh)}"><div class="product-image"><img src="${e(p.image || '')}" alt="${e(p.nameZh)}官方商品图片" loading="lazy" data-product-image="${e(p.id)}">${state.selectedId === p.id ? '<span class="selected-check" aria-hidden="true">✓</span>':''}</div><span class="product-brand">${e(brand(p.brandId).name)}</span><span class="product-name">${e(p.nameEn)}</span><span class="product-chinese">${e(p.nameZh)}</span><span class="product-size">${e(p.size)} · ${p.prices.filter(v => Number.isFinite(v.amount)).length} 个地区价格</span></button><button class="favorite ${state.favorites.has(p.id) ? 'active':''}" data-favorite="${e(p.id)}" aria-pressed="${state.favorites.has(p.id)}" aria-label="${state.favorites.has(p.id) ? '取消收藏':'收藏'}${e(p.nameZh)}">${icon('heart')}</button></article>`).join('') : '<div class="empty-state">未找到对应款式，试试品牌名或货号。</div>';
  $('product-grid').querySelectorAll('img').forEach(image => image.addEventListener('error', () => {
    const p = product(image.dataset.productImage);
    image.replaceWith(Object.assign(document.createElement('span'), { className:'product-image-fallback', textContent:brand(p.brandId).name + ' · 官图暂不可用' }));
  }, { once:true }));
  const p = product(state.selectedId);
  $('selection-name').textContent = `${brand(p.brandId).name} · ${p.nameEn}`;
  $('selection-description').textContent = state.selectedId !== state.comparedId ? '款式已选择，点击确认后更新价格比较' : `${p.nameZh} · ${p.size}`;
  requestAnimationFrame(updateCarousel);
}
function updateCarousel() {
  const grid = $('product-grid');
  $('prev-products').disabled = grid.scrollLeft < 4;
  $('next-products').disabled = grid.scrollLeft >= grid.scrollWidth - grid.clientWidth - 4;
}
function renderRegions() {
  $('region-options').innerHTML = catalogue.regions.map(r => `<label class="region-option"><input type="checkbox" value="${r.id}" ${state.regions.has(r.id) ? 'checked':''}>${e(r.flag)} ${e(r.name)}</label>`).join('');
  $('region-button-label').textContent = state.regions.size === catalogue.regions.length ? '全部地区' : `${state.regions.size} 个地区`;
}
function renderFx() {
  const age = (Date.now() - Date.parse(fx.effectiveDate + 'T00:00:00Z')) / 86400000;
  const cached = fx.status !== 'live';
  $('fx-status').textContent = `${cached ? '缓存汇率':'最新发布汇率'} ${fx.effectiveDate}${age > 5 ? ' · 较旧，请刷新':''}`;
  $('fx-dot').className = `status-dot ${cached || age > 5 ? 'warning':''}`;
  $('fx-status').title = `Frankfurter / 欧洲央行工作日参考汇率。${fx.fetchedAt ? '最近检查：' + new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Hong_Kong',dateStyle:'short',timeStyle:'short'}).format(new Date(fx.fetchedAt)) : '当前显示已保存的核实快照。'}${fx.message || ''}`;
}
function renderComparison() {
  const p = product();
  const key = state.basis === 'after' ? 'afterCny':'officialCny';
  const rows = sortRows(buildRows(), state.sort, state.basis);
  const valid = rows.filter(r => r.calculation.available);
  const unavailable = rows.filter(r => !r.calculation.available);
  const displayed = state.showUnavailable ? rows : valid;
  $('availability-note').hidden = !unavailable.length;
  $('availability-summary').textContent = `${valid.length} 个地区已有官价 · ${unavailable.length} 个地区暂无可比官价`;
  $('unavailable-toggle').textContent = state.showUnavailable ? '收起暂无官价地区' : `查看其他 ${unavailable.length} 个地区`;
  $('unavailable-toggle').setAttribute('aria-expanded',String(state.showUnavailable));
  const cheapest = [...valid].sort((a,b) => a.calculation[key] - b.calculation[key])[0];
  const baseline = p.prices.find(v => v.regionId === 'cn')?.amount;
  const delta = cheapest && Number.isFinite(baseline) ? baseline - cheapest.calculation[key] : null;
  const feeLabel = state.settings.feePercent === 0 ? 'VAT 理论参考 · 未扣手续费' : `退税后估算 · 手续费 ${state.settings.feePercent}%`;
  $('compared-product').innerHTML = `<img src="${e(p.image || '')}" alt=""><div><strong>${e(brand(p.brandId).name)} / ${e(p.nameEn)}</strong><p>${e(p.nameZh)} · ${e(p.material)} · ${e(p.size)}</p></div><span class="sku-tag">REF. ${e(p.skuDisplay || p.sku)}</span>`;
  $('comparison-summary').innerHTML = `<div class="summary-cell"><div class="summary-label">${icon('globe')} 当前范围参考最低价</div><div class="summary-value">${cheapest ? money(cheapest.calculation[key]):'—'}<small>${cheapest ? e(cheapest.region.name):'暂无可比价格'}</small></div><div class="summary-note">${state.basis === 'after' ? feeLabel:'官网标价换算 · 不计退税'}</div></div><div class="summary-cell"><div class="summary-label">较中国大陆官网价${delta !== null && delta < 0 ? '高出':'可少付'}</div><div class="summary-value positive">${delta === null ? '—':money(Math.abs(delta))}<small>${delta === null ? '':percent(Math.abs(delta)/baseline)}</small></div><div class="summary-note">${Number.isFinite(baseline) ? '大陆官网基准 ' + money(baseline):'大陆官网价暂未核实'} · 差额供参考</div></div><div class="summary-cell"><div class="summary-label">当前可比地区</div><div class="summary-value">${valid.length}<small>/ ${rows.length} 个所选地区</small></div><div class="summary-note">同款官价 · 独立来源 · ${p.checkedAt}</div></div>`;
  $('price-rows').innerHTML = displayed.map(row => {
    const { region:r, price:pr, calculation:c } = row;
    const best = c.available && cheapest && Math.abs(c[key] - cheapest.calculation[key]) < 0.005;
    const evidence = pr?.evidenceType === 'search-index';
    let afterNote = !c.available ? '暂无官价' : r.id === 'us' ? state.settings.usSalesTax ? `已加销售税 ${state.settings.usSalesTax}%`:'未含州 / 地方销售税' : c.eligible ? (r.id === 'kr' ? '仅扣 VAT 部分':c.isJapanStoreExemption ? '店内免税理论值':state.settings.feePercent && row.rule.feeApplies !== false ? '已扣设定手续费':'VAT 理论值 · 未扣费'):'退税不适用';
    return `<tr class="${best ? 'cheapest':''}"><td><div class="region-cell"><span class="region-flag" aria-hidden="true">${e(r.flag)}</span><div><span class="region-title">${e(r.name)}${best ? '<span class="best-badge">参考最低</span>':''}</span><span class="region-en">${e(r.nameEn)}</span></div></div></td><td>${c.available ? `<span class="price-amount">${e(localMoney(c.local,r.currency))}</span><span class="currency-code ${evidence ? 'search-reference':''}">${r.currency}${evidence ? ' · 官网索引参考':' · 官网标价'}</span>`:`<span class="missing-price">${pr?.availability === 'on-request' ? '官网询价':'未核实官价'}</span>`}</td><td><span class="rate-amount">${Number.isFinite(c.rate) ? c.rate.toFixed(r.currency === 'KRW' ? 6:5):'—'}</span><span class="rate-currency">${r.currency} → CNY</span></td><td class="${state.basis === 'official' ? 'active-column':''}"><span class="price-amount">${money(c.officialCny)}</span>${(r.id === 'us') && c.available ? '<span class="sub-caption">官网税前价换算</span>':''}</td><td><span class="refund-value">${c.available && c.eligible ? '约 ' + percent(c.refundRate):c.available ? '不适用':'—'}</span><span class="refund-caption">${c.available ? e(c.status):'尚无可比价格'}</span></td><td class="${state.basis === 'after' ? 'active-column':''}"><span class="after-amount">${money(c.afterCny)}</span><span class="sub-caption">${e(afterNote)}</span></td><td><div class="row-actions">${pr?.url ? `<a class="official-link" href="${safeUrl(pr.url)}" target="_blank" rel="noopener noreferrer">官网 ↗</a>`:''}<button class="detail-button" data-detail="${r.id}" aria-label="查看${e(r.name)}价格及退税详情">${icon('info')}</button></div></td></tr>`;
  }).join('');
  $('table-empty').hidden = Boolean(displayed.length);
  $('table-empty').textContent = rows.length ? '所选地区暂无可比官价，可展开查看来源状态或更换地区。':'请选择至少一个比较地区。';
  $('official-heading').classList.toggle('active-column', state.basis === 'official');
  $('after-heading').classList.toggle('active-column', state.basis === 'after');
  const residenceLabel = $('settings-form').elements.residence.querySelector(`option[value="${state.settings.residence}"]`)?.textContent || '所选地区';
  $('estimate-note').innerHTML = `${icon('info')}<span>${state.basis === 'after' ? `${e(feeLabel)}。按${e(residenceLabel)}常住旅客、${state.settings.tripDate} 购物、满足各地资格与门店要求测算。`:'按官网标价换算并排序，退税参考单独列示。'} ${valid.some(v => v.price?.evidenceType === 'search-index') ? '含官网搜索索引参考价，已逐条标注。':''}</span>`;
  $('price-date').textContent = `官价查阅 ${p.checkedAt} · 退税规则核实 ${taxData.verifiedAt} · 汇率发布 ${fx.effectiveDate}`;
  decorate($('comparison'));
}
async function refreshRates(manual = false) {
  const button = $('refresh-rates');
  button.disabled = true; button.classList.add('spinning');
  try {
    const response = await fetch(ratesEndpoint + (manual ? '?refresh=1':''), { signal:AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('汇率接口不可用');
    const data = await response.json();
    if (!data.rates || !catalogue.regions.every(r => Number.isFinite(data.rates[r.currency]) && data.rates[r.currency] > 0)) throw new Error('汇率响应不完整');
    fx = data; renderFx(); renderComparison();
    if (manual) showToast(data.status === 'live' ? `汇率已刷新，发布日期 ${data.effectiveDate}` : '连接暂不可用，已保留带日期的参考汇率');
  } catch { fx = {...fx, status:'snapshot'}; renderFx(); if (manual) showToast('暂时无法刷新，使用最近核实汇率'); }
  finally { button.disabled = false; button.classList.remove('spinning'); }
}
function closeDialog(dialog) { dialog.close(); }
function openSettings() {
  const form = $('settings-form');
  Object.entries(state.settings).forEach(([key,value]) => { if (form.elements[key]) form.elements[key].value = value; });
  $('settings-dialog').showModal();
}
function sourceLinks(rule) { return rule.sources.map(s => `<a class="text-link" href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${e(s.title)} ↗</a>`).join('<br>'); }
function policyText(region, rule) {
  if (region.id === 'jp') return state.settings.tripDate < '2026-11-01' ? rule.currentProcedure : rule.futureProcedure;
  return rule.procedure || rule.note || rule.eligibility;
}
function showDetail(id) {
  const row = buildRows(true).find(r => r.region.id === id);
  const { region:r, price:pr, rule, calculation:c } = row;
  const p = product();
  $('details-content').innerHTML = `<h2 class="detail-title"><span class="region-flag" aria-hidden="true">${r.flag}</span>${e(r.name)}</h2><p class="detail-subtitle">${e(brand(p.brandId).name)} · ${e(p.nameZh)}<br>货号 ${e(pr?.sku || p.sku)} · ${e(p.size)}</p><div class="detail-math"><div><span>当地官网价</span><strong>${localMoney(c.local,r.currency)}</strong></div><div><span>1 ${r.currency} 兑人民币</span><strong>${c.rate?.toFixed(6) ?? '—'}</strong></div><div><span>可退 VAT / 免税额（未扣费）</span><strong>${c.available ? localMoney(c.eligible ? c.refundableVat:0,r.currency):'—'}</strong></div><div><span>本次测算退税 / 免税金额</span><strong>${c.available ? localMoney(c.refundLocal,r.currency):'—'}</strong></div>${(r.id === 'us') ? `<div><span>另计销售税 ${percent(c.salesTaxRate)}</span><strong>${localMoney(c.localTax,r.currency)}</strong></div>`:''}<div><span>${(r.id === 'us') ? '加税后人民币参考价' : state.settings.feePercent ? '退税后估算人民币价':'VAT 理论人民币价 · 未扣费'}</span><strong>${money(c.afterCny)}</strong></div></div><div class="detail-block"><h3>${e(rule.shortLabel)} · 资格与门槛</h3><p>${e(rule.eligibility || rule.note)}${rule.minimumLabel ? '<br>购物门槛：' + e(rule.minimumLabel):''}<br>当前测算：${e(c.status)}；门店支持和完整身份资格需在购物时确认。</p></div><div class="detail-block"><h3>办理方式与费用</h3><p>${e(policyText(r,rule))}<br>${e(rule.fee || rule.note || '')}${rule.luxuryTaxNote ? '<br>' + e(rule.luxuryTaxNote):''}${r.id === 'jp' ? '<br>店内免税理论值按不扣费展示；若店内柜台另收手续费，请以门店实际报价为准。':''}${r.id === 'cn' ? '<br>首版不估算境外旅客在中国大陆的离境退税，即使切换常住地也不自动套用。':''}</p></div><div class="detail-block"><h3>官方政策来源</h3>${sourceLinks(rule)}</div><div class="detail-block"><h3>官价依据</h3><p>${e(pr?.note || '此地区同货号价格尚未核实。')}${p.note ? '<br>' + e(p.note):''}</p>${pr?.url ? `<a class="text-link" href="${safeUrl(pr.url)}" target="_blank" rel="noopener noreferrer">查看品牌地区官网当前价格 ↗</a>`:''}</div><p class="detail-meta">官价查阅 ${pr?.checkedAt || p.checkedAt}；${pr?.sourceCrawledDate ? '读取服务抓取 ' + pr.sourceCrawledDate + '；':''}来源类型：${pr?.availability === 'on-request' ? '官网未公开价格':pr?.evidenceType === 'search-index' ? '官网搜索索引':pr?.evidenceType === 'official-page' ? '官网页面快照':'尚无已核实官价'}。<br>规则核实 ${taxData.verifiedAt}；汇率发布 ${fx.dates[r.currency] || fx.effectiveDate}。核实日期不代表价格或政策更新时间，未接入订单实时退税报价。</p>`;
  $('details-dialog').showModal();
}
function showGuide() {
  $('guide-content').innerHTML = catalogue.regions.map(r => { const rule = taxData.rules[r.id]; return `<article class="guide-item"><h3>${r.flag} ${e(r.name)}<span>${e(rule.shortLabel)}</span></h3><div><p>${e(rule.eligibility || rule.note)}${rule.minimumLabel ? '<br>门槛：' + e(rule.minimumLabel):''}<br>${e(policyText(r,rule))}${rule.luxuryTaxNote ? '<br>韩国仅估算VAT；高价包的个别消费税需依据税单。':''}</p>${sourceLinks(rule)}<p class="detail-meta">规则核实 ${taxData.verifiedAt}${r.id === 'jp' ? ' · 2026-11-01 制度变更已收录':''}</p></div></article>`; }).join('');
  $('guide-dialog').showModal();
}
function renderSaved() {
  const saved = catalogue.products.filter(p => state.favorites.has(p.id));
  $('saved-content').innerHTML = saved.length ? saved.map(p => `<div class="saved-item"><img src="${e(p.image || '')}" alt="${e(p.nameZh)}"><div><strong>${e(p.nameEn)}</strong><p>${e(brand(p.brandId).name)} · ${e(p.nameZh)}</p><button class="text-link" data-compare-saved="${e(p.id)}">查看全球价格 ↗</button></div><button class="icon-button" data-remove-saved="${e(p.id)}" aria-label="移除${e(p.nameZh)}收藏">${icon('close')}</button></div>`).join('') : '<div class="empty-state">点击包款右上角的心形，将心仪款式留在这里。</div>';
}
function confirmProduct(id = state.selectedId) {
  state.selectedId = id; state.comparedId = id; state.showUnavailable = false;
  renderProducts(); renderComparison();
  const url = new URL(location.href); url.searchParams.set('bag',id); history.replaceState({},'',url);
  $('comparison').scrollIntoView({behavior:'smooth',block:'start'});
}
function exportCsv() {
  const p = product();
  const rows = sortRows(buildRows(),state.sort,state.basis);
  const header = ['品牌','英文款式','中文款式','货号','地区','币种','当地官网价','1外币兑人民币','官网价人民币','退税/免税金额当地币','退税后参考人民币','退税计算口径','常住地','购物日期','手续费占可退VAT%','美国销售税%','退税状态','价格来源类型','官网来源','官价查阅日期','汇率发布日期','退税规则核实日期'];
  const lines = [header, ...rows.map(({region:r,price:pr,calculation:c}) => [brand(p.brandId).name,p.nameEn,p.nameZh,pr?.sku || p.sku,r.name,r.currency,c.local,c.rate?.toFixed(8),c.officialCny?.toFixed(2),c.refundLocal?.toFixed(2),c.afterCny?.toFixed(2),state.settings.feePercent ? '退税后估算（韩国仅VAT部分）':'VAT理论参考未扣手续费（韩国仅VAT部分）',state.settings.residence,state.settings.tripDate,state.settings.feePercent,state.settings.usSalesTax,c.status,pr?.evidenceType,pr?.url,pr?.checkedAt,fx.dates[r.currency] || fx.effectiveDate,taxData.verifiedAt])];
  const blob = new Blob(['\uFEFF' + lines.map(line => line.map(csvCell).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `寻价_${p.sku}_${today()}.csv`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
  showToast('已导出当前地区、汇率、退税条件与来源');
}
function bindEvents() {
  $('brand-tabs').addEventListener('click', event => { const button = event.target.closest('[data-brand]'); if (!button) return; state.brand = button.dataset.brand; renderBrands(); renderProducts(); $('product-grid').scrollLeft = 0; });
  $('search-products').addEventListener('input', event => { state.query = event.target.value; renderProducts(); });
  $('product-grid').addEventListener('click', event => {
    const selected = event.target.closest('[data-select]'), favorite = event.target.closest('[data-favorite]');
    if (selected) { state.selectedId = selected.dataset.select; renderProducts(); }
    if (favorite) { const id = favorite.dataset.favorite; state.favorites.has(id) ? state.favorites.delete(id):state.favorites.add(id); saveState(); renderProducts(); showToast(state.favorites.has(id) ? '已加入收藏':'已取消收藏'); }
  });
  $('product-grid').addEventListener('scroll', updateCarousel, {passive:true}); window.addEventListener('resize', updateCarousel);
  $('prev-products').addEventListener('click', () => $('product-grid').scrollBy({left:-$('product-grid').clientWidth*.7,behavior:'smooth'}));
  $('next-products').addEventListener('click', () => $('product-grid').scrollBy({left:$('product-grid').clientWidth*.7,behavior:'smooth'}));
  $('confirm-product').addEventListener('click', () => confirmProduct());
  $('unavailable-toggle').addEventListener('click', () => { state.showUnavailable = !state.showUnavailable; renderComparison(); });
  $('sort-order').addEventListener('change', event => { state.sort = event.target.value; renderComparison(); });
  document.querySelectorAll('[data-basis]').forEach(button => button.addEventListener('click', () => { state.basis = button.dataset.basis; document.querySelectorAll('[data-basis]').forEach(b => { b.classList.toggle('active',b === button); b.setAttribute('aria-pressed',String(b === button)); }); renderComparison(); }));
  $('region-button').addEventListener('click', () => { const open = $('region-popover').hidden; $('region-popover').hidden = !open; $('region-button').setAttribute('aria-expanded',String(open)); });
  $('region-options').addEventListener('change', event => { event.target.checked ? state.regions.add(event.target.value):state.regions.delete(event.target.value); renderRegions(); renderComparison(); });
  $('select-all-regions').addEventListener('click', () => { state.regions = new Set(catalogue.regions.map(r => r.id)); renderRegions(); renderComparison(); });
  document.addEventListener('click', event => { if (!event.target.closest('.region-selector')) { $('region-popover').hidden = true; $('region-button').setAttribute('aria-expanded','false'); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('region-popover').hidden = true; $('region-button').setAttribute('aria-expanded','false'); } });
  $('settings-button').addEventListener('click', openSettings);
  $('settings-form').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    if (!form.reportValidity()) return;
    state.settings = {residence:form.elements.residence.value,tripDate:form.elements.tripDate.value,feePercent:Number(form.elements.feePercent.value),usSalesTax:Number(form.elements.usSalesTax.value)};
    saveState(); closeDialog($('settings-dialog')); renderComparison(); showToast('已按旅行条件重新计算');
  });
  $('reset-settings').addEventListener('click', () => { Object.entries(defaults()).forEach(([key,value]) => $('settings-form').elements[key].value = value); });
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect=dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog); } }));
  $('price-rows').addEventListener('click', event => { const button = event.target.closest('[data-detail]'); if (button) showDetail(button.dataset.detail); });
  $('refresh-rates').addEventListener('click', () => refreshRates(true));
  $('export-csv').addEventListener('click', exportCsv);
  $('tax-guide-button').addEventListener('click', showGuide);
  $('saved-button').addEventListener('click', () => { renderSaved(); $('saved-dialog').showModal(); });
  $('saved-content').addEventListener('click', event => {
    const compare = event.target.closest('[data-compare-saved]'), remove = event.target.closest('[data-remove-saved]');
    if (compare) { closeDialog($('saved-dialog')); confirmProduct(compare.dataset.compareSaved); }
    if (remove) { state.favorites.delete(remove.dataset.removeSaved); saveState(); renderSaved(); renderProducts(); }
  });
}
async function init() {
  decorate();
  const responses = await Promise.all(['data/catalog.json','data/tax-rules.json','data/fx-snapshot.json'].map(url => fetch(new URL(url, appBase), { cache:'no-store' }).then(r => { if (!r.ok) throw new Error('数据文件不可用'); return r.json(); })));
  [catalogue,taxData] = responses; fx = { ...normalizeRates(responses[2]), status:'snapshot' };
  for (const p of catalogue.products) if (p.image?.startsWith('/assets/')) p.image = new URL(p.image.slice(1), appBase).pathname;
  const savedSettings = readStorage('atelier-settings-v1',defaults());
  const settings = {...defaults(),...savedSettings};
  delete settings.caProvince;
  if (!['cn','hk','jp','eu','uk','us','sg','kr','ch','au','fi'].includes(settings.residence)) settings.residence='cn';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.tripDate)) settings.tripDate=today();
  for (const [key,max] of [['feePercent',100],['usSalesTax',15]]) { if (!Number.isFinite(settings[key]) || settings[key]<0 || settings[key]>max) settings[key]=0; }
  const requested = new URL(location.href).searchParams.get('bag');
  const initial = catalogue.products.some(p => p.id===requested) ? requested:catalogue.products[0].id;
  const storedFavorites = readStorage('atelier-favorites-v1',[]);
  state = {selectedId:initial,comparedId:initial,brand:'all',query:'',basis:'after',sort:'asc',showUnavailable:false,regions:new Set(catalogue.regions.map(r => r.id)),settings,favorites:new Set((Array.isArray(storedFavorites)?storedFavorites:[]).filter(id => catalogue.products.some(p=>p.id===id)))};
  saveState(); renderBrands(); renderProducts(); renderRegions(); renderFx(); renderComparison(); bindEvents();
  refreshRates();
  setInterval(() => { if (!document.hidden) refreshRates(); },3600000);
}
init().catch(error => { $('product-grid').innerHTML='<p class="fatal-error">页面数据加载失败，请刷新页面，或检查本地服务是否正常运行。</p>'; $('fx-status').textContent='数据暂时无法加载'; console.error(error); });
