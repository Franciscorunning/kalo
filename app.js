// Kalo — suivi des calories, macros, poids et pas. Tout reste sur l'appareil.

const APP_VERSION = '30';
const RELAY_URL = 'https://kalo-relay.kalo-relay.workers.dev';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm';
const MODEL = 'claude-opus-5-5';
const STORE = 'kalo-v1';

const MEALS = [
  { id: 'dej', name: 'Petit-déjeuner', emoji: '🥐' },
  { id: 'midi', name: 'Dîner (midi)', emoji: '🍽️' },
  { id: 'coll', name: 'Collations', emoji: '🍎' },
  { id: 'soir', name: 'Souper (soir)', emoji: '🌙' },
];
const ACTIVITY = [
  { v: 1.2, t: 'Sédentaire', d: 'Bureau, peu de marche' },
  { v: 1.375, t: 'Légèrement actif', d: '1 à 3 séances par semaine' },
  { v: 1.55, t: 'Actif', d: '3 à 5 séances par semaine' },
  { v: 1.725, t: 'Très actif', d: '6 séances ou plus, métier physique' },
];
const GOALS = [
  { v: 'lose', t: 'Perdre du poids', d: 'Environ −0,5 kg par semaine' },
  { v: 'maintain', t: 'Garder mon poids', d: 'Manger à l\'équilibre' },
  { v: 'gain', t: 'Prendre du poids', d: 'Prise de masse douce' },
];

/* ====================== Données ====================== */
let S = loadStore();
function loadStore() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(STORE)); } catch {}
  return Object.assign({ profile: null, apiKey: '', days: {}, foods: {}, meals: [] }, d || {});
}
function rawSave() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); }
  catch { toast('Mémoire pleine : exporte une sauvegarde dans Profil'); }
}
function save() {
  const changed = stamp();
  rawSave();
  if (changed) scheduleSync();
}

/* ====================== Sauvegarde en ligne (synchro entre appareils) ======================
   Les données sont gardées dans le coffre privé du relais (compte Cloudflare de Francisco), une entrée par code.
   Chaque jour / aliment / repas favori porte l'heure de sa dernière modification (u) ; les suppressions laissent
   une trace (tomb). À chaque synchro on fusionne : pour chaque élément, la version la plus récente gagne. */
const stripU = o => { const { u, ...r } = o || {}; return JSON.stringify(r); };
const settingsOf = st => JSON.stringify({ profile: st.profile || null, startDate: st.startDate ?? null });
let lastSnap = null;
function snapOf(st) {
  const m = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, stripU(v)]));
  return { days: m(st.days), foods: m(st.foods), meals: Object.fromEntries((st.meals || []).map(x => [x.id, stripU(x)])), settings: settingsOf(st) };
}
function stamp() {
  if (!lastSnap) { lastSnap = snapOf(S); return false; }
  const now = Date.now(), cur = snapOf(S); let changed = false;
  S.tomb = S.tomb || {};
  const cmp = (prefix, curMap, oldMap, getObj) => {
    for (const k in curMap) if (curMap[k] !== oldMap[k]) { const o = getObj(k); if (o) o.u = now; delete S.tomb[prefix + k]; changed = true; }
    for (const k in oldMap) if (!(k in curMap)) { S.tomb[prefix + k] = now; changed = true; }
  };
  cmp('d:', cur.days, lastSnap.days, k => S.days[k]);
  cmp('f:', cur.foods, lastSnap.foods, k => S.foods[k]);
  cmp('m:', cur.meals, lastSnap.meals, k => (S.meals || []).find(x => x.id === k));
  if (cur.settings !== lastSnap.settings) { S.setU = now; changed = true; }
  lastSnap = cur;
  return changed;
}
const docOf = st => ({ days: st.days || {}, foods: st.foods || {}, meals: st.meals || [], tomb: st.tomb || {}, profile: st.profile || null, startDate: st.startDate, setU: st.setU || 0 });
function mergeDocs(L, R, remoteSettingsWin) {
  const tomb = { ...(R.tomb || {}) };
  for (const [k, t] of Object.entries(L.tomb || {})) tomb[k] = Math.max(tomb[k] || 0, t);
  const mergeMap = (prefix, a, b) => {
    const out = {};
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      const x = a?.[k], y = b?.[k];
      const pick = !x ? y : !y ? x : ((x.u || 0) >= (y.u || 0) ? x : y);
      if (tomb[prefix + k] && tomb[prefix + k] >= (pick.u || 0)) continue;
      out[k] = pick;
    }
    return out;
  };
  const byId = arr => Object.fromEntries((arr || []).map(x => [x.id, x]));
  const useR = remoteSettingsWin ? !!R.profile : ((R.setU || 0) > (L.setU || 0) || !L.profile);
  return {
    days: mergeMap('d:', L.days, R.days), foods: mergeMap('f:', L.foods, R.foods),
    meals: Object.values(mergeMap('m:', byId(L.meals), byId(R.meals))), tomb,
    profile: useR ? R.profile : L.profile, startDate: useR ? R.startDate : L.startDate,
    setU: Math.max(L.setU || 0, R.setU || 0),
  };
}
// Appel au relais avec 3 essais : une coupure passagère (réseau, adresse introuvable un instant) ne bloque plus.
// Deux adresses pour le même relais : si un réseau bloque l'une, on passe par l'autre (et on retient celle qui marche).
const RELAY_HOSTS = [RELAY_URL, 'https://kalo-relais.pages.dev'];
async function relayFetch(path, opts = {}) {
  let last, pref = 0;
  try { pref = Math.max(0, RELAY_HOSTS.indexOf(localStorage.getItem('kalo-relay-host'))); } catch {}
  const order = [RELAY_HOSTS[pref], ...RELAY_HOSTS.filter((_, i) => i !== pref)];
  for (let i = 0; i < 3; i++) {
    for (const h of order) {
      try {
        const r = await fetch(h + path, opts);
        try { localStorage.setItem('kalo-relay-host', h); } catch {}
        return r;
      } catch (e) { last = e; }
    }
    if (i < 2) await new Promise(r => setTimeout(r, 800 * (i + 1) * (i + 1)));
  }
  throw Object.assign(new Error('net'), { cause: last });
}
const isNetErr = e => !e || e.message === 'net' || /fetch|load failed|network|internet/i.test(e.message || '');
/* ---------- Connexion (code Kalo) et déconnexion ---------- */
async function sha256(t) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const freshState = () => ({ profile: null, apiKey: '', days: {}, foods: {}, meals: [] });
// Formulaire avec prénom + code (champ mot de passe) : le téléphone propose de l'enregistrer.
function loginForm(id) {
  return `<form id="${id}-form" autocomplete="on">
    <label class="field"><span>Prénom</span><input class="input" name="username" id="${id}-who" autocomplete="username" value="${esc(S.who || '')}" placeholder="ex. Francisco"></label>
    <label class="field"><span>Mot de passe (ou code Kalo)</span><input class="input" type="password" name="password" id="${id}-code" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="ton mot de passe"></label>
    <button class="btn" type="submit" id="${id}-go">Se connecter</button>
  </form>
  <p class="muted small" style="margin:10px 4px 0">ℹ️ Ici, on <b>se connecte</b>. Pas encore de mot de passe simple ? Crée-le d'abord sur l'appareil déjà connecté (Profil → 🔑 Mot de passe simple), ou colle ton long code Kalo dans le champ.</p>
  <p class="muted small" style="margin:6px 4px 0">🔑 Ton téléphone (ou ton navigateur) te proposera d'enregistrer le mot de passe : accepte. La prochaine fois, il le remplira tout seul.</p>`;
}
function bindLoginForm(root, id, onDone) {
  $(`#${id}-form`, root).onsubmit = async ev => {
    ev.preventDefault();
    const pass = $(`#${id}-code`, root).value.trim(), who = $(`#${id}-who`, root).value.trim();
    if (!pass) return toast('Tape ton mot de passe');
    const btn = $(`#${id}-go`, root); btn.disabled = true; btn.textContent = 'Connexion…';
    // 1) prénom + mot de passe simple ; 2) sinon, si ça ressemble à un code Kalo, on l'utilise tel quel
    let code = null, viaPw = false;
    try {
      const lr = await relayFetch(`/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: who, password: pass }) });
      if (lr.ok) { code = (await lr.json()).code; viaPw = true; }
      else if (lr.status === 429) { btn.disabled = false; btn.textContent = 'Se connecter'; return toast('Trop d\'essais : réessaie dans 15 minutes'); }
    } catch {}
    if (!code && pass.replace(/\s+/g, '').length >= 24) code = pass.replace(/\s+/g, '');
    if (!code) { btn.disabled = false; btn.textContent = 'Se connecter'; return toast('Prénom ou mot de passe incorrect'); }
    const r = await loginWith(code, who);
    if (r.ok && viaPw) { S.pwName = who; rawSave(); }
    btn.disabled = false; btn.textContent = 'Se connecter';
    if (!r.ok) return toast(r.err || 'Connexion impossible');
    onDone();
  };
}
// Se connecter : si l'appareil contient les données d'un AUTRE compte, on les retire d'abord (elles sont déjà en ligne).
async function loginWith(code, who) {
  const h = await sha256(code);
  const hasLocal = !!S.profile || Object.keys(S.days || {}).length > 0 || (S.meals || []).length > 0;
  if (hasLocal && S.linkedHash && S.linkedHash !== h) { const k = S.apiKey; S = freshState(); S.apiKey = k; }
  // Nouvel appareil (jamais connecté) alors que le compte existe déjà en ligne : on prend le compte en ligne tel quel,
  // sans y mélanger ce qui a été tapé ici pour essayer (ex. le questionnaire refait sur l'ordi).
  else if (hasLocal && !S.linkedHash) {
    try {
      const r = await relayFetch(`/data`, { headers: { 'X-Kalo-Code': code }, cache: 'no-store' });
      if (r.ok && (await r.json()).doc?.profile) { const k = S.apiKey; S = freshState(); S.apiKey = k; }
    } catch {}
  }
  if (!S.profile) { S.days = {}; S.foods = {}; S.meals = []; S.tomb = {}; }
  S.garminCode = code; S.who = who || S.who || ''; S.garminAuto = S.garminAuto !== false; S.syncOnce = false;
  lastSnap = snapOf(S); rawSave();
  const ok = await cloudSync(true);
  if (!ok) {
    const err = S.syncErr;
    if (/Code/.test(err || '')) { S.garminCode = ''; rawSave(); }
    return { ok: false, err };
  }
  S.linkedHash = h; rawSave();
  await checkStartByCode();
  if (S.profile) garminSync(true, (S.garminV || 0) < 2 ? 366 : undefined);
  return { ok: true };
}
async function logout() {
  if (!confirm('Se déconnecter de cet appareil ? Tes données restent sauvegardées en ligne : tu les retrouveras en te reconnectant.')) return;
  const ok = await cloudSync(true);
  if (!ok && !confirm(`La sauvegarde en ligne n'a pas marché (${S.syncErr || 'erreur'}). Te déconnecter quand même ? Les derniers changements faits sur cet appareil seraient perdus.`)) return;
  const k = S.apiKey; S = freshState(); S.apiKey = k;
  lastSnap = snapOf(S); rawSave();
  onb.i = 0; UI.view = 'jour'; UI.date = todayKey(); UI.open = new Set(); closeSheet(); render(); toast('Déconnecté');
}
let syncBusy = false, syncTimer = null, syncAgain = false;
function scheduleSync() {
  if (!S.garminCode) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(() => cloudSync(true), 2500);
}
async function cloudSync(silent) {
  if (!S.garminCode) return false;
  if (syncBusy) { syncAgain = true; return false; }
  syncBusy = true; clearTimeout(syncTimer);
  try {
    stamp();
    const r = await relayFetch(`/data`, { headers: { 'X-Kalo-Code': S.garminCode }, cache: 'no-store' });
    if (r.status === 401) throw new Error('Code refusé : vérifie-le dans Profil.');
    if (!r.ok) throw new Error('net');
    const remote = (await r.json()).doc;
    const local = docOf(S), before = JSON.stringify(local);
    const merged = remote ? mergeDocs(local, remote, !S.syncOnce && !!remote.profile) : local;
    S.days = merged.days; S.foods = merged.foods; S.meals = merged.meals; S.tomb = merged.tomb;
    S.profile = merged.profile; S.setU = merged.setU;
    if (merged.startDate !== undefined) S.startDate = merged.startDate;
    lastSnap = snapOf(S);
    const out = JSON.stringify(docOf(S));
    if (!remote || out !== JSON.stringify(remote)) {
      const p = await relayFetch(`/data`, { method: 'PUT', headers: { 'X-Kalo-Code': S.garminCode, 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: docOf(S) }) });
      if (!p.ok) throw new Error('net');
    }
    S.syncOnce = true; S.syncLast = Date.now(); S.syncErr = ''; rawSave();
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (out !== before && !$('#sheet-root').innerHTML && !typing) render();
    if (!silent) toast('Sauvegardé en ligne ✓');
    return true;
  } catch (e) {
    S.syncErr = isNetErr(e) ? 'Pas de connexion' : e.message; rawSave();
    if (!silent) toast(S.syncErr === 'Pas de connexion' ? 'Pas de connexion : la sauvegarde se fera plus tard.' : S.syncErr);
    return false;
  } finally {
    syncBusy = false;
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}
function day(k) { return S.days[k] || (S.days[k] = { entries: [] }); }
function cleanDay(k) {
  const d = S.days[k];
  if (d && !d.entries.length && d.weight == null && d.steps == null && d.kcalImport == null && d.kcalOut == null) delete S.days[k];
}
// Calories d'un jour : les repas notés, sinon le total importé.
function dayKcal(d) {
  if (!d) return null;
  if (d.entries?.length) return totals(d.entries).kcal;
  return d.kcalImport ?? null;
}

/* ====================== Dates ====================== */
const pad = n => String(n).padStart(2, '0');
const keyOf = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const dateOf = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => keyOf(new Date());
const addDays = (k, n) => { const d = dateOf(k); d.setDate(d.getDate() + n); return keyOf(d); };
const mondayOf = k => { const d = dateOf(k); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return keyOf(d); };
function isoWeek(k) {
  const d = dateOf(k); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
const DOW = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const DOW1 = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const MON = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const MONL = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
function dayLabel(k) {
  const t = todayKey();
  if (k === t) return 'Aujourd\'hui';
  if (k === addDays(t, -1)) return 'Hier';
  if (k === addDays(t, 1)) return 'Demain';
  const d = dateOf(k);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}
const AHEAD = 35;                       // on peut remplir jusqu'à 5 semaines à l'avance
const maxKey = () => addDays(todayKey(), AHEAD);
function defaultMeal() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 10.5) return 'dej';
  if (h < 14.5) return 'midi';
  if (h < 17.5) return 'coll';
  return 'soir';
}

/* ====================== Petits outils ====================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = n => Math.round(n || 0);
const r1 = n => Math.round((n || 0) * 10) / 10;
const fmt = (n, dec = 0) => (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString('fr-CH', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
// Toucher un champ chiffré sélectionne tout : on tape la nouvelle valeur sans rien effacer.
document.addEventListener('focusin', e => {
  const t = e.target;
  if (t.matches?.('input.num, input.g')) setTimeout(() => { try { t.select(); t.setSelectionRange(0, t.value.length); } catch {} }, 0);
  if (t.closest?.('.sheet')) { fitSheetToKeyboard(); setTimeout(() => showFieldInSheet(t), 350); }
});
// Clavier du téléphone : la fenêtre du bas remonte au-dessus du clavier, et le champ touché reste visible.
function fitSheetToKeyboard() {
  const sh = document.querySelector('#sheet-root .sheet'), vv = window.visualViewport;
  if (!sh || !vv) return;
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  sh.style.bottom = kb > 60 ? kb + 'px' : '';
  sh.style.maxHeight = kb > 60 ? (vv.height - 12) + 'px' : '';
  sh.classList.toggle('kb', kb > 60);
}
function showFieldInSheet(t) {
  const sh = t.closest('.sheet'); if (!sh || document.activeElement !== t) return;
  const r = t.getBoundingClientRect(), sr = sh.getBoundingClientRect();
  if (r.top < sr.top + 50 || r.bottom > sr.bottom - 16) sh.scrollTop += (r.top - sr.top) - sr.height / 3;
}
if (window.visualViewport) {
  const refit = () => { fitSheetToKeyboard(); const a = document.activeElement; if (a && a.closest?.('.sheet')) showFieldInSheet(a); };
  window.visualViewport.addEventListener('resize', refit);
  window.visualViewport.addEventListener('scroll', fitSheetToKeyboard);
}
document.addEventListener('focusout', () => setTimeout(fitSheetToKeyboard, 120));
let toastT;
function toast(msg, action, onAction) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? ` <button id="toast-act">${esc(action)}</button>` : '');
  t.hidden = false;
  if (action) $('#toast-act').onclick = () => { t.hidden = true; onAction(); };
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), action ? 5000 : 2600);
}
const ICON = {
  left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
  barcode: '<svg viewBox="0 0 24 24"><path d="M4 6v12M7 6v12M11 6v12M14 6v12M17 6v12M20 6v12"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/></svg>',
  scale: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M9 9a4 4 0 0 1 6 0l-3 3"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-8.5z"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>',
  steps: '<svg viewBox="0 0 24 24"><path d="M8 3c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5zM16 9c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5zM6 16h4M14 22h4"/></svg>',
};

/* ====================== Calculs ====================== */
function computeTargets(p) {
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'h' ? 5 : -161);
  const tdee = bmr * p.activity;
  let kcal = p.goal === 'lose' ? tdee - 500 : p.goal === 'gain' ? tdee + 300 : tdee;
  kcal = Math.max(p.sex === 'h' ? 1500 : 1200, Math.round(kcal / 10) * 10);
  const prot = Math.round(p.weight * (p.goal === 'maintain' ? 1.6 : 2));
  const fat = Math.round(kcal * 0.27 / 9);
  const carb = Math.max(0, Math.round((kcal - prot * 4 - fat * 9) / 4));
  return { kcal, p: prot, c: carb, f: fat };
}
function totals(entries) {
  return entries.reduce((a, e) => ({ kcal: a.kcal + (e.kcal || 0), p: a.p + (e.p || 0), c: a.c + (e.c || 0), f: a.f + (e.f || 0) }), { kcal: 0, p: 0, c: 0, f: 0 });
}
function latestWeight(beforeKey) {
  const keys = Object.keys(S.days).filter(k => S.days[k].weight != null && (!beforeKey || k <= beforeKey)).sort();
  return keys.length ? S.days[keys[keys.length - 1]].weight : (S.profile?.weight ?? null);
}

/* ====================== Navigation ====================== */
const UI = { view: 'jour', date: todayKey(), meal: null, open: new Set(), statMode: 'jour', statRange: 90, statLimit: 31 };
function go(view) { UI.view = view; render(); window.scrollTo(0, 0); }
$$('#tabs .tab').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
$('#fab').addEventListener('click', () => openAdd());

function renderFavsTab(app) {
  if (!UI.meal) UI.meal = UI.date === todayKey() ? defaultMeal() : 'midi';
  app.innerHTML = `<div class="top"><h1>Favoris</h1></div>
    <div id="favtab"></div>`;
  // Réutilise la feuille Favoris, mais affichée dans la page
  openFavs(null, $('#favtab', app));
}
function render() {
  const app = $('#app');
  if (!S.profile) { $('#tabs').hidden = true; return renderOnboarding(app); }
  $('#tabs').hidden = false;
  $$('#tabs .tab').forEach(b => b.classList.toggle('on', b.dataset.view === UI.view));
  if (UI.view === 'jour') renderDay(app);
  else if (UI.view === 'stats') renderStats(app);
  else if (UI.view === 'favoris') renderFavsTab(app);
  else renderProfile(app);
}

/* ====================== Premier lancement ====================== */
const onb = { i: 0, p: { sex: null, age: '', height: '', weight: '', activity: null, goal: null } };
function renderOnboarding(app) {
  const p = onb.p;
  const steps = [
    { title: 'Bienvenue 👋', lead: 'Quelques questions pour calculer ton objectif de calories. Ça prend 30 secondes.', body: `
        <div class="opts">
          <button class="opt ${p.sex === 'h' ? 'on' : ''}" data-set="sex" data-v="h"><b>Homme</b></button>
          <button class="opt ${p.sex === 'f' ? 'on' : ''}" data-set="sex" data-v="f"><b>Femme</b></button>
        </div>`, ok: () => p.sex },
    { title: 'Ton corps', lead: 'Pour estimer ce que tu dépenses chaque jour.', body: `
        <label class="field"><span>Âge</span><input class="input" inputmode="numeric" data-in="age" value="${esc(p.age)}" placeholder="ex. 38"></label>
        <label class="field"><span>Taille (cm)</span><input class="input" inputmode="numeric" data-in="height" value="${esc(p.height)}" placeholder="ex. 178"></label>
        <label class="field"><span>Poids actuel (kg)</span><input class="input" inputmode="decimal" data-in="weight" value="${esc(p.weight)}" placeholder="ex. 74,5"></label>`,
      ok: () => num(p.age) > 10 && num(p.height) > 100 && num(p.weight) > 30 },
    { title: 'Ton activité', lead: 'En moyenne, sur une semaine normale.', body: `<div class="opts">${ACTIVITY.map(a => `
        <button class="opt ${p.activity === a.v ? 'on' : ''}" data-set="activity" data-v="${a.v}"><b>${a.t}</b><span>${a.d}</span></button>`).join('')}</div>`, ok: () => p.activity },
    { title: 'Ton objectif', lead: 'Tu pourras le changer quand tu veux.', body: `<div class="opts">${GOALS.map(g => `
        <button class="opt ${p.goal === g.v ? 'on' : ''}" data-set="goal" data-v="${g.v}"><b>${g.t}</b><span>${g.d}</span></button>`).join('')}</div>`, ok: () => p.goal },
  ];
  if (onb.i === steps.length) {
    const prof = { sex: p.sex, age: num(p.age), height: num(p.height), weight: num(p.weight), activity: p.activity, goal: p.goal };
    const t = computeTargets(prof);
    app.innerHTML = `<div class="onb">
      <div class="step">C'est prêt</div>
      <h1>Ton objectif par jour</h1>
      <p class="lead">Calculé avec ta taille, ton poids, ton âge et ton activité. Modifiable dans Profil.</p>
      <div class="card hero"><div><div class="big num">${fmt(t.kcal)}</div><div class="sub">calories par jour</div></div>${ring(0, 1, 'var(--kcal)', ICON.flame)}</div>
      <div class="macros">
        ${macroCard('Protéines', t.p, t.p, 'var(--prot)', true)}${macroCard('Glucides', t.c, t.c, 'var(--carb)', true)}${macroCard('Lipides', t.f, t.f, 'var(--fat)', true)}
      </div>
      <div class="grow"></div>
      <button class="btn" id="onb-go">Commencer</button>
      <button class="btn ghost" id="onb-back">Retour</button>
    </div>`;
    $('#onb-go').onclick = () => {
      S.profile = { ...prof, targets: t };
      day(todayKey()).weight = prof.weight;
      save(); render();
    };
    $('#onb-back').onclick = () => { onb.i--; render(); };
    return;
  }
  const s = steps[onb.i];
  const restore = onb.i === 0 ? `<button class="btn ghost" id="onb-restore" style="margin-top:14px">☁️ J'ai déjà un compte Kalo : me connecter</button>` : '';
  app.innerHTML = `<div class="onb">
    <div class="progress"><i style="width:${(onb.i + 1) / (steps.length + 1) * 100}%"></i></div>
    ${onb.i === 0 ? '<img src="icon-192.png" alt="Kalo" width="72" height="72" style="border-radius:18px;margin:22px 0 4px;box-shadow:var(--shadow)">' : ''}
    <div class="step">Étape ${onb.i + 1} sur ${steps.length}</div>
    <h1>${s.title}</h1><p class="lead">${s.lead}</p>
    ${s.body}
    <div class="grow"></div>
    <button class="btn" id="onb-next" ${s.ok() ? '' : 'disabled'}>Continuer</button>
    ${restore}
    ${onb.i > 0 ? '<button class="btn ghost" id="onb-back">Retour</button>' : ''}
  </div>`;
  const refresh = () => { $('#onb-next').disabled = !s.ok(); };
  $$('[data-set]', app).forEach(b => b.onclick = () => {
    const v = b.dataset.v; p[b.dataset.set] = isNaN(v) ? v : Number(v);
    $$(`[data-set="${b.dataset.set}"]`, app).forEach(x => x.classList.toggle('on', x === b)); refresh();
  });
  $$('[data-in]', app).forEach(i => i.oninput = () => { p[i.dataset.in] = i.value; refresh(); });
  $('#onb-next').onclick = () => { onb.i++; render(); };
  if ($('#onb-restore')) $('#onb-restore').onclick = () => openSheet(`
    <h2>☁️ Me connecter</h2>
    <p class="muted" style="margin-top:-6px">Avec ton code Kalo, tu retrouves toutes tes données.</p>
    ${loginForm('rs')}`, sh => bindLoginForm(sh, 'rs', () => {
      if (!S.profile) return toast('Aucune donnée trouvée pour ce code : remplis le questionnaire.');
      closeSheet(); UI.view = 'jour'; render(); toast('Connecté ✓ · données retrouvées');
    }));
  if ($('#onb-back')) $('#onb-back').onclick = () => { onb.i--; render(); };
}

/* ====================== Vue Jour ====================== */
function ring(val, max, color, inner = '') {
  const R = 44, C = 2 * Math.PI * R, pct = Math.min(1, max ? val / max : 0);
  const over = max && val > max;
  return `<div class="ring"><svg viewBox="0 0 104 104">
      <circle cx="52" cy="52" r="${R}" fill="none" stroke="var(--card2)" stroke-width="9"/>
      <circle cx="52" cy="52" r="${R}" fill="none" stroke="${over ? 'var(--bad)' : color}" stroke-width="9" stroke-linecap="round"
        stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/></svg><div class="c">${inner}</div></div>`;
}
function macroCard(label, val, target, color, onlyTarget) {
  const left = target - val;
  if (!onlyTarget) return `<div class="macro"><div class="l2">${label}</div>
    <div class="v num">${fmt(val)}<small> / ${fmt(target)} g</small></div>
    <div class="bar"><i style="width:${Math.min(100, target ? val / target * 100 : 0)}%;background:${left < 0 ? 'var(--bad)' : color}"></i></div>
    <div class="rest ${left < 0 ? 'over' : ''}">${left >= 0 ? fmt(left) + ' g restants' : fmt(-left) + ' g en trop'}</div></div>`;
  return `<div class="macro"><div class="v num">${onlyTarget ? fmt(target) : fmt(Math.abs(left))}<small style="font-size:13px">g</small></div>
    <div class="l">${onlyTarget ? label : (left >= 0 ? label + ' restants' : label + ' en trop')}</div>
    <div class="bar"><i style="width:${Math.min(100, target ? (onlyTarget ? 100 : val / target * 100) : 0)}%;background:${color}"></i></div></div>`;
}
function renderDay(app) {
  const k = UI.date, d = S.days[k] || { entries: [] }, T = S.profile.targets, tot = totals(d.entries);
  const imported = !d.entries.length && d.kcalImport != null;
  if (imported) tot.kcal = d.kcalImport;
  const left = T.kcal - tot.kcal, today = todayKey();
  const mon = mondayOf(k);
  const strip = Array.from({ length: 7 }, (_, i) => {
    const dk = addDays(mon, i), dt = dateOf(dk), has = dayKcal(S.days[dk]) != null;
    return `<button data-day="${dk}" class="${dk === k ? 'sel' : ''} ${has ? 'has' : ''} ${dk > today ? 'future' : ''}" ${dk > maxKey() ? 'disabled' : ''}>${DOW1[dt.getDay()]}<b>${dt.getDate()}</b></button>`;
  }).join('');
  app.innerHTML = `
    <div class="top">
      <h1>${dayLabel(k)}</h1>
      <div class="datenav">
        <button class="iconbtn" id="prev" aria-label="Jour précédent">${ICON.left}</button>
        <button class="iconbtn" id="next" aria-label="Jour suivant" ${k >= maxKey() ? 'disabled' : ''}>${ICON.right}</button>
      </div>
    </div>
    <div class="weekstrip">${strip}</div>
    ${k !== today ? `<button class="today-link" id="go-today">↩ Revenir à aujourd'hui</button>` : ''}
    ${k > today ? `<div class="plan-banner">🗓️ <b>Jour à venir.</b> Ce que tu ajoutes ici est prévu ; ça comptera dans tes moyennes une fois le jour arrivé.</div>` : ''}
    <div class="card hero">
      <div><div class="big num">${fmt(tot.kcal)}<span class="big-of"> / ${fmt(T.kcal)}</span></div>
        <div class="sub">kcal mangées · <b class="${left >= 0 ? '' : 'over-t'}">${left >= 0 ? fmt(left) + ' restantes' : fmt(-left) + ' en trop'}</b></div>
        ${d.kcalOut != null ? (() => { const bal = tot.kcal - d.kcalOut, goal = S.profile.goal, good = goal === 'gain' ? bal >= 0 : bal <= 0;
          return `<div class="burn">⌚ Dépensé ${fmt(d.kcalOut)} kcal${k === today ? ' <span class="muted">(jusqu\'ici)</span>' : ''}<br><b class="${good ? 'ok-t' : 'over-t'}">${bal <= 0 ? 'Déficit ' + fmt(-bal) : 'Surplus ' + fmt(bal)} kcal</b></div>`; })() : ''}</div>
      ${ring(tot.kcal, T.kcal, 'var(--kcal)', ICON.flame)}
    </div>
    <div class="macros">
      ${macroCard('Protéines', tot.p, T.p, 'var(--prot)')}${macroCard('Glucides', tot.c, T.c, 'var(--carb)')}${macroCard('Lipides', tot.f, T.f, 'var(--fat)')}
    </div>
    <div class="quick">
      <button id="q-weight" class="${d.weight == null ? 'todo' : ''}"><span class="l">⚖️ Poids</span>${d.weight == null ? '<span class="empty">+ Ajouter</span>' : `<span class="v num">${fmt(d.weight, 1)} kg</span>`}</button>
      <button id="q-steps" class="${d.steps == null ? 'todo' : ''}"><span class="l">👟 Pas</span>${d.steps == null ? '<span class="empty">+ Ajouter</span>' : `<span class="v num">${fmt(d.steps)}</span>`}</button>
      ${S.garminCode ? `<div class="qcard"><span class="l">⌚ Dépensé</span>${d.kcalOut != null ? `<span class="v num">${fmt(d.kcalOut)}</span><span class="q-sub">${k === today ? 'kcal jusqu\'ici' : 'kcal'}</span>` : '<span class="empty">—</span>'}</div>` : ''}
    </div>
    ${S.garminCode ? `<button class="garmin-btn" id="g-sync">⌚ Récupérer pas et poids Garmin<span class="muted">${S.garminLast ? ' · ' + agoText(S.garminLast) : ''}</span></button>` : ''}
    ${MEALS.map(m => {
      const es = d.entries.filter(e => e.meal === m.id), mt = totals(es);
      const prevEs = es.length ? [] : (S.days[addDays(k, -1)]?.entries || []).filter(e => e.meal === m.id);
      const isOpen = UI.open.has(m.id) && es.length;
      return `<div class="meal ${isOpen ? 'open' : ''}">
        <div class="meal-head"><button class="meal-tg" data-toggle="${m.id}" ${es.length ? '' : 'disabled'} aria-expanded="${isOpen ? 'true' : 'false'}">
            <span class="t">${es.length ? `<i class="chev">›</i>` : ''}${m.emoji} ${m.name}${es.length ? `<span class="k num">${fmt(mt.kcal)} kcal</span>` : ''}</span>
            ${es.length ? `<span class="mm num"><b style="color:var(--prot)">P</b> ${fmt(mt.p)} · <b style="color:var(--carb)">G</b> ${fmt(mt.c)} · <b style="color:var(--fat)">L</b> ${fmt(mt.f)}<span class="muted"> · ${es.length} aliment${es.length > 1 ? 's' : ''}</span></span>` : ''}</button>
          <div class="meal-btns"><button class="addmini" data-mealmenu="${m.id}" aria-label="Options ${m.name}">⋯</button>
          <button class="addmini" data-addmeal="${m.id}" aria-label="Ajouter à ${m.name}">${ICON.plus}</button></div></div>
        ${prevEs.length ? `<button class="sameas" data-sameas="${m.id}">↺ Comme la veille <span class="muted">· ${prevEs.length} aliment${prevEs.length > 1 ? 's' : ''} · ${fmt(totals(prevEs).kcal)} kcal</span></button>` : ''}
        ${isOpen ? es.map(e => `<div class="swipe" data-swipe="${e.id}"><button class="swipe-del" data-del="${e.id}">Supprimer</button><button class="entry" data-entry="${e.id}">
            <span class="thumb">${e.img ? `<img class="thumb" src="${e.img}" alt="">` : srcEmoji(e.source)}</span>
            <span class="info"><span class="n">${isFavEntry(e) ? '<span class="fav-dot">★</span> ' : ''}${esc(e.name)}</span>
              <span class="m num">${e.grams ? fmt(e.grams) + ' g · ' : ''}<span><i class="dot" style="background:var(--prot)"></i>${fmt(e.p)}</span><span><i class="dot" style="background:var(--carb)"></i>${fmt(e.c)}</span><span><i class="dot" style="background:var(--fat)"></i>${fmt(e.f)}</span></span></span>
            <span class="kc num">${fmt(e.kcal)}</span></button></div>`).join('') : ''}
      </div>`;
    }).join('')}
    ${imported ? `<div class="card"><h3>📥 Journée importée</h3><p class="muted small" style="margin:0">Total de la journée : <b>${fmt(d.kcalImport)} kcal</b> (sans le détail des repas ni des macros). Si tu ajoutes un repas ce jour-là, ce sont tes repas qui comptent.</p></div>`
      : !d.entries.length ? '<p class="center muted small">Appuie sur le bouton <b>+</b> en bas pour ajouter un repas.</p>' : ''}
    ${d.entries.length ? `<button class="btn ghost" id="copy-day" style="margin-top:6px">📋 Copier toute la journée vers…</button>` : ''}
    ${backupDue() ? `<div class="card" style="margin-top:18px"><h3>💾 Copie de sauvegarde</h3>
      <p class="muted small" style="margin-top:0">Tes données sont seulement sur ce téléphone. Garde une copie (dans Fichiers, iCloud ou Google Drive) au cas où tu le perdrais.</p>
      <button class="btn" id="bk-go">Faire une copie</button><button class="btn danger" id="bk-later" style="color:var(--muted)">Plus tard</button></div>` : ''}
  `;
  if ($('#bk-go')) {
    $('#bk-go').onclick = () => { exportBackup(); render(); };
    $('#bk-later').onclick = () => { S.backupSnooze = Date.now(); save(); render(); };
  }
  $('#prev').onclick = () => { UI.date = addDays(k, -1); render(); };
  $('#next').onclick = () => { if (k < maxKey()) { UI.date = addDays(k, 1); render(); } };
  if ($('#go-today')) $('#go-today').onclick = () => { UI.date = today; render(); };
  $$('[data-mealmenu]', app).forEach(b => b.onclick = () => openMealMenu(k, b.dataset.mealmenu));
  $$('[data-toggle]', app).forEach(b => b.onclick = () => {
    const id = b.dataset.toggle; UI.open.has(id) ? UI.open.delete(id) : UI.open.add(id); render();
  });
  $$('[data-sameas]', app).forEach(b => b.onclick = () => {
    const src = (S.days[addDays(k, -1)]?.entries || []).filter(e => e.meal === b.dataset.sameas);
    const ids = copyEntries(src, k);
    render(); toast('Repris de la veille ✓', 'Annuler', () => undoAdd(k, ids));
  });
  if ($('#copy-day')) $('#copy-day').onclick = () => openCopy(k, null);
  $$('[data-day]', app).forEach(b => b.onclick = () => { UI.date = b.dataset.day; render(); });
  $('#q-weight').onclick = () => openBody('weight');
  $('#q-steps').onclick = () => openBody('steps');
  if ($('#g-sync')) $('#g-sync').onclick = () => garminSync(false);
  $$('[data-addmeal]', app).forEach(b => b.onclick = () => openAdd(b.dataset.addmeal));
  $$('[data-entry]', app).forEach(b => b.onclick = () => {
    const w = b.parentElement;
    if (b.dataset.swiped) return;
    if (w.classList.contains('open')) { w.classList.remove('open'); b.style.transform = ''; return; }
    openEntry(b.dataset.entry);
  });
  $$('[data-del]', app).forEach(b => b.onclick = () => deleteEntry(k, b.dataset.del));
  $$('[data-swipe]', app).forEach(w => bindSwipe(w, () => deleteEntry(k, w.dataset.swipe)));
}
/* ---------- Copier, repas favoris ---------- */
function copyEntries(list, toKey, meal) {
  const ids = [];
  for (const e of list) {
    const id = uid(); ids.push(id);
    day(toKey).entries.push({ ...e, id, time: Date.now(), meal: meal || e.meal });
    UI.open.add(meal || e.meal);
  }
  save(); return ids;
}
function undoAdd(k, ids) {
  const d = S.days[k]; if (!d) return;
  d.entries = d.entries.filter(e => !ids.includes(e.id)); cleanDay(k); save(); render();
}
const mealName = id => MEALS.find(m => m.id === id)?.name || '';
function openMealMenu(k, mealId) {
  const es = (S.days[k]?.entries || []).filter(e => e.meal === mealId);
  const m = MEALS.find(x => x.id === mealId);
  openSheet(`
    <h2>${m.emoji} ${m.name}</h2>
    <p class="muted small" style="margin:-8px 0 14px">${dayLabel(k)}${es.length ? ` · ${es.length} aliment${es.length > 1 ? 's' : ''} · ${fmt(totals(es).kcal)} kcal` : ''}</p>
    <div class="list">
      ${es.length ? `<button class="li" id="mm-fav"><span class="info"><span class="n">⭐ Enregistrer comme repas favori</span><span class="m">Pour le remettre en un geste (ex. « Crêpes banane »)</span></span></button>
      <button class="li" id="mm-copy"><span class="info"><span class="n">📋 Copier vers un autre jour</span><span class="m">Demain, la semaine prochaine…</span></span></button>` : ''}
      <button class="li" id="mm-from"><span class="info"><span class="n">📥 Reprendre d'un autre jour</span><span class="m">Ex. le dîner de jeudi passé</span></span></button>
      <button class="li" id="mm-favs"><span class="info"><span class="n">⭐ Ajouter un de mes repas favoris</span><span class="m">${S.meals.length ? S.meals.length + ' repas enregistré' + (S.meals.length > 1 ? 's' : '') : 'Aucun pour l\'instant'}</span></span></button>
      ${es.length ? `<button class="li" id="mm-clear"><span class="info"><span class="n" style="color:var(--bad)">🗑️ Vider ce repas</span></span></button>` : ''}
    </div>`, sh => {
    if ($('#mm-fav', sh)) $('#mm-fav', sh).onclick = () => openSaveFav(es, m);
    if ($('#mm-copy', sh)) $('#mm-copy', sh).onclick = () => openCopy(k, mealId);
    $('#mm-favs', sh).onclick = () => { UI.date = k; openFavs(mealId); };
    $('#mm-from', sh).onclick = () => openCopyFrom(k, mealId);
    if ($('#mm-clear', sh)) $('#mm-clear', sh).onclick = () => {
      const d = S.days[k], kept = d.entries.filter(e => e.meal !== mealId), gone = d.entries.filter(e => e.meal === mealId);
      d.entries = kept; cleanDay(k); save(); closeSheet(); render();
      toast(m.name + ' vidé', 'Annuler', () => { day(k).entries.push(...gone); save(); render(); });
    };
  });
}
function openSaveFav(es, m) {
  const t = totals(es);
  openSheet(`
    <h2>⭐ Nouveau repas favori</h2>
    <p class="muted small" style="margin:-8px 0 12px">${es.length} aliment${es.length > 1 ? 's' : ''} · ${fmt(t.kcal)} kcal · P ${fmt(t.p)} · G ${fmt(t.c)} · L ${fmt(t.f)}</p>
    <label class="field"><span>Nom du repas</span><input class="input" id="fav-n" placeholder="ex. Crêpes banane" value=""></label>
    <div class="list">${es.map(e => `<div class="li"><span class="info"><span class="n">${esc(e.name)}</span><span class="m">${e.grams ? fmt(e.grams) + ' g · ' : ''}${fmt(e.kcal)} kcal</span></span></div>`).join('')}</div>
    <button class="btn" id="fav-save">Enregistrer</button>`, sh => {
    setTimeout(() => $('#fav-n', sh).focus(), 280);
    $('#fav-save', sh).onclick = () => {
      const name = $('#fav-n', sh).value.trim() || m.name;
      S.meals.unshift({ id: uid(), name, meal: m.id, items: es.map(({ id, time, meal, ...rest }) => rest) });
      save(); closeSheet(); toast('« ' + name + ' » enregistré ⭐');
    };
  });
}
function dayChips() {
  const t = todayKey(), opts = [addDays(t, -1), t, addDays(t, 1)];
  return `<p class="muted small" style="margin:0 4px 6px">Quel jour ?</p><div class="chips" style="padding-bottom:8px">${opts.map(o => `<button class="chip ${o === UI.date ? 'on' : ''}" data-wday="${o}">${dayLabel(o)}</button>`).join('')}
    <label class="chip date-chip ${opts.includes(UI.date) ? '' : 'on'}">📅 <input type="date" id="w-date" value="${UI.date}" max="${maxKey()}"></label></div>
    <p class="muted small" style="margin:0 4px 6px">Quel repas ?</p>`;
}
function bindDayChips(root) {
  $$('[data-wday]', root).forEach(b => b.onclick = () => {
    UI.date = b.dataset.wday; $$('[data-wday]', root).forEach(x => x.classList.toggle('on', x === b));
    $('.date-chip', root).classList.remove('on'); $('#w-date', root).value = UI.date;
  });
  $('#w-date', root).onchange = ev => {
    if (!ev.target.value) return; UI.date = ev.target.value;
    $$('[data-wday]', root).forEach(x => x.classList.toggle('on', x.dataset.wday === UI.date));
    $('.date-chip', root).classList.toggle('on', !$$('[data-wday]', root).some(x => x.dataset.wday === UI.date));
  };
}
function whereBlock(target) {
  const t = todayKey(), opts = [addDays(t, -1), t, addDays(t, 1)];
  return `<div class="where">
    <div class="where-l">Ajouter à</div>
    <div class="chips" style="padding-bottom:8px">${opts.map(o => `<button class="chip ${o === UI.date ? 'on' : ''}" data-wday="${o}">${dayLabel(o)}</button>`).join('')}
      <label class="chip date-chip ${opts.includes(UI.date) ? '' : 'on'}">📅 <input type="date" id="w-date" value="${UI.date}" max="${maxKey()}"></label></div>
    <div class="chips" style="padding-bottom:4px"><button class="chip ${target ? '' : 'on'}" data-wmeal="">Repas habituel</button>${MEALS.map(m => `<button class="chip ${m.id === target ? 'on' : ''}" data-wmeal="${m.id}">${m.emoji} ${m.name}</button>`).join('')}</div>
  </div>`;
}
function bindWhere(root, onMeal) {
  $$('[data-wday]', root).forEach(b => b.onclick = () => {
    UI.date = b.dataset.wday; $$('[data-wday]', root).forEach(x => x.classList.toggle('on', x === b)); $('.date-chip', root).classList.remove('on'); $('#w-date', root).value = UI.date;
  });
  $('#w-date', root).onchange = ev => {
    if (!ev.target.value) return; UI.date = ev.target.value;
    $$('[data-wday]', root).forEach(x => x.classList.toggle('on', x.dataset.wday === UI.date));
    $('.date-chip', root).classList.toggle('on', !$$('[data-wday]', root).some(x => x.dataset.wday === UI.date));
  };
  $$('[data-wmeal]', root).forEach(b => b.onclick = () => { $$('[data-wmeal]', root).forEach(x => x.classList.toggle('on', x === b)); onMeal(b.dataset.wmeal); });
}
const favQ = { q: '' };
function favsBody() {
  return `
    <input class="input fav-search" id="fav-q" type="search" placeholder="🔎 Chercher dans mes favoris…" value="${esc(favQ.q)}" autocomplete="off">
    <h3 class="fav-h">🍽️ Repas favoris</h3>
    <div class="list" id="fav-list"></div>
    <div id="fav-foods"></div>`;
}
function favFoodsHTML() {
  const words = norm(favQ.q).split(/\s+/).filter(Boolean);
  const all = Object.values(S.foods).filter(f => f.fav && words.every(w => norm(f.name + ' ' + (f.brand || '')).includes(w)));
  if (!Object.values(S.foods).some(f => f.fav)) return `<h3 class="fav-h">⭐ Aliments favoris</h3><p class="muted small center" style="padding:10px">Touche l'étoile ☆ en haut d'un aliment pour l'ajouter ici.</p>`;
  if (!all.length) return `<p class="muted small center" style="padding:10px">Aucun aliment favori ne correspond.</p>`;
  const byName = (a, b) => a.name.localeCompare(b.name, 'fr');
  let h = '';
  const top = [...all].filter(f => (f.uses || 0) >= 2).sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 5);
  if (!words.length && top.length && all.length > 6) h += `<h3 class="fav-h">🔥 Les plus utilisés</h3><div class="list">${top.map(f => foodLi(f, 'favfood:' + f.key)).join('')}</div>`;
  for (const c of CATS) {
    const items = all.filter(f => catOf(f) === c.id).sort(byName);
    if (!items.length) continue;
    const open = words.length || UI.favOpen?.has(c.id);
    h += `<details class="fav-cat" data-cat="${c.id}" ${open ? 'open' : ''}><summary>${c.e} ${c.t} <span class="muted">· ${items.length}</span></summary>
      <div class="list">${items.map(f => foodLi(f, 'favfood:' + f.key)).join('')}</div></details>`;
  }
  return h;
}
function bindFavFoods(root, getTarget) {
  $('#fav-foods', root).innerHTML = favFoodsHTML();
  $$('.fav-cat', root).forEach(d => d.addEventListener('toggle', () => {
    if (norm(favQ.q).trim()) return;
    UI.favOpen = UI.favOpen || new Set(); d.open ? UI.favOpen.add(d.dataset.cat) : UI.favOpen.delete(d.dataset.cat);
  }));
  $$('[data-pick^="favfood:"]', root).forEach(b => b.onclick = () => {
    const f = S.foods[b.dataset.pick.slice(8)];
    UI.meal = (getTarget && getTarget()) || f?.lastMeal || (UI.date === todayKey() ? defaultMeal() : 'midi');
    if (f) openFood(f, f.barcode ? 'barcode' : 'search', { withDay: true });
  });
}
// fixedMeal : ouvert depuis un repas précis. Sinon chaque favori va dans son repas habituel (sauf choix contraire).
function openFavs(fixedMeal, inPage) {
  let target = fixedMeal || '';
  favQ.q = '';
  const draw = sh => {
    const qInp = $('#fav-q', sh);
    if (qInp && !qInp.dataset.bound) {
      qInp.dataset.bound = '1';
      qInp.oninput = () => { favQ.q = qInp.value; draw(sh); bindFavFoods(sh, () => target); };
    }
    const fw = norm(favQ.q).split(/\s+/).filter(Boolean);
    const meals = [...S.meals].filter(m => fw.every(w => norm(m.name + ' ' + m.items.map(i => i.name).join(' ')).includes(w)))
      .sort((a, b) => (b.used || 0) - (a.used || 0) || a.name.localeCompare(b.name, 'fr'));
    $('#fav-list', sh).innerHTML = meals.length ? meals.map(f => {
      const t = totals(f.items);
      return `<div class="fav-row"><button class="li" data-fav="${f.id}"><span class="info"><span class="n">${esc(f.name)}</span>
        <span class="m">${MEALS.find(m => m.id === f.meal)?.emoji || ''} ${f.items.length} aliment${f.items.length > 1 ? 's' : ''} · ${fmt(t.kcal)} kcal · P ${fmt(t.p)} · G ${fmt(t.c)} · L ${fmt(t.f)}</span></span><span class="chev-r">›</span></button>
        <button class="fav-del" data-favedit="${f.id}" aria-label="Modifier ${esc(f.name)}">✏️</button></div>`;
    }).join('') : fw.length ? '<p class="muted small center" style="padding:10px">Aucun repas favori ne correspond.</p>' : `<p class="muted small center" style="padding:14px">Pas encore de repas favori.<br>Note ton repas une fois (ex. tes crêpes), puis touche <b>⋯</b> à côté du repas → <b>Enregistrer comme repas favori</b>.</p>`;
    $$('[data-fav]', sh).forEach(b => b.onclick = () => openFavMeal(b.dataset.fav, target));
    $$('[data-favedit]', sh).forEach(b => b.onclick = () => openFavEditor(b.dataset.favedit));
  };
  if (inPage) {
    inPage.innerHTML = favsBody();
    draw(inPage); bindFavFoods(inPage, () => target);
    return;
  }
  openSheet(`
    <h2>⭐ Favoris</h2>
    <p class="muted small" style="margin:-8px 0 8px">Touche un repas ou un aliment pour choisir le jour et le repas.</p>
    ${favsBody()}`, sh => { draw(sh); bindFavFoods(sh, () => target); });
}
function openFavMeal(id, presetMeal) {
  const f = S.meals.find(x => x.id === id); if (!f) return;
  const t = totals(f.items);
  let meal = presetMeal || f.meal || 'midi';
  openSheet(`
    <h2 style="margin-bottom:4px">⭐ ${esc(f.name)}</h2>
    <p class="muted small" style="margin:0 0 12px">${f.items.length} aliment${f.items.length > 1 ? 's' : ''} · ${fmt(t.kcal)} kcal · P ${fmt(t.p)} · G ${fmt(t.c)} · L ${fmt(t.f)}</p>
    <div class="list">${f.items.map(e => `<div class="li"><span class="info"><span class="n">${esc(e.name)}</span><span class="m">${e.grams ? fmt(e.grams) + ' g · ' : ''}${fmt(e.kcal)} kcal</span></span></div>`).join('')}</div>
    ${dayChips()}
    ${mealChips(meal)}
    <button class="btn" id="fm-add">Ajouter</button>
    <button class="btn ghost" id="fm-edit">✏️ Modifier ce repas favori</button>`, sh => {
    bindDayChips(sh);
    bindMealChips(sh, m => (meal = m));
    $('#fm-edit', sh).onclick = () => openFavEditor(id);
    $('#fm-add', sh).onclick = () => {
      const k = UI.date, ids = copyEntries(f.items, k, meal);
      f.used = (f.used || 0) + 1; save();
      closeSheet(); UI.view = 'jour'; render();
      toast('« ' + f.name + ' » ajouté · ' + dayLabel(k).toLowerCase() + ' ✓', 'Annuler', () => undoAdd(k, ids));
    };
  });
}
// Change la quantité d'un aliment d'un repas favori (règle de trois, ou valeurs pour 100 g si on les a).
function scaleItem(e, grams) {
  const p = e.per100, r = p ? grams / 100 : (e.grams ? grams / e.grams : 1);
  if (p) return { ...e, grams: r0(grams), kcal: r0(p.kcal100 * r), p: r1(p.p100 * r), c: r1(p.c100 * r), f: r1(p.f100 * r) };
  return { ...e, grams: r0(grams), kcal: r0(e.kcal * r), p: r1(e.p * r), c: r1(e.c * r), f: r1(e.f * r) };
}
function openFavEditor(id) {
  const f = S.meals.find(x => x.id === id); if (!f) return;
  const items = f.items.map(e => ({ ...e }));
  let meal = f.meal || 'midi';
  const draw = sh => {
    const t = totals(items);
    $('#fe-tot', sh).textContent = `${items.length} aliment${items.length > 1 ? 's' : ''} · ${fmt(t.kcal)} kcal · P ${fmt(t.p)} · G ${fmt(t.c)} · L ${fmt(t.f)}`;
    $('#fe-list', sh).innerHTML = items.length ? items.map((e, i) => `
      <div class="fe-row">
        <div class="info"><div class="n">${esc(e.name)}</div><div class="m num" data-fesum="${i}">${fmt(e.kcal)} kcal · P ${fmt(e.p)} · G ${fmt(e.c)} · L ${fmt(e.f)}</div></div>
        ${e.grams ? `<input class="g num" data-feg="${i}" inputmode="decimal" value="${r0(e.grams)}" aria-label="Grammes"><span class="muted small">g</span>` : ''}
        <button class="fe-del" data-fedel="${i}" aria-label="Retirer ${esc(e.name)}">✕</button>
      </div>`).join('') : '<p class="muted small center" style="padding:12px">Aucun aliment. Ajoute-en un ci-dessous.</p>';
    $$('[data-feg]', sh).forEach(inp => inp.oninput = () => {
      const i = Number(inp.dataset.feg), g = num(inp.value); if (!g) return;
      items[i] = scaleItem(items[i], g);
      const e = items[i]; $(`[data-fesum="${i}"]`, sh).textContent = `${fmt(e.kcal)} kcal · P ${fmt(e.p)} · G ${fmt(e.c)} · L ${fmt(e.f)}`;
      const t2 = totals(items); $('#fe-tot', sh).textContent = `${items.length} aliment${items.length > 1 ? 's' : ''} · ${fmt(t2.kcal)} kcal · P ${fmt(t2.p)} · G ${fmt(t2.c)} · L ${fmt(t2.f)}`;
    });
    $$('[data-fedel]', sh).forEach(b => b.onclick = () => { items.splice(Number(b.dataset.fedel), 1); draw(sh); });
  };
  const store = sh => { f.name = $('#fe-name', sh).value.trim() || f.name; f.meal = meal; f.items = items; save(); };
  openSheet(`
    <h2>✏️ Modifier le repas favori</h2>
    <label class="field"><span>Nom</span><input class="input" id="fe-name" value="${esc(f.name)}"></label>
    <p class="muted small" style="margin:0 4px 6px">Repas habituel</p>
    ${mealChips(meal)}
    <p class="small" id="fe-tot" style="margin:0 4px 8px;font-weight:650"></p>
    <div class="list" id="fe-list"></div>
    <button class="btn ghost" id="fe-addfood">＋ Ajouter un aliment</button>
    <button class="btn" id="fe-save">Enregistrer</button>
    <button class="btn danger" id="fe-delete">Supprimer ce repas favori</button>`, sh => {
    bindMealChips(sh, m => (meal = m));
    draw(sh);
    $('#fe-addfood', sh).onclick = () => { store(sh); favPick = { id }; openSearch(); };
    $('#fe-save', sh).onclick = () => { store(sh); closeSheet(); if (UI.view === 'favoris') render(); toast('Repas favori enregistré ✓'); };
    $('#fe-delete', sh).onclick = () => {
      if (!confirm('Supprimer le repas favori « ' + f.name + ' » ?')) return;
      S.meals = S.meals.filter(x => x.id !== id); save(); closeSheet(); if (UI.view === 'favoris') render(); toast('Repas favori supprimé');
    };
  });
}
function openCopyFrom(k, mealId) {
  const today = todayKey();
  const opts = [...new Set([addDays(k, -1), addDays(k, -2), addDays(k, -7), today])].filter(x => x !== k && x <= maxKey());
  let src = opts[0], srcMeal = mealId;
  const label = o => o === addDays(k, -7) ? 'Même jour, sem. d\'avant' : dayLabel(o);
  openSheet(`
    <h2>📥 Reprendre d'un autre jour</h2>
    <p class="muted small" style="margin:-8px 0 12px">Vers : ${MEALS.find(m => m.id === mealId).name.toLowerCase()}, ${dayLabel(k).toLowerCase()}</p>
    <p class="muted small" style="margin:0 4px 6px">Depuis quel jour ?</p>
    <div class="chips">${opts.map((o, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-from="${o}">${label(o)}</button>`).join('')}</div>
    <label class="field"><span>Ou choisis une date</span><input class="input" type="date" id="cf-date" max="${maxKey()}" value="${src}"></label>
    <p class="muted small" style="margin:0 4px 6px">Quel repas de ce jour-là ?</p>
    <div class="chips" id="cf-meals">${MEALS.map(m => `<button class="chip ${m.id === mealId ? 'on' : ''}" data-srcmeal="${m.id}">${m.emoji} ${m.name}</button>`).join('')}</div>
    <div id="cf-prev"></div>
    <button class="btn" id="cf-go">Ajouter ici</button>`, sh => {
    const dIn = $('#cf-date', sh);
    const items = () => (S.days[src]?.entries || []).filter(e => e.meal === srcMeal);
    const upd = () => {
      const es = items();
      $('#cf-prev', sh).innerHTML = es.length
        ? `<div class="list">${es.map(e => `<div class="li"><span class="info"><span class="n">${esc(e.name)}</span><span class="m">${e.grams ? fmt(e.grams) + ' g · ' : ''}${fmt(e.kcal)} kcal</span></span></div>`).join('')}</div>`
        : `<p class="muted small center" style="padding:10px">Rien de noté dans ce repas ce jour-là.</p>`;
      $('#cf-go', sh).disabled = !es.length;
      $('#cf-go', sh).textContent = es.length ? `Ajouter ici (${es.length} aliment${es.length > 1 ? 's' : ''} · ${fmt(totals(es).kcal)} kcal)` : 'Ajouter ici';
    };
    $$('[data-from]', sh).forEach(b => b.onclick = () => { src = b.dataset.from; dIn.value = src; $$('[data-from]', sh).forEach(x => x.classList.toggle('on', x === b)); upd(); });
    dIn.onchange = () => { src = dIn.value; $$('[data-from]', sh).forEach(x => x.classList.toggle('on', x.dataset.from === src)); upd(); };
    $$('[data-srcmeal]', sh).forEach(b => b.onclick = () => { srcMeal = b.dataset.srcmeal; $$('[data-srcmeal]', sh).forEach(x => x.classList.toggle('on', x === b)); upd(); });
    upd();
    $('#cf-go', sh).onclick = () => {
      const ids = copyEntries(items(), k, mealId);
      closeSheet(); render(); toast('Ajouté ✓', 'Annuler', () => undoAdd(k, ids));
    };
  });
}
function openCopy(k, mealId) {
  const es = (S.days[k]?.entries || []).filter(e => !mealId || e.meal === mealId);
  const today = todayKey();
  const opts = [...new Set([addDays(k, 1), today, addDays(today, 1), addDays(k, 7)])].filter(x => x !== k && x <= maxKey());
  let target = opts[0];
  openSheet(`
    <h2>📋 Copier ${mealId ? 'le ' + mealName(mealId).toLowerCase() : 'la journée'}</h2>
    <p class="muted small" style="margin:-8px 0 12px">${dayLabel(k)} · ${es.length} aliment${es.length > 1 ? 's' : ''} · ${fmt(totals(es).kcal)} kcal</p>
    <p class="muted small" style="margin:0 4px 6px">Vers quel jour ?</p>
    <div class="chips">${opts.map((o, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-to="${o}">${o === addDays(k, 7) && o !== addDays(today, 1) ? 'Même jour, sem. suivante' : dayLabel(o)}</button>`).join('')}</div>
    <label class="field"><span>Ou choisis une date</span><input class="input" type="date" id="cp-date" min="${addDays(today, -365)}" max="${maxKey()}" value="${target}"></label>
    ${mealId ? `<p class="muted small" style="margin:0 4px 6px">Dans quel repas ?</p>${mealChips(mealId)}` : ''}
    <button class="btn" id="cp-go">Copier</button>`, sh => {
    let meal = mealId;
    const dIn = $('#cp-date', sh);
    $$('[data-to]', sh).forEach(b => b.onclick = () => { target = b.dataset.to; dIn.value = target; $$('[data-to]', sh).forEach(x => x.classList.toggle('on', x === b)); });
    dIn.onchange = () => { target = dIn.value; $$('[data-to]', sh).forEach(x => x.classList.toggle('on', x.dataset.to === target)); };
    if (mealId) bindMealChips(sh, m => (meal = m));
    $('#cp-go', sh).onclick = () => {
      if (!target || target > maxKey()) return toast('Choisis un jour (jusqu\'à 5 semaines à l\'avance)');
      const ids = copyEntries(es, target, mealId ? meal : null);
      closeSheet(); render();
      toast('Copié vers ' + dayLabel(target).toLowerCase() + ' ✓', 'Voir', () => { UI.date = target; UI.view = 'jour'; render(); });
      void ids;
    };
  });
}
/* ---------- Début de l'historique ---------- */
function applyStartDate(start) {
  let n = 0;
  for (const k of Object.keys(S.days)) if (k < start) { delete S.days[k]; n++; }
  S.startDate = start; save();
  return n;
}
/* ---------- Garmin (via le relais privé Cloudflare) ---------- */
function agoText(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`;
}
let garminBusy = false;
async function garminSync(silent, days) {
  if (!S.garminCode || garminBusy) return;
  garminBusy = true;
  const btn = $('#g-sync'); if (btn) { btn.disabled = true; btn.firstChild.textContent = '⌚ Récupération en cours…'; }
  try {
    const full = (S.garminV || 0) < 2;
    const n = days || (full ? 366 : S.garminLast ? Math.min(60, Math.ceil((Date.now() - S.garminLast) / 864e5) + 2) : 30);
    const r = await relayFetch(`/garmin?days=${n}`, { headers: { 'X-Kalo-Code': S.garminCode }, cache: 'no-store' });
    if (r.status === 401) throw new Error('Code Garmin refusé : vérifie-le dans Profil.');
    if (!r.ok) throw new Error('Garmin ne répond pas pour l\'instant. Réessaie plus tard.');
    const data = await r.json();
    let changed = 0;
    for (const [k, v] of Object.entries(data.days || {})) {
      if (k > todayKey() || (S.startDate && k < S.startDate)) continue;
      const d = day(k);
      if (v.weight != null && d.weight !== v.weight) { d.weight = v.weight; changed++; }
      if (v.steps != null && d.steps !== v.steps) { d.steps = v.steps; changed++; }
      if (v.kcalOut != null && d.kcalOut !== v.kcalOut) { d.kcalOut = v.kcalOut; d.kcalActive = v.kcalActive ?? null; changed++; }
      cleanDay(k);
    }
    S.garminLast = Date.now(); if (n >= 366) S.garminV = 2; save();
    garminBusy = false; render();
    if (!silent) toast(changed ? `Garmin : ${changed} valeur${changed > 1 ? 's' : ''} mise${changed > 1 ? 's' : ''} à jour ✓` : 'Garmin : déjà à jour ✓');
  } catch (e) {
    garminBusy = false;
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.firstChild.textContent = '⌚ Récupérer pas et poids Garmin'; }
    if (!silent) toast(isNetErr(e) ? 'Le relais ne répond pas (connexion). Réessaie dans un moment.' : e.message);
  }
}
// Rappel de sauvegarde : dès 3 jours notés, puis toutes les semaines.
function backupDue() {
  if (S.garminCode && S.syncLast && Date.now() - S.syncLast < 3 * 864e5) return false;
  if (Object.keys(S.days).length < 3) return false;
  const last = Math.max(S.lastBackup || 0, S.backupSnooze || 0);
  return Date.now() - last > 7 * 864e5;
}
async function exportBackup() {
  const json = JSON.stringify({ ...S, apiKey: '', garminCode: '' });
  const name = `kalo-${todayKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  const prev = S.lastBackup || 0;
  S.lastBackup = Date.now(); save();
  // Sur téléphone : menu Partager (Enregistrer dans Fichiers, Drive, mail…). Sinon : téléchargement.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Copie Kalo' }); toast('Copie faite ✓'); return; }
    catch (e) { if (e.name === 'AbortError') { S.lastBackup = prev; save(); return; } }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Copie téléchargée ✓');
}
function deleteEntry(k, id) {
  const d = S.days[k]; if (!d) return;
  const i = d.entries.findIndex(x => x.id === id); if (i < 0) return;
  const [gone] = d.entries.splice(i, 1);
  cleanDay(k); save(); render();
  toast('« ' + (gone.name.length > 22 ? gone.name.slice(0, 22) + '…' : gone.name) + ' » supprimé', 'Annuler', () => {
    day(k).entries.splice(i, 0, gone); save(); render();
  });
}
// Glisser une ligne vers la gauche : un peu = bouton Supprimer, jusqu'au bout = supprimé.
function bindSwipe(wrap, onDelete) {
  const row = wrap.querySelector('.entry');
  let x0 = 0, y0 = 0, dx = 0, mode = null, base = 0;
  wrap.addEventListener('touchstart', e => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; mode = null;
    base = wrap.classList.contains('open') ? -96 : 0; row.style.transition = 'none';
  }, { passive: true });
  wrap.addEventListener('touchmove', e => {
    const t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
    if (!mode && (Math.abs(mx) > 8 || Math.abs(my) > 8)) mode = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
    if (mode !== 'h') return;
    e.preventDefault();
    dx = Math.min(0, base + mx);
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle('arm', dx < -wrap.offsetWidth * 0.45);
  }, { passive: false });
  wrap.addEventListener('touchend', () => {
    row.style.transition = '';
    if (mode !== 'h') return;
    row.dataset.swiped = '1'; setTimeout(() => delete row.dataset.swiped, 350);
    if (dx < -wrap.offsetWidth * 0.45) { row.style.transform = 'translateX(-100%)'; setTimeout(onDelete, 180); }
    else if (dx < -50) { row.style.transform = 'translateX(-96px)'; wrap.classList.add('open'); }
    else { row.style.transform = ''; wrap.classList.remove('open', 'arm'); }
  });
}
const srcEmoji = s => ({ photo: '📷', barcode: '🏷️', ai: '✨', manual: '✏️', search: '🔎' }[s] || '🍴');

/* ====================== Feuilles ====================== */
let sheetCleanup = null;
function openSheet(html, mount) {
  closeSheet();
  const root = $('#sheet-root');
  root.innerHTML = `<div class="backdrop"></div><div class="sheet" role="dialog"><div class="sheet-top"><div class="grab"></div>
    <button class="sheet-x" aria-label="Fermer"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>${html}</div>`;
  $('.backdrop', root).onclick = userCloseSheet;
  const sh = $('.sheet', root);
  $('.sheet-x', sh).onclick = userCloseSheet;
  bindSheetDrag(sh);
  sheetCleanup = mount ? mount(sh) : null;
  return sh;
}
// Tirer la fenêtre vers le bas pour la fermer (quand on est tout en haut de la fenêtre).
function bindSheetDrag(sh) {
  let y0 = 0, x0 = 0, dy = 0, mode = null, top = true;
  sh.addEventListener('touchstart', e => {
    const t = e.touches[0]; y0 = t.clientY; x0 = t.clientX; dy = 0; mode = null;
    top = sh.scrollTop <= 0 || !!e.target.closest('.sheet-top');
  }, { passive: true });
  sh.addEventListener('touchmove', e => {
    const t = e.touches[0], my = t.clientY - y0, mx = t.clientX - x0;
    if (!mode && (Math.abs(mx) > 8 || Math.abs(my) > 8)) mode = (Math.abs(my) > Math.abs(mx) && my > 0 && top) ? 'drag' : 'none';
    if (mode !== 'drag') return;
    e.preventDefault();
    dy = Math.max(0, my);
    sh.style.transition = 'none'; sh.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  sh.addEventListener('touchend', () => {
    if (mode !== 'drag') return;
    sh.style.transition = 'transform .2s ease';
    if (dy > 110) { sh.style.transform = 'translateY(100%)'; setTimeout(userCloseSheet, 180); }
    else sh.style.transform = '';
  });
}
// favPick : on est en train d'ajouter un aliment à un repas favori (et pas au journal).
let favPick = null, favPickTimer = null;
function userCloseSheet() {
  if (favPick) { const id = favPick.id; favPick = null; closeSheet(); return openFavEditor(id); }
  closeSheet();
}
function closeSheet() {
  if (typeof sheetCleanup === 'function') { try { sheetCleanup(); } catch {} }
  sheetCleanup = null;
  $('#sheet-root').innerHTML = '';
}
function mealChips(sel) {
  return `<div class="chips">${MEALS.map(m => `<button class="chip ${m.id === sel ? 'on' : ''}" data-meal="${m.id}">${m.emoji} ${m.name}</button>`).join('')}</div>`;
}
function bindMealChips(sh, onPick) {
  $$('[data-meal]', sh).forEach(b => b.onclick = () => {
    $$('[data-meal]', sh).forEach(x => x.classList.toggle('on', x === b)); onPick(b.dataset.meal);
  });
}

/* ---------- Le bouton + ---------- */
function openAdd(meal) {
  UI.meal = meal || (UI.date === todayKey() ? defaultMeal() : 'midi');
  const dateNote = UI.date !== todayKey() ? `<p class="muted small" style="margin:-8px 0 12px">Pour : ${dayLabel(UI.date).toLowerCase()}</p>` : '';
  openSheet(`
    <h2>Ajouter</h2>${dateNote}
    ${mealChips(UI.meal)}
    <div class="choices">
      <button class="choice primary" id="c-photo"><span class="ic">${ICON.camera}</span><b>Photo du repas</b><span>L'IA calcule tout</span></button>
      <button class="choice" id="c-barcode"><span class="ic">${ICON.barcode}</span><b>Code-barres</b><span>Scanner un emballage</span></button>
      <button class="choice" id="c-search"><span class="ic">${ICON.search}</span><b>Rechercher</b><span>Taper un aliment</span></button>
      <button class="choice" id="c-favs"><span class="ic">⭐</span><b>Favoris</b><span>Repas et aliments</span></button>
      <button class="choice wide" id="c-body"><span class="ic">${ICON.scale}</span><b>Poids et pas</b><span>${S.days[UI.date]?.weight != null ? 'Poids noté ✓' : 'Pas encore noté'}</span></button>
    </div>
    <button class="btn ghost" id="c-gallery" style="margin-top:12px">🖼️ Choisir une photo déjà prise</button>`, sh => {
    bindMealChips(sh, m => (UI.meal = m));
    $('#c-photo', sh).onclick = () => startPhoto(false);
    $('#c-gallery', sh).onclick = () => startPhoto(true);
    $('#c-barcode', sh).onclick = openBarcode;
    $('#c-search', sh).onclick = () => openSearch();
    $('#c-body', sh).onclick = () => openBody();
    $('#c-favs', sh).onclick = () => openFavs(UI.meal);
  });
}

/* ---------- Poids et pas ---------- */
function openBody(focus) {
  const k = UI.date, d = S.days[k] || {};
  const last = latestWeight(k);
  openSheet(`
    <h2>Poids et pas</h2>
    <p class="muted small" style="margin:-8px 0 14px">${dayLabel(k)}</p>
    <label class="field"><span>Poids (kg)${d.weight == null && last ? ` · dernier : ${fmt(last, 1)} kg` : ''}</span>
      <input class="input bigin num" id="b-w" inputmode="decimal" placeholder="${last ? fmt(last, 1) : '74,5'}" value="${d.weight != null ? fmt(d.weight, 1) : ''}"></label>
    <label class="field"><span>Pas de la journée</span>
      <input class="input bigin num" id="b-s" inputmode="numeric" placeholder="8000" value="${d.steps ?? ''}"></label>
    <button class="btn" id="b-save">Enregistrer</button>`, sh => {
    const inp = $(focus === 'steps' ? '#b-s' : '#b-w', sh);
    setTimeout(() => inp.focus(), 250);
    $('#b-save', sh).onclick = () => {
      const w = num($('#b-w', sh).value), st = num($('#b-s', sh).value);
      const dd = day(k);
      if (w != null && (w < 25 || w > 350)) return toast('Poids pas plausible');
      dd.weight = w == null ? undefined : r1(w);
      dd.steps = st == null ? undefined : r0(st);
      if (dd.weight === undefined) delete dd.weight;
      if (dd.steps === undefined) delete dd.steps;
      cleanDay(k); save(); closeSheet(); render(); toast('Enregistré');
    };
  });
}

/* ---------- Ajouter une ligne au journal ---------- */
function addEntry(e) {
  if (favPick) {
    const fav = S.meals.find(m => m.id === favPick.id);
    if (fav) {
      const { id, time, meal, img, ...rest } = e;
      fav.items.push({ ...rest, kcal: r0(e.kcal), p: r1(e.p), c: r1(e.c), f: r1(e.f) });
      save();
      clearTimeout(favPickTimer);
      const fid = fav.id;
      favPickTimer = setTimeout(() => { favPick = null; openFavEditor(fid); toast('Ajouté au repas favori ✓'); }, 60);
      return;
    }
    favPick = null;
  }
  UI.open.add(UI.meal || defaultMeal());
  day(UI.date).entries.push({ id: uid(), meal: UI.meal || defaultMeal(), time: Date.now(), ...e,
    kcal: r0(e.kcal), p: r1(e.p), c: r1(e.c), f: r1(e.f) });
  save();
}
const foodKey = f => f.key || (f.barcode ? 'b:' + f.barcode : 'n:' + String(f.name || '').toLowerCase().trim());
function toggleFavFood(f) {
  const key = foodKey(f), old = S.foods[key];
  if (old) old.fav = !old.fav;
  else S.foods[key] = { ...pick100(f), key, uses: 0, last: Date.now(), fav: true };
  save(); return S.foods[key].fav;
}
function rememberFood(f) {
  // f : { name, brand, kcal100, p100, c100, f100, barcode, serving, source }
  if (!f.name || f.kcal100 == null) return;
  const key = f.barcode ? 'b:' + f.barcode : 'n:' + f.name.toLowerCase().trim();
  const old = S.foods[key] || { uses: 0 };
  S.foods[key] = { ...old, ...f, key, uses: (old.uses || 0) + 1, last: Date.now() };
}

/* ---------- Quantité d'un aliment (base pour 100 g) ---------- */
function openFood(f, source, opts = {}) {
  const def = f.lastGrams || f.serving || 100;
  const quick = [...new Set([f.serving, 50, 100, 150, 200, 250].filter(Boolean).map(r0))].slice(0, 5);
  const fkey = foodKey(f);
  openSheet(`
    <div class="food-head"><h2 style="margin-bottom:4px">${esc(f.name)}</h2>
      <button class="star ${S.foods[fkey]?.fav ? 'on' : ''}" id="f-star" aria-label="Favori">${S.foods[fkey]?.fav ? '★' : '☆'}</button></div>
    <p class="muted small" style="margin:0 0 ${S.foods[fkey]?.fav ? 6 : 14}px">${f.brand ? esc(f.brand) + ' · ' : ''}pour 100 g : ${fmt(f.kcal100)} kcal</p>
    <div id="f-catrow" class="cat-row" ${S.foods[fkey]?.fav ? '' : 'hidden'}><span class="muted small">Rangé dans</span>
      <select id="f-cat" class="cat-sel">${CATS.map(c => `<option value="${c.id}" ${catOf(S.foods[fkey] || f) === c.id ? 'selected' : ''}>${c.e} ${c.t}</option>`).join('')}</select></div>
    ${favPick ? `<div class="plan-banner">⭐ Sera ajouté au repas favori <b>« ${esc(S.meals.find(m => m.id === favPick.id)?.name || '')} »</b></div>`
      : (opts.withDay ? dayChips() : '') + mealChips(UI.meal)}
    <label class="field"><span>Quantité (grammes)</span><input class="input bigin num" id="f-g" inputmode="decimal" value="${r0(def)}"></label>
    <div class="chips">${quick.map(g => `<button class="chip" data-g="${g}">${g === r0(f.serving) ? 'Portion · ' : ''}${g} g</button>`).join('')}</div>
    <div class="nutri" id="f-n"></div>
    <button class="btn" id="f-add">${favPick ? 'Ajouter au repas favori' : 'Ajouter'}</button>`, sh => {
    bindMealChips(sh, m => (UI.meal = m));
    if (opts.withDay) bindDayChips(sh);
    $('#f-cat', sh).onchange = ev => { const ff = S.foods[fkey]; if (ff) { ff.cat = ev.target.value; save(); if (UI.view === 'favoris') render(); toast('Rangé ✓'); } };
    $('#f-star', sh).onclick = () => {
      const on = toggleFavFood(f); const b = $('#f-star', sh);
      b.classList.toggle('on', on); b.textContent = on ? '★' : '☆';
      $('#f-catrow', sh).hidden = !on;
      if (on) { const ff = S.foods[fkey]; if (ff && !ff.cat) { ff.cat = catOf(f); save(); } $('#f-cat', sh).value = catOf(S.foods[fkey]); }
      toast(on ? 'Ajouté aux favoris ⭐' : 'Retiré des favoris');
    };
    const g = $('#f-g', sh);
    const upd = () => {
      const q = num(g.value) || 0, k = q / 100;
      $('#f-n', sh).innerHTML = `<div><b class="num">${fmt(f.kcal100 * k)}</b><small>kcal</small></div>
        <div><b class="num" style="color:var(--prot)">${fmt(f.p100 * k)}</b><small>prot. g</small></div>
        <div><b class="num" style="color:var(--carb)">${fmt(f.c100 * k)}</b><small>gluc. g</small></div>
        <div><b class="num" style="color:var(--fat)">${fmt(f.f100 * k)}</b><small>lip. g</small></div>`;
    };
    g.oninput = upd; upd();
    g.focus({ preventScroll: true });
    try { g.setSelectionRange(0, g.value.length); } catch {}
    setTimeout(() => { if (document.activeElement === g) { try { g.setSelectionRange(0, g.value.length); } catch {} } }, 300);
    $$('[data-g]', sh).forEach(b => b.onclick = () => { g.value = b.dataset.g; upd(); });
    $('#f-add', sh).onclick = () => {
      const q = num(g.value); if (!q) return toast('Indique une quantité');
      const k = q / 100;
      addEntry({ name: f.name, grams: r0(q), kcal: f.kcal100 * k, p: f.p100 * k, c: f.c100 * k, f: f.f100 * k, source, per100: pick100(f) });
      const toFav = !!favPick;
      rememberFood({ ...pick100(f), lastGrams: r0(q), ...(toFav ? {} : { lastMeal: UI.meal }) });
      save(); closeSheet();
      if (toFav) return;
      UI.view = 'jour'; render(); toast('Ajouté · ' + dayLabel(UI.date).toLowerCase() + ' ✓');
    };
  });
}
/* ---------- Catégories d'aliments (pour ranger les favoris) ---------- */
const CATS = [
  { id: 'fr', e: '🍎', t: 'Fruits' },
  { id: 'le', e: '🥦', t: 'Légumes' },
  { id: 'fe', e: '🍞', t: 'Pains, céréales et féculents' },
  { id: 'pr', e: '🍗', t: 'Viande, poisson, œufs, tofu' },
  { id: 'la', e: '🥛', t: 'Produits laitiers' },
  { id: 'ol', e: '🥜', t: 'Oléagineux' },
  { id: 'su', e: '🍫', t: 'Snacks et desserts' },
  { id: 'sa', e: '🥫', t: 'Sauces' },
  { id: 'bo', e: '🥤', t: 'Boissons' },
  { id: 'sp', e: '💪', t: 'Sport et compléments' },
  { id: 'au', e: '🍽️', t: 'Autres' },
];
// Devine la catégorie à partir du nom (pour les produits de marque, l'IA, la saisie manuelle).
const CAT_RULES = [
  ['sp', /whey|prot[eé]in|isolat|\bgel\b|isostar|sponser|maurten|[eé]lectrolyt|recovery|bcaa|cr[eé]atine|shaker/],
  ['bo', /caf[eé]|\bth[eé]\b|\bjus\b|soda|coca|bi[eè]re|\bvin\b|\beau\b|boisson|smoothie|limonade|kombucha|ice ?tea|cappuccino|latte/],
  ['sa', /sauce|vinaigrette|ketchup|mayo|moutarde|pesto|dressing|bouillon|harissa|sriracha|tabasco|aioli|a[iï]oli|houmous|hummus|guacamole/],
  ['la', /\blait\b|yogo?u?rt|yaourt|fromage|skyr|quark|s[eé]r[eé]|cr[eè]me|beurre(?! de)|mozzarella|gruy|emmental|f[eé]ta|parmesan|cottage|k[eé]fir|ricotta/],
  ['pr', /poulet|b[oœ]e?uf|porc|veau|agneau|jambon|dinde|saumon|thon|poisson|crevette|[oœ]e?uf|tofu|steak|viande|saucisse|lard|bacon|salami|cabillaud|truite|seitan|tempeh|merguez|cervelas/],
  ['su', /chocolat|biscuit|g[aâ]teau|cookie|bonbon|glace|sucre|confiture|\bmiel\b|nutella|ovomaltine|barre|chips|croissant|tarte|cr[eê]pe|gaufre|p[aâ]tisserie|caramel|sirop|brownie|muffin|donut|dessert|mousse|pudding|flan|tiramisu|cake|snack|bretzel|cacahu[eè]tes? sal/],
  ['fe', /pain|\briz\b|p[aâ]tes?\b|spaghet|nouille|quinoa|semoule|couscous|flocon|avoine|m[uü]e?sli|granola|c[eé]r[eé]ale|pomme de terre|patate|tortilla|wrap|cracker|galette|biscotte|lentille|pois chiche|haricot(?! vert)|polenta|boulgour/],
  ['fr', /pomme|banane|orange|fraise|framboise|myrtille|raisin|poire(?!au)|kiwi|mangue|ananas|abricot|p[eê]che|cerise|citron|melon|past[eè]que|fruit|avocat|datte|figue|prune|mandarine|cl[eé]mentine|grenade|litchi|papaye|nectarine|compote|baie|cassis|groseille|rhubarbe/],
  ['le', /tomate|carotte|salade|courgette|brocoli|\bchou|[eé]pinard|poivron|concombre|oignon|champignon|haricot vert|l[eé]gume|betterave|poireau|petits? pois|ma[iï]s|aubergine|asperge|c[eé]leri|courge|potiron|radis|fenouil|endive|laitue|roquette|ail\b|patate douce/],
  ['ol', /huile|noix|amande|noisette|cajou|cacahu|arachide|graine|chia|\blin\b|pistache|olive|tahini|ol[eé]agineux|s[eé]same|tournesol|coco/],
];
const guessCat = name => { const n = String(name || '').toLowerCase(); for (const [id, re] of CAT_RULES) if (re.test(n)) return id; return 'au'; };
// Anciennes catégories (avant v29) → nouvelles, sans rien perdre.
const catOf = f => {
  const c = f.cat;
  if (!c) return guessCat(f.name);
  if (c === 'pl') { const g = guessCat(f.name); return g === 'fr' || g === 'le' ? 'au' : g; }
  if (c === 'au') { const g = guessCat(f.name); return g === 'sa' ? g : c; }
  if (c === 'gr') { const g = guessCat(f.name); return g === 'sa' || g === 'la' ? g : 'ol'; }
  if (c === 'fl') { const g = guessCat(f.name); return g === 'fr' || g === 'le' ? g : 'le'; }
  return c;
};
const pick100 = f => ({ ...(f.cat ? { cat: f.cat } : {}), name: f.name, brand: f.brand || '', kcal100: f.kcal100, p100: f.p100 || 0, c100: f.c100 || 0, f100: f.f100 || 0, barcode: f.barcode || '', serving: f.serving || null, source: f.source || '' });

/* ---------- Modifier / supprimer une ligne ---------- */
// Un aliment noté → « aliment » réutilisable (valeurs pour 100 g ; sans grammes : 1 portion = 100 g).
function foodFromEntry(e) {
  if (e.per100) return { ...e.per100, name: e.name };
  if (e.grams) { const r = 100 / e.grams; return { name: e.name, kcal100: r0(e.kcal * r), p100: r1(e.p * r), c100: r1(e.c * r), f100: r1(e.f * r), source: e.source }; }
  return { name: e.name + ' (portion)', kcal100: r0(e.kcal), p100: r1(e.p), c100: r1(e.c), f100: r1(e.f), serving: 100, source: e.source };
}
const isFavEntry = e => !!S.foods[foodKey(foodFromEntry(e))]?.fav;
function openEntry(id) {
  const k = UI.date, d = S.days[k], e = d?.entries.find(x => x.id === id);
  if (!e) return;
  const scalable = e.grams && e.per100;
  const fav = isFavEntry(e);
  openSheet(`
    <div class="food-head"><h2 style="margin-bottom:4px">${esc(e.name)}</h2>
      <button class="star ${fav ? 'on' : ''}" id="e-star" aria-label="Favori">${fav ? '★' : '☆'}</button></div>
    <p class="muted small" style="margin:0 0 14px">${srcEmoji(e.source)} ${({ photo: 'Photo analysée par l\'IA', barcode: 'Code-barres', ai: 'Estimé par l\'IA', manual: 'Saisie manuelle', search: 'Base d\'aliments' })[e.source] || ''}</p>
    ${e.img ? `<img class="photo-prev" src="${e.img}" alt="">` : ''}
    <p class="muted small" style="margin:0 4px 6px">Repas (pour le déplacer, choisis-en un autre)</p>
    ${mealChips(e.meal)}
    <label class="field"><span>Jour</span><input class="input" type="date" id="e-day" value="${k}" max="${maxKey()}"></label>
    ${scalable ? `<label class="field"><span>Quantité (grammes)</span><input class="input bigin num" id="e-g" inputmode="decimal" value="${r0(e.grams)}"></label>` : ''}
    <div class="row4">
      <label class="field"><span>kcal</span><input class="input num" id="e-k" inputmode="decimal" value="${r0(e.kcal)}"></label>
      <label class="field"><span>Prot.</span><input class="input num" id="e-p" inputmode="decimal" value="${fmt(e.p)}"></label>
      <label class="field"><span>Gluc.</span><input class="input num" id="e-c" inputmode="decimal" value="${fmt(e.c)}"></label>
      <label class="field"><span>Lip.</span><input class="input num" id="e-f" inputmode="decimal" value="${fmt(e.f)}"></label>
    </div>
    <button class="btn" id="e-save">Enregistrer</button>
    <button class="btn danger" id="e-del">Supprimer</button>`, sh => {
    let meal = e.meal;
    bindMealChips(sh, m => (meal = m));
    $('#e-star', sh).onclick = () => {
      const on = toggleFavFood(foodFromEntry(e)), b = $('#e-star', sh);
      b.classList.toggle('on', on); b.textContent = on ? '★' : '☆'; render();
      toast(on ? 'Ajouté aux aliments favoris ⭐' : 'Retiré des favoris');
    };
    if (scalable) $('#e-g', sh).oninput = ev => {
      const q = num(ev.target.value) || 0, r = q / 100, p = e.per100;
      $('#e-k', sh).value = r0(p.kcal100 * r); $('#e-p', sh).value = fmt(p.p100 * r);
      $('#e-c', sh).value = fmt(p.c100 * r); $('#e-f', sh).value = fmt(p.f100 * r);
    };
    $('#e-save', sh).onclick = () => {
      const moved = e.meal !== meal, newK = $('#e-day', sh).value || k;
      e.meal = meal;
      if (scalable) e.grams = r0(num($('#e-g', sh).value) || e.grams);
      e.kcal = r0(num($('#e-k', sh).value) ?? e.kcal); e.p = r1(num($('#e-p', sh).value) ?? e.p);
      e.c = r1(num($('#e-c', sh).value) ?? e.c); e.f = r1(num($('#e-f', sh).value) ?? e.f);
      UI.open.add(meal);
      if (newK !== k && newK <= maxKey()) {
        d.entries = d.entries.filter(x => x.id !== id); cleanDay(k);
        day(newK).entries.push(e); save(); closeSheet(); render();
        toast('Déplacé vers ' + dayLabel(newK).toLowerCase() + ' ✓', 'Voir', () => { UI.date = newK; render(); });
        return;
      }
      save(); closeSheet(); render(); toast(moved ? 'Déplacé vers ' + mealName(meal).toLowerCase() + ' ✓' : 'Modifié');
    };
    $('#e-del', sh).onclick = () => {
      d.entries = d.entries.filter(x => x.id !== id); cleanDay(k); save(); closeSheet(); render(); toast('Supprimé');
    };
  });
}

/* ====================== Recherche ====================== */
function openSearch(initial = '') {
  let timer, ctrl;
  openSheet(`
    <h2>Rechercher un aliment</h2>
    ${favPick ? `<div class="plan-banner">⭐ Pour le repas favori <b>« ${esc(S.meals.find(m => m.id === favPick.id)?.name || '')} »</b></div>` : mealChips(UI.meal)}
    <input class="input" id="s-q" type="search" placeholder="ex. yogourt nature, pomme, Ovomaltine…" value="${esc(initial)}" autocomplete="off" enterkeyhint="search">
    <div id="s-res" style="margin-top:12px"></div>
    <button class="btn ghost" id="s-label">📷 Lire une étiquette nutritionnelle</button>
    <button class="btn ghost" id="s-manual">${ICON.pen} Saisie manuelle</button>`, sh => {
    $('#s-label', sh).onclick = () => startLabel('');
    bindMealChips(sh, m => (UI.meal = m));
    const q = $('#s-q', sh), res = $('#s-res', sh);
    let base = [];
    loadBase().then(() => { if (q.value.trim()) q.oninput(); });
    const draw = (remote, loading) => {
      const t = q.value.trim().toLowerCase();
      const words = norm(t).split(/\s+/).filter(Boolean);
      const mine = Object.values(S.foods)
        .filter(f => !words.length || words.every(w => norm(f.name + ' ' + (f.brand || '')).includes(w)))
        .sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (b.uses || 0) - (a.uses || 0) || (b.last || 0) - (a.last || 0)).slice(0, t ? 6 : 10);
      base = words.length ? searchBase(words).filter(f => !mine.some(m => m.name === f.name)) : [];
      let h = '';
      if (t) h += `<div class="list"><button class="li" id="s-ai"><span class="ic" style="width:24px">${ICON.spark.replace('<svg', '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"')}</span>
          <span class="info"><span class="n">Estimer « ${esc(q.value.trim())} » avec l'IA</span><span class="m">Pour un plat maison ou un repas complet</span></span></button></div>`;
      if (mine.length) h += `<p class="muted small" style="margin:14px 4px 8px">${t ? 'Mes aliments' : 'Mes aliments fréquents'}</p>
        <div class="list">${mine.map(f => foodLi(f, 'mine:' + f.key)).join('')}</div>`;
      if (base.length) h += `<p class="muted small" style="margin:14px 4px 8px">Aliments (base suisse des valeurs nutritives)</p>
        <div class="list">${base.map((f, i) => foodLi(f, 'base:' + i)).join('')}</div>`;
      if (t.length >= 2) {
        h += `<p class="muted small" style="margin:14px 4px 8px">Produits de marque (Open Food Facts)</p>`;
        if (loading) h += `<div class="spinner" style="width:24px;height:24px;margin:10px auto"></div>`;
        else if (remote === 'err') h += `<p class="muted small center">Base des marques indisponible pour l'instant.</p>`;
        else if (remote && !remote.length) h += `<p class="muted small center">Aucun produit de marque trouvé.</p>`;
        else if (remote) h += `<div class="list">${remote.map((f, i) => foodLi(f, 'off:' + i)).join('')}</div>`;
      }
      if (!t && !mine.length) h = `<p class="muted small center" style="padding:16px">Tape le nom d'un aliment. Ceux que tu ajoutes seront gardés ici pour la prochaine fois.</p>`;
      res.innerHTML = h;
      if ($('#s-ai', res)) $('#s-ai', res).onclick = () => runAI({ text: q.value.trim() });
      $$('[data-pick]', res).forEach(b => b.onclick = () => {
        const [src, id] = b.dataset.pick.split(/:(.*)/s);
        const f = src === 'mine' ? S.foods[id] : src === 'base' ? base[Number(id)] : remote[Number(id)];
        openFood(f, f.source === 'barcode' ? 'barcode' : 'search');
      });
    };
    q.oninput = () => {
      clearTimeout(timer); ctrl?.abort(); draw(null, false);
      const t = q.value.trim(); if (t.length < 2) return;
      timer = setTimeout(async () => {
        draw(null, true); const c = (ctrl = new AbortController()); let late = false;
        const tid = setTimeout(() => { late = true; c.abort(); }, 9000);
        try { draw(await offSearch(t, c.signal), false); }
        catch (err) { if (late || err.name !== 'AbortError') draw('err', false); }
        finally { clearTimeout(tid); }
      }, 550);
    };
    q.addEventListener('keydown', ev => { if (ev.key === 'Enter') q.blur(); });
    draw(null, false);
    if (initial) q.oninput(); else setTimeout(() => q.focus(), 250);
    $('#s-manual', sh).onclick = () => openManual(q.value.trim());
    return () => { clearTimeout(timer); ctrl?.abort(); };
  });
}
/* ---------- Base suisse des valeurs nutritives (OSAV, naehrwertdaten.ch), dans l'app ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe');
let BASE = null;
function loadBase() {
  if (BASE) return Promise.resolve(BASE);
  return fetch('aliments.json').then(r => r.json()).then(rows => (BASE = rows.map(([name, syn, kcal, p, c, f, cat]) => ({
    name, brand: '', kcal100: kcal, p100: p, c100: c, f100: f, cat: cat || undefined, source: 'search', _n: norm(name + ' ' + syn), _h: norm(name.split(',')[0]),
  })))).catch(() => (BASE = []));
}
function searchBase(words) {
  if (!BASE) return [];
  const score = f => {
    let s = 0;
    for (const w of words) {
      if (!f._n.includes(w)) return -1;
      if (f._h.startsWith(w)) s += 3; else if (new RegExp('(^|[^a-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(f._n)) s += 2; else s += 1;
    }
    if (/\bcru(e)?\b/.test(f._n)) s += 0.5;          // l'aliment de base avant ses préparations
    return s - f.name.length / 200;
  };
  return BASE.map(f => [score(f), f]).filter(x => x[0] >= 0).sort((a, b) => b[0] - a[0]).slice(0, 12).map(x => x[1]);
}
function foodLi(f, pickId) {
  return `<button class="li" data-pick="${esc(pickId)}"><span class="info"><span class="n">${f.fav ? '<span style="color:#f5b301">★</span> ' : ''}${esc(f.name)}</span>
    <span class="m">${f.brand ? esc(f.brand) + ' · ' : ''}${fmt(f.kcal100)} kcal / 100 g · P ${fmt(f.p100)} · G ${fmt(f.c100)} · L ${fmt(f.f100)}</span></span>
    ${f.lastGrams ? `<span class="tag">${f.lastGrams} g</span>` : ''}</button>`;
}

/* ---------- Open Food Facts ---------- */
function offToFood(p, barcode) {
  const n = p.nutriments || {};
  let kcal = n['energy-kcal_100g'];
  if (kcal == null && n['energy_100g'] != null) kcal = n['energy_100g'] / 4.184;
  if (kcal == null) return null;
  const name = p.product_name_fr || p.product_name || p.generic_name_fr || p.generic_name;
  if (!name) return null;
  return {
    name: name.trim(), brand: (p.brands || '').split(',')[0].trim(), barcode: barcode || p.code || '',
    kcal100: r0(kcal), p100: r1(n.proteins_100g), c100: r1(n.carbohydrates_100g), f100: r1(n.fat_100g),
    serving: p.serving_quantity ? r0(num(p.serving_quantity)) : null, source: 'barcode',
  };
}
async function offSearch(t, signal) {
  const fields = 'code,product_name,product_name_fr,generic_name_fr,brands,nutriments,serving_quantity';
  // Base suisse d'abord (produits Migros, Coop…), puis la base française si elle ne répond pas.
  let j = null;
  for (const host of ['ch', 'fr', 'world']) {
    try {
      const r = await fetch(`https://${host}.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(t)}&search_simple=1&action=process&json=1&page_size=24&fields=${fields}`, { signal });
      if (r.ok) { j = await r.json(); break; }
    } catch (e) { if (e.name === 'AbortError') throw e; }
  }
  if (!j) throw new Error('off');
  return (j.products || []).map(p => offToFood(p)).filter(Boolean).map(f => ({ ...f, source: 'search' })).slice(0, 15);
}
async function offProduct(code) {
  const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=code,product_name,product_name_fr,generic_name_fr,brands,nutriments,serving_quantity`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.status === 1 ? offToFood(j.product, code) : null;
}

/* ---------- Saisie manuelle ---------- */
function openManual(name = '') {
  openSheet(`
    <h2>Saisie manuelle</h2>
    ${mealChips(UI.meal)}
    <label class="field"><span>Nom</span><input class="input" id="m-n" value="${esc(name)}" placeholder="ex. Sandwich jambon"></label>
    <label class="field"><span>Calories (kcal)</span><input class="input num" id="m-k" inputmode="decimal" placeholder="0"></label>
    <div class="row2" style="grid-template-columns:repeat(3,1fr)">
      <label class="field"><span>Protéines (g)</span><input class="input num" id="m-p" inputmode="decimal" placeholder="0"></label>
      <label class="field"><span>Glucides (g)</span><input class="input num" id="m-c" inputmode="decimal" placeholder="0"></label>
      <label class="field"><span>Lipides (g)</span><input class="input num" id="m-f" inputmode="decimal" placeholder="0"></label>
    </div>
    <button class="btn" id="m-add">Ajouter</button>`, sh => {
    bindMealChips(sh, m => (UI.meal = m));
    $('#m-add', sh).onclick = () => {
      const n = $('#m-n', sh).value.trim(), k = num($('#m-k', sh).value);
      if (!n || k == null) return toast('Il faut au moins un nom et les calories');
      addEntry({ name: n, kcal: k, p: num($('#m-p', sh).value) || 0, c: num($('#m-c', sh).value) || 0, f: num($('#m-f', sh).value) || 0, source: 'manual' });
      closeSheet(); UI.view = 'jour'; render(); toast('Ajouté ✓');
    };
  });
}

/* ====================== Code-barres ====================== */
// Vérifie le chiffre de contrôle du code-barres : évite les fausses lectures.
function validEAN(c) {
  if (![8, 12, 13].includes(c.length)) return false;
  const d = c.padStart(13, '0').split('').map(Number), chk = d.pop();
  const sum = d.reduce((a, n, i) => a + n * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === chk;
}
// Lecteur : celui du téléphone s'il sait lire les codes-barres (Android), sinon le moteur ZXing (iPhone).
const BD_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/dist/es/ponyfill.js/+esm';
const BC_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let detectorPromise = null;
function getDetector() {
  return (detectorPromise ||= (async () => {
    if ('BarcodeDetector' in window) {
      try {
        const sup = await window.BarcodeDetector.getSupportedFormats();
        if (sup.includes('ean_13')) return new window.BarcodeDetector({ formats: BC_FORMATS.filter(f => sup.includes(f)) });
      } catch {}
    }
    const m = await import(BD_URL);
    return new m.BarcodeDetector({ formats: BC_FORMATS });
  })().catch(e => { detectorPromise = null; throw e; }));
}
// La caméra reste prête 60 s après la fermeture : un 2e scan juste après ne redemande pas l'autorisation.
let camStream = null, camOff = null;
async function getCamera() {
  clearTimeout(camOff);
  if (camStream && camStream.getVideoTracks().some(t => t.readyState === 'live')) return camStream;
  camStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  return camStream;
}
function releaseCamera() {
  clearTimeout(camOff);
  camOff = setTimeout(() => { camStream?.getTracks().forEach(t => t.stop()); camStream = null; }, 60000);
}
document.addEventListener('visibilitychange', () => { if (document.hidden && camStream && !document.getElementById('bc-video')) { camStream.getTracks().forEach(t => t.stop()); camStream = null; } });
function openBarcode() {
  let stream = null, stopped = false, done = false, timer = null;
  const stop = () => {
    stopped = true; clearTimeout(timer);
    const v = document.getElementById('bc-video'); if (v) v.srcObject = null;
    if (stream) releaseCamera(); stream = null;
  };
  openSheet(`
    <h2>Scanner un code-barres</h2>
    <div class="scanbox" id="scanbox">
      <video id="bc-video" playsinline muted autoplay></video>
      <div class="aim"><i></i></div>
      <button class="torch" id="bc-torch" hidden aria-label="Lampe">💡</button>
    </div>
    <p class="muted small center" id="bc-msg">Démarrage de la caméra…</p>
    <div class="row2" style="grid-template-columns:1fr auto;margin-top:10px">
      <input class="input num" id="bc-in" inputmode="numeric" placeholder="ou tape les chiffres">
      <button class="btn" id="bc-go" style="margin:0;width:auto;padding:0 18px">OK</button>
    </div>`, sh => {
    const msg = $('#bc-msg', sh), video = $('#bc-video', sh);
    const lookup = async code => {
      if (done) return; done = true; stop();
      msg.innerHTML = '<span class="spinner" style="display:block;width:24px;height:24px;margin:6px auto"></span>Recherche du produit ' + esc(code) + '…';
      try {
        const saved = S.foods['b:' + code];
        if (saved) return openFood(saved, 'barcode');           // produit déjà connu de Kalo (ex. étiquette lue avant)
        const f = await offProduct(code);
        if (f) return openFood(f, 'barcode');
        msg.innerHTML = `<b>Produit pas encore dans la base</b> (${esc(code)}).<br>Prends en photo son tableau nutritionnel : Kalo le retiendra pour les prochaines fois.
          <button class="btn" id="bc-label" style="margin-top:10px">📷 Photographier l'étiquette</button>
          <button class="btn ghost" id="bc-search">Le chercher par son nom</button>`;
        $('#bc-label', sh).onclick = () => startLabel(code);
        $('#bc-search', sh).onclick = () => openSearch();
      } catch {
        msg.textContent = 'Pas de connexion. Réessaie dans un instant.';
      }
    };
    $('#bc-go', sh).onclick = () => { const c = $('#bc-in', sh).value.replace(/\D/g, ''); if (c.length >= 6) { done = false; lookup(c); } };

    (async () => {
      let det;
      try {
        [det, stream] = await Promise.all([
          getDetector(),
          getCamera(),
        ]);
      } catch (e) {
        if (stream) stop();
        $('#scanbox', sh).style.display = 'none';
        msg.textContent = e?.name === 'NotAllowedError'
          ? 'Kalo n\'a pas accès à la caméra. Autorise-la dans les réglages du téléphone, ou tape le numéro.'
          : 'Le scanner n\'a pas pu démarrer. Tape le numéro sous le code-barres.';
        return;
      }
      if (stopped) return stop();
      const track = stream.getVideoTracks()[0];
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
      try {
        if (track.getCapabilities?.().torch) {
          let on = false; const tb = $('#bc-torch', sh); tb.hidden = false;
          tb.onclick = async () => { on = !on; try { await track.applyConstraints({ advanced: [{ torch: on }] }); tb.classList.toggle('on', on); } catch {} };
        }
      } catch {}
      video.srcObject = stream;
      try { await video.play(); } catch {}
      msg.textContent = 'Place le code-barres dans le cadre, à 10-20 cm.';
      // On analyse la bande centrale de l'image (là où est le cadre), plusieurs fois par seconde.
      const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
      const scan = async () => {
        if (stopped || done) return;
        try {
          const vw = video.videoWidth, vh = video.videoHeight;
          if (vw && vh) {
            const sw = Math.round(vw * 0.9), shh = Math.round(vh * 0.5);
            cv.width = sw; cv.height = shh;
            cx.drawImage(video, (vw - sw) / 2, (vh - shh) / 2, sw, shh, 0, 0, sw, shh);
            const found = await det.detect(cv);
            for (const b of found) {
              const c = String(b.rawValue || '').replace(/\D/g, '');
              if (validEAN(c)) { navigator.vibrate?.(60); return lookup(c); }
            }
          }
        } catch {}
        timer = setTimeout(scan, 120);
      };
      scan();
    })();
    return stop;
  });
}

/* ====================== IA (photo et texte) ====================== */
// Les deux champs photo (appareil photo / galerie) sont écoutés une seule fois, au démarrage.
let photoMode = null;   // null = repas ; { label: true, barcode } = étiquette nutritionnelle
async function onPhotoFile(ev) {
  const inp = ev.target, file = inp.files?.[0];
  if (!file) return;
  const mode = photoMode; photoMode = null;
  openSheet(`<h2>Photo reçue</h2><div class="spinner"></div><p class="center muted">Préparation de la photo…</p>`);
  try {
    const { b64, thumb } = await shrink(file, mode ? 1568 : 1024);
    inp.value = '';
    if (mode?.label) readLabel(b64, thumb, mode.barcode);
    else runAI({ image: b64, thumb });
  } catch (e) {
    inp.value = '';
    showError('Impossible de lire cette photo. Essaie de la reprendre.', e);
  }
}
['#photo-input', '#photo-pick'].forEach(id => $(id).addEventListener('change', onPhotoFile));
function startPhoto(gallery) {
  if (!S.apiKey) return askKey();
  $(gallery ? '#photo-pick' : '#photo-input').click();
}
function showError(msg, err) {
  const detail = err ? [err.status, err.error?.error?.message || err.message || String(err)].filter(Boolean).join(' · ') : '';
  openSheet(`<h2>Oups</h2><p>${esc(msg)}</p>${detail ? `<p class="err-detail">Détail : ${esc(detail).slice(0, 300)}</p>` : ''}
    <button class="btn" id="x-ok">OK</button>`, sh => { $('#x-ok', sh).onclick = closeSheet; });
}
function askKey() {
  openSheet(`
    <h2>Activer l'analyse par IA</h2>
    <p>Pour analyser les photos, l'app a besoin de ta <b>clé IA</b> (un code secret de ton compte Anthropic). Elle est gardée seulement sur ce téléphone.</p>
    <p class="muted small">Tu ne l'as pas encore ? Je t'explique comment l'obtenir. En attendant, le code-barres et la recherche marchent sans.</p>
    <button class="btn" id="k-go">Entrer ma clé</button>
    <button class="btn ghost" id="k-later">Plus tard</button>`, sh => {
    $('#k-go', sh).onclick = () => { closeSheet(); go('profil'); setTimeout(() => $('#p-key')?.focus(), 200); };
    $('#k-later', sh).onclick = closeSheet;
  });
}
function shrink(file, max = 1024) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const draw = max => {
        const sc = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c;
      };
      const big = draw(max).toDataURL('image/jpeg', 0.85).split(',')[1];
      const thumb = draw(160).toDataURL('image/jpeg', 0.7);
      URL.revokeObjectURL(url); ok({ b64: big, thumb });
    };
    img.onerror = ko; img.src = url;
  });
}

const AI_SCHEMA = {
  type: 'object',
  properties: {
    is_food: { type: 'boolean' },
    meal_name: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, grams: { type: 'number' }, kcal: { type: 'number' },
          protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' },
        },
        required: ['name', 'grams', 'kcal', 'protein', 'carbs', 'fat'], additionalProperties: false,
      },
    },
  },
  required: ['is_food', 'meal_name', 'items'], additionalProperties: false,
};
const AI_PROMPT = `Tu es un nutritionniste. Estime le contenu nutritionnel de ce repas.
Règles :
- Découpe le repas en aliments distincts (ex. riz, poulet, sauce, légumes). Une boisson visible compte aussi.
- Pour chaque aliment : nom court en français, poids estimé en grammes (portion réellement présente), calories, protéines, glucides et lipides en grammes POUR CE POIDS.
- Pense aux matières grasses de cuisson et aux sauces, souvent oubliées.
- meal_name : un nom court pour le repas entier (ex. « Bowl poulet riz »).
- Si ce n'est pas de la nourriture, mets is_food à false et items vide.`;

let sdkPromise = null;
const loadSDK = () => (sdkPromise ||= import(SDK_URL).catch(e => { sdkPromise = null; throw Object.assign(e, { stage: 'sdk' }); }));
async function callClaude(content, maxTokens = 16000, schema = AI_SCHEMA) {
  const { default: Anthropic } = await loadSDK();
  const client = new Anthropic({ apiKey: S.apiKey, dangerouslyAllowBrowser: true, timeout: 120000, maxRetries: 1 });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('refus'), { code: 'refusal' });
  const txt = msg.content.find(b => b.type === 'text')?.text;
  if (!txt) throw new Error('Réponse vide (' + msg.stop_reason + ')');
  return JSON.parse(txt);
}
function aiErrorText(err) {
  const s = err?.status, m = (err?.error?.error?.message || err?.message || '');
  if (err?.stage === 'sdk') return "Le module IA n'a pas pu se charger (connexion internet ?).";
  if (s === 401) return 'Clé IA refusée : vérifie-la dans Profil (sans espace avant ou après).';
  if (s === 403) return "Cette clé n'a pas le droit d'utiliser l'IA (vérifie l'espace de travail de la clé).";
  if (/credit|balance|billing/i.test(m)) return 'Plus de crédit sur ton compte IA (platform.claude.com → Billing).';
  if (s === 429) return "Trop de demandes d'un coup. Réessaie dans une minute.";
  if (s === 529 || s >= 500) return 'Le service IA est surchargé. Réessaie dans un instant.';
  if (err?.code === 'refusal') return "L'IA n'a pas voulu analyser cette image.";
  if (/timeout|timed out/i.test(m)) return "L'IA a mis trop de temps. Réessaie.";
  return "L'analyse n'a pas marché.";
}

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    is_label: { type: 'boolean' },
    name: { type: 'string' }, brand: { type: 'string' },
    kcal100: { type: 'number' }, p100: { type: 'number' }, c100: { type: 'number' }, f100: { type: 'number' },
    serving_g: { type: 'number' },
  },
  required: ['is_label', 'name', 'brand', 'kcal100', 'p100', 'c100', 'f100', 'serving_g'], additionalProperties: false,
};
const LABEL_PROMPT = `Lis le tableau des valeurs nutritives sur cette photo d'emballage.
- Donne les valeurs POUR 100 g (ou 100 ml) : énergie en kcal, protéines, glucides (glucides totaux, pas seulement les sucres), lipides (matières grasses totales), en grammes.
- Si seule l'énergie en kJ est indiquée, convertis (kcal = kJ / 4,184).
- Si le tableau n'est donné que par portion, ramène à 100 g avec le poids de la portion.
- name : le nom du produit en français s'il est visible, sinon un nom court et clair ; brand : la marque si visible, sinon "".
- serving_g : poids d'une portion en grammes si indiqué, sinon 0.
- Si on ne voit pas de tableau nutritionnel lisible, mets is_label à false et 0 partout.`;
function startLabel(barcode) {
  if (!S.apiKey) return askKey();
  photoMode = { label: true, barcode: barcode || '' };
  $('#photo-input').click();
}
async function readLabel(b64, thumb, barcode) {
  openSheet(`<h2>Lecture de l'étiquette</h2><img class="photo-prev" src="${thumb}" alt="" style="max-height:140px">
    <div class="spinner"></div><p class="center muted">L'IA lit le tableau nutritionnel… (10 à 30 s)</p>`);
  let r;
  try {
    r = await callClaude([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: LABEL_PROMPT }], 8000, LABEL_SCHEMA);
  } catch (err) { return showError(aiErrorText(err), err); }
  if (!r.is_label) {
    openSheet(`<h2>Étiquette illisible</h2><p class="muted">Reprends la photo bien en face du tableau nutritionnel, sans reflet, en t'approchant.</p>
      <button class="btn" id="lb-again">📷 Reprendre la photo</button><button class="btn ghost" id="lb-manual">Saisir à la main</button>`, sh => {
      $('#lb-again', sh).onclick = () => startLabel(barcode);
      $('#lb-manual', sh).onclick = () => openManual('');
    });
    return;
  }
  openSheet(`
    <h2>Vérifie les valeurs</h2>
    <p class="muted small" style="margin:-8px 0 12px">Lues sur l'étiquette, <b>pour 100 g</b>. Corrige si besoin.${barcode ? ` Kalo retiendra ce produit pour le code-barres ${esc(barcode)}.` : ''}</p>
    <label class="field"><span>Nom du produit</span><input class="input" id="lb-n" value="${esc(r.name)}"></label>
    <label class="field"><span>Marque</span><input class="input" id="lb-b" value="${esc(r.brand)}"></label>
    <div class="row4">
      <label class="field"><span>kcal</span><input class="input num" id="lb-k" inputmode="decimal" value="${r0(r.kcal100)}"></label>
      <label class="field"><span>Prot.</span><input class="input num" id="lb-p" inputmode="decimal" value="${fmt(r.p100, 1)}"></label>
      <label class="field"><span>Gluc.</span><input class="input num" id="lb-c" inputmode="decimal" value="${fmt(r.c100, 1)}"></label>
      <label class="field"><span>Lip.</span><input class="input num" id="lb-f" inputmode="decimal" value="${fmt(r.f100, 1)}"></label>
    </div>
    <label class="field"><span>Portion (g), si indiquée</span><input class="input num" id="lb-s" inputmode="decimal" value="${r.serving_g ? r0(r.serving_g) : ''}" placeholder="facultatif"></label>
    <button class="btn" id="lb-ok">Enregistrer le produit</button>`, sh => {
    $('#lb-ok', sh).onclick = () => {
      const v = id => num($(id, sh).value);
      const food = {
        name: $('#lb-n', sh).value.trim() || 'Produit', brand: $('#lb-b', sh).value.trim(), barcode,
        kcal100: r0(v('#lb-k') || 0), p100: r1(v('#lb-p') || 0), c100: r1(v('#lb-c') || 0), f100: r1(v('#lb-f') || 0),
        serving: v('#lb-s') ? r0(v('#lb-s')) : null, source: barcode ? 'barcode' : 'search',
      };
      if (!food.kcal100) return toast('Il faut au moins les calories');
      rememberFood(food);                      // gardé tout de suite, même si on n'ajoute rien
      save();
      openFood(food, barcode ? 'barcode' : 'search');
      toast('Produit enregistré ✓');
    };
  });
}
async function runAI({ image, thumb, text }) {
  if (!S.apiKey) return askKey();
  const meal = UI.meal;
  openSheet(`
    <h2>${image ? 'Analyse de la photo' : 'Estimation par l\'IA'}</h2>
    ${thumb ? `<img class="photo-prev" src="${thumb}" alt="" style="max-height:160px">` : ''}
    <div class="spinner"></div><p class="center muted">L'IA regarde ${image ? 'ton assiette' : '« ' + esc(text) + ' »'}…</p>
    <p class="center muted small" id="ai-wait">Ça prend en général 10 à 30 secondes.</p>`);
  const t0 = Date.now();
  const tick = setInterval(() => { const w = $('#ai-wait'); if (w) w.textContent = `${Math.round((Date.now() - t0) / 1000)} s… ça prend en général 10 à 30 secondes.`; }, 1000);
  let res;
  try {
    const content = image
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text: AI_PROMPT }]
      : [{ type: 'text', text: AI_PROMPT + `\n\nRepas décrit par l'utilisateur (pas de photo) : « ${text} ». Si aucune quantité n'est donnée, prends une portion normale pour un adulte.` }];
    res = await callClaude(content);
  } catch (err) {
    clearInterval(tick);
    showError(aiErrorText(err), err);
    return;
  }
  clearInterval(tick);
  if (!res.is_food || !res.items?.length) {
    openSheet(`<h2>Pas de nourriture trouvée</h2><p class="muted">Essaie une photo plus nette, prise d'au-dessus, ou utilise la recherche.</p>
      <button class="btn" id="x-ok">OK</button>`, sh => { $('#x-ok', sh).onclick = closeSheet; });
    return;
  }
  UI.meal = meal;
  reviewAI(res, image ? 'photo' : 'ai', thumb);
}

function reviewAI(res, source, thumb) {
  const items = res.items.map(it => ({ ...it, on: true, base: { ...it } }));
  openSheet(`
    <h2 style="margin-bottom:4px">${esc(res.meal_name || 'Repas')}</h2>
    <p class="muted small" style="margin:0 0 12px">Vérifie et corrige les grammes si besoin. Tout se recalcule.</p>
    ${thumb ? `<img class="photo-prev" src="${thumb}" alt="" style="max-height:140px">` : ''}
    ${mealChips(UI.meal)}
    <div class="nutri" id="ai-tot"></div>
    <div class="list" id="ai-list">${items.map((it, i) => `
      <div class="ai-item">
        <input type="checkbox" data-on="${i}" checked aria-label="Garder ${esc(it.name)}">
        <div><div style="font-weight:600">${esc(it.name)}</div><div class="muted small num" data-sum="${i}"></div></div>
        <input class="g num" data-g="${i}" inputmode="decimal" value="${r0(it.grams)}" aria-label="Grammes">
      </div>`).join('')}</div>
    <label class="field" style="margin-top:4px"><span>Comment l'enregistrer ?</span></label>
    <div class="chips" style="padding-top:0">
      <button class="chip on" data-mode="one">Un seul plat</button>
      <button class="chip" data-mode="split">Aliment par aliment</button>
    </div>
    <button class="btn" id="ai-add">Ajouter au journal</button>
    <button class="btn ghost" id="ai-skip">Ne pas enregistrer</button>`, sh => {
    $('#ai-skip', sh).onclick = closeSheet;
    bindMealChips(sh, m => (UI.meal = m));
    let mode = 'one';
    $$('[data-mode]', sh).forEach(b => b.onclick = () => { mode = b.dataset.mode; $$('[data-mode]', sh).forEach(x => x.classList.toggle('on', x === b)); });
    const scaled = it => { const r = it.base.grams ? it.grams / it.base.grams : 1; return { kcal: it.base.kcal * r, p: it.base.protein * r, c: it.base.carbs * r, f: it.base.fat * r }; };
    const upd = () => {
      items.forEach((it, i) => { const s = scaled(it); $(`[data-sum="${i}"]`, sh).textContent = `${fmt(s.kcal)} kcal · P ${fmt(s.p)} · G ${fmt(s.c)} · L ${fmt(s.f)}`; });
      const t = items.filter(i => i.on).map(scaled).reduce((a, s) => ({ kcal: a.kcal + s.kcal, p: a.p + s.p, c: a.c + s.c, f: a.f + s.f }), { kcal: 0, p: 0, c: 0, f: 0 });
      $('#ai-tot', sh).innerHTML = `<div><b class="num">${fmt(t.kcal)}</b><small>kcal</small></div><div><b class="num" style="color:var(--prot)">${fmt(t.p)}</b><small>prot. g</small></div>
        <div><b class="num" style="color:var(--carb)">${fmt(t.c)}</b><small>gluc. g</small></div><div><b class="num" style="color:var(--fat)">${fmt(t.f)}</b><small>lip. g</small></div>`;
    };
    $$('[data-on]', sh).forEach(c => c.onchange = () => { items[c.dataset.on].on = c.checked; upd(); });
    $$('[data-g]', sh).forEach(g => g.oninput = () => { items[g.dataset.g].grams = num(g.value) || 0; upd(); });
    upd();
    $('#ai-add', sh).onclick = () => {
      const kept = items.filter(i => i.on && i.grams > 0);
      if (!kept.length) return toast('Rien à ajouter');
      kept.forEach(it => {
        const s = scaled(it);
        if (it.grams) rememberFood({ name: it.name, kcal100: r0(s.kcal / it.grams * 100), p100: r1(s.p / it.grams * 100), c100: r1(s.c / it.grams * 100), f100: r1(s.f / it.grams * 100), source: 'ai', lastGrams: r0(it.grams) });
      });
      if (mode === 'one') {
        const t = kept.map(scaled).reduce((a, s) => ({ kcal: a.kcal + s.kcal, p: a.p + s.p, c: a.c + s.c, f: a.f + s.f }), { kcal: 0, p: 0, c: 0, f: 0 });
        addEntry({ name: res.meal_name || kept.map(i => i.name).join(', '), grams: r0(kept.reduce((a, i) => a + i.grams, 0)), ...t, source, img: thumb || null,
          detail: kept.map(i => ({ name: i.name, grams: r0(i.grams) })) });
      } else {
        kept.forEach((it, idx) => { const s = scaled(it); addEntry({ name: it.name, grams: r0(it.grams), ...s, source, img: idx === 0 ? thumb || null : null,
          per100: it.grams ? { kcal100: s.kcal / it.grams * 100, p100: s.p / it.grams * 100, c100: s.c / it.grams * 100, f100: s.f / it.grams * 100 } : null }); });
      }
      save(); closeSheet(); UI.view = 'jour'; render(); toast('Ajouté ✓');
    };
  });
}

/* ====================== Semaines et mois ====================== */
function periodKey(k, type) { return type === 'week' ? mondayOf(k) : k.slice(0, 7); }
function periodStats(type) {
  const groups = {};
  const today = todayKey();
  for (const [k, d] of Object.entries(S.days)) {
    if (k > today) continue;                 // jours prévus : pas encore dans les moyennes
    const pk = periodKey(k, type);
    const g = groups[pk] || (groups[pk] = { key: pk, kcal: [], steps: [], weight: [], prot: [], bal: [] });
    const kcDay = dayKcal(d); if (kcDay != null && d.kcalOut != null && k < today) g.bal.push(kcDay - d.kcalOut);
    if (d.entries?.length) { const t = totals(d.entries); g.kcal.push(t.kcal); g.prot.push(t.p); }
    else if (d.kcalImport != null) g.kcal.push(d.kcalImport);
    if (d.steps != null) g.steps.push(d.steps);
    if (d.weight != null) g.weight.push(d.weight);
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  // Toutes les périodes, de la plus ancienne à aujourd'hui, même vides
  const keys = Object.keys(groups).sort();
  if (!keys.length) return [];
  const list = [];
  let cur = keys[0];
  const end = periodKey(todayKey(), type);
  while (cur <= end) {
    const g = groups[cur] || { key: cur, kcal: [], steps: [], weight: [], prot: [], bal: [] };
    list.push({ key: cur, kcal: avg(g.kcal), steps: avg(g.steps), weight: avg(g.weight), prot: avg(g.prot), bal: avg(g.bal), days: g.kcal.length });
    cur = type === 'week' ? addDays(cur, 7) : (() => { const [y, m] = cur.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; })();
  }
  list.forEach((p, i) => (p.prev = i > 0 ? list[i - 1] : null));
  return list;
}
function delta(metric, cur, prev) {
  if (cur == null || prev == null || !prev) return '<span class="delta neutral">–</span>';
  const pct = (cur - prev) / prev * 100;
  const goal = S.profile.goal, T = S.profile.targets.kcal;
  let cls = 'neutral';
  if (Math.abs(pct) >= 0.05) {
    if (metric === 'steps') cls = pct > 0 ? 'good' : 'bad';
    else if (metric === 'weight') cls = pct < 0 ? 'good' : 'bad';
    else if (metric === 'kcal') cls = Math.abs(cur - T) <= Math.abs(prev - T) ? 'good' : 'bad';
  }
  if (Math.abs(pct) < 0.05) return '<span class="delta neutral">= 0 %</span>';
  return `<span class="delta ${cls}">${pct > 0 ? '▲ +' : '▼ '}${fmt(pct, 1)} %</span>`;
}
const ddmm = k => k.slice(8, 10) + '/' + k.slice(5, 7);
function dayRows() {
  const today = todayKey();
  return Object.keys(S.days).filter(k => k <= today).sort().reverse().map(k => {
    const d = S.days[k], t = d.entries?.length ? totals(d.entries) : null;
    const kc = dayKcal(d);
    return { k, steps: d.steps ?? null, kcal: kc, weight: d.weight ?? null, p: t ? t.p : null, c: t ? t.c : null, f: t ? t.f : null,
      out: d.kcalOut ?? null, bal: kc != null && d.kcalOut != null && k < today ? kc - d.kcalOut : null };
  }).filter(r => r.steps != null || r.kcal != null || r.weight != null);
}
function weightSeries(rangeDays) {
  const today = todayKey(), from = rangeDays ? addDays(today, -rangeDays) : '0000';
  return Object.keys(S.days).filter(k => k <= today && k >= from && S.days[k].weight != null).sort().map(k => ({ k, w: S.days[k].weight }));
}
let WT_POINTS = [], WT_BOX = null;
function bindWeightHover(root) {
  const svg = $('.wt-svg', root); if (!svg || !WT_POINTS.length) return;
  const g = $('#wt-hover', svg), tip = $('#wt-tip', root), card = $('.wt-card', root);
  const show = clientX => {
    const r = svg.getBoundingClientRect(), sx = (clientX - r.left) / r.width * WT_BOX.W;
    let best = WT_POINTS[0]; for (const p of WT_POINTS) if (Math.abs(p.x - sx) < Math.abs(best.x - sx)) best = p;
    g.style.display = '';
    $('#wt-hl', svg).setAttribute('x1', best.x); $('#wt-hl', svg).setAttribute('x2', best.x);
    $('#wt-hp', svg).setAttribute('cx', best.x); $('#wt-hp', svg).setAttribute('cy', best.y);
    $('#wt-ha', svg).setAttribute('cx', best.x); $('#wt-ha', svg).setAttribute('cy', best.ya);
    const d = dateOf(best.k);
    tip.innerHTML = `<b>${fmt(best.w, 1)} kg</b> · ${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}<br><span style="color:#8b5cf6">moy. 7 j : ${fmt(best.avg, 1)} kg</span>`;
    tip.hidden = false;
    const cr = card.getBoundingClientRect(), px = r.left - cr.left + best.x / WT_BOX.W * r.width;
    const tw = tip.offsetWidth; tip.style.left = Math.max(8, Math.min(cr.width - tw - 8, px - tw / 2)) + 'px';
    tip.style.top = (r.top - cr.top - 6) + 'px';
  };
  const hide = () => { g.style.display = 'none'; tip.hidden = true; };
  svg.addEventListener('pointermove', e => show(e.clientX));
  svg.addEventListener('pointerdown', e => show(e.clientX));
  svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  svg.addEventListener('touchmove', e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
  document.addEventListener('pointerdown', e => { if (!svg.contains(e.target)) hide(); }, { once: true });
}
function weightCard() {
  const pts = weightSeries(UI.statRange);
  const ranges = [[90, '3 mois'], [180, '6 mois'], [0, 'Tout']];
  const chips = `<div class="seg">${ranges.map(([v, t]) => `<button class="${UI.statRange === v ? 'on' : ''}" data-range="${v}">${t}</button>`).join('')}</div>`;
  if (pts.length < 2) return `<div class="card"><h3>Poids</h3>${chips}<p class="muted small">La courbe apparaît dès 2 pesées sur la période.</p></div>`;
  const W = 330, H = 150, px = 34, py = 12;
  const ws = pts.map(p => p.w), mn = Math.min(...ws), mx = Math.max(...ws), span = Math.max(0.8, mx - mn);
  const t0 = dateOf(pts[0].k).getTime(), t1 = dateOf(pts[pts.length - 1].k).getTime() || t0 + 1;
  const x = k => px + (dateOf(k).getTime() - t0) / Math.max(1, t1 - t0) * (W - px - 6);
  const y = w => py + (1 - (w - mn + span * 0.12) / (span * 1.24)) * (H - py * 2);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.k).toFixed(1)},${y(p.w).toFixed(1)}`).join(' ');
  // Moyenne mobile 7 jours pour lisser
  const sm = pts.map((p, i) => { const win = pts.filter(q => q.k <= p.k && q.k > addDays(p.k, -7)); return { k: p.k, w: win.reduce((a, q) => a + q.w, 0) / win.length }; });
  const smPath = sm.map((p, i) => `${i ? 'L' : 'M'}${x(p.k).toFixed(1)},${y(p.w).toFixed(1)}`).join(' ');
  const first = pts[0].w, last = pts[pts.length - 1].w, pct = (last - first) / first * 100;
  const goal = S.profile.goal, good = goal === 'lose' ? pct < 0 : goal === 'gain' ? pct > 0 : Math.abs(pct) <= 1;
  const ticks = [0, 0.5, 1].map(f => pts[Math.min(pts.length - 1, Math.round(f * (pts.length - 1)))].k);
  WT_POINTS = pts.map((p, i) => ({ k: p.k, w: p.w, avg: sm[i].w, x: x(p.k), y: y(p.w), ya: y(sm[i].w) }));
  WT_BOX = { W, H, top: py };
  return `<div class="card wt-card">
    <div class="wt-head"><div><div class="muted small">Poids actuel</div><div class="wt-now num">${fmt(last, 1)}<small> kg</small></div></div>
      <span class="delta ${Math.abs(pct) < 0.005 ? 'neutral' : pct < 0 ? 'good' : 'bad'}">${pct > 0 ? '▲ +' : pct < 0 ? '▼ ' : '= '}${fmt(pct, 2)} %</span></div>
    ${chips}
    <svg class="wt-svg" viewBox="0 0 ${W} ${H + 18}">
      ${[mx, (mx + mn) / 2, mn].map(v => `<line x1="${px}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-dasharray="3 4"/><text class="axis" x="0" y="${y(v) + 3}">${fmt(v, 1)}</text>`).join('')}
      <path d="${path}" fill="none" stroke="#f97316" stroke-width="1.5" opacity=".9" stroke-linejoin="round"/>
      <path d="${smPath}" fill="none" stroke="#8b5cf6" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
      ${ticks.map((k, i) => `<text class="axis" x="${x(k)}" y="${H + 14}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${dateOf(k).getDate()} ${MON[dateOf(k).getMonth()]}</text>`).join('')}
      <g id="wt-hover" style="display:none">
        <line id="wt-hl" y1="${py}" y2="${H}" stroke="var(--text)" stroke-width="1" stroke-dasharray="2 3" opacity=".5"/>
        <circle id="wt-hp" r="4.5" fill="var(--card)" stroke="#f97316" stroke-width="2"/>
        <circle id="wt-ha" r="4.5" fill="#8b5cf6" stroke="var(--card)" stroke-width="2"/>
      </g>
    </svg>
    <div class="wt-tip" id="wt-tip" hidden></div>
    <p class="muted small" style="margin:4px 0 0">Trait violet = moyenne sur 7 jours. Orange = pesées du jour. Glisse le doigt (ou la souris) sur la courbe pour voir le poids d'un jour.</p>
  </div>`;
}
function averagesCard() {
  const rows = dayRows();
  if (!rows.length) return '';
  const avg = key => { const v = rows.map(r => r[key]).filter(x => x != null); return { v: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, n: v.length }; };
  const w = avg('weight'), st = avg('steps'), kc = avg('kcal'), pr = avg('p'), out = avg('out'), bal = avg('bal');
  const tile = (ic, lab, col, val, n, unit) => `<div class="avg"><div class="al" style="color:${col}">${ic} ${lab}</div><div class="av num">${val}<small>${unit}</small></div><div class="an">sur ${n} jour${n > 1 ? 's' : ''}</div></div>`;
  return `<h2 class="st-h">Moyennes · tout l'historique</h2>
    <div class="avgs">
      ${tile('⚖️', 'Poids', '#8b5cf6', w.v != null ? fmt(w.v, 1) : '–', w.n, ' kg')}
      ${tile('👟', 'Pas', 'var(--good)', fmt(st.v), st.n, '')}
      ${tile('🔥', 'Kcal', 'var(--carb)', fmt(kc.v), kc.n, '')}
      ${tile('⌚', 'Dépensé', 'var(--fat)', out.n ? fmt(out.v) : '–', out.n, out.n ? ' kcal' : '')}
      ${bal.n ? tile('⚖️', 'Bilan', bal.v <= 0 ? 'var(--good)' : 'var(--bad)', (bal.v > 0 ? '+' : '') + fmt(bal.v), bal.n, ' kcal') : ''}
    </div>
    <p class="muted small" style="margin:6px 4px 0">Depuis le ${shortDate(rows[rows.length - 1].k)}</p>`;
}
function cls(metric, cur, prev) {
  if (cur == null || prev == null || !prev) return '';
  const pct = (cur - prev) / prev * 100;
  // Poids : baisse = vert, hausse = rouge, 0,00 % = gris
  if (metric === 'weight') return Math.abs(pct) < 0.005 ? '' : pct < 0 ? 'good' : 'bad';
  if (Math.abs(pct) < 0.05) return '';
  const goal = S.profile.goal, T = S.profile.targets.kcal;
  if (metric === 'steps') return pct > 0 ? 'good' : 'bad';
  return Math.abs(cur - T) <= Math.abs(prev - T) ? 'good' : 'bad';
}
const pctTxt = (cur, prev) => (cur == null || prev == null || !prev) ? '' : (() => { const p = (cur - prev) / prev * 100; return Math.abs(p) < 0.005 ? '= 0,00 %' : (p > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(p), 2) + ' %'; })();
function balCell(b) {
  if (b == null) return '<td class="bal">—</td>';
  const goal = S.profile.goal, good = goal === 'gain' ? b >= 0 : goal === 'lose' ? b <= 0 : Math.abs(b) <= 200;
  return `<td class="bal ${good ? 'good' : 'bad'}">${b > 0 ? '+' : ''}${fmt(b)}</td>`;
}
function metricsTable() {
  const mode = UI.statMode;
  if (mode === 'jour') {
    const rows = dayRows(), shown = rows.slice(0, UI.statLimit);
    if (!rows.length) return '<p class="muted small center">Rien encore.</p>';
    return `<table class="mt"><thead><tr><th>Date</th><th class="c-st">Pas</th><th class="c-kc">Kcal</th><th class="c-bal">Bilan</th><th class="c-kg">Kg</th></tr></thead><tbody>
      ${shown.map(r => `<tr><td><b>${ddmm(r.k)}</b><small>${DOW[dateOf(r.k).getDay()]}</small></td><td>${r.steps != null ? fmt(r.steps) : '—'}</td><td>${r.kcal != null ? fmt(r.kcal) : '—'}</td>${balCell(r.bal)}<td>${r.weight != null ? fmt(r.weight, 1) : '—'}</td></tr>`).join('')}
      </tbody></table>${rows.length > shown.length ? `<button class="btn ghost" id="st-more">Voir plus (${rows.length - shown.length} jours)</button>` : ''}`;
  }
  const list = periodStats(mode === 'semaine' ? 'week' : 'month').filter(p => p.kcal != null || p.steps != null || p.weight != null).reverse();
  if (!list.length) return '<p class="muted small center">Rien encore.</p>';
  const lab = p => mode === 'semaine' ? `<b>${ddmm(p.key)}</b><small>sem. ${isoWeek(p.key)}</small>` : `<b>${(m => m[0].toUpperCase() + m.slice(1))(MON[Number(p.key.slice(5)) - 1])}</b><small>${p.key.slice(0, 4)}</small>`;
  const plain = (v, dec) => `<td>${v != null ? fmt(v, dec) : '—'}</td>`;
  const wcell = (cur, prev) => `<td class="${cls('weight', cur, prev)}">${cur != null ? fmt(cur, 1) : '—'}<small>${pctTxt(cur, prev)}</small></td>`;
  return `<table class="mt"><thead><tr><th>${mode === 'semaine' ? 'Sem. du' : 'Mois'}</th><th class="c-st">Pas</th><th class="c-kc">Kcal</th><th class="c-bal">Bilan</th><th class="c-kg">Kg</th></tr></thead><tbody>
    ${list.map(p => `<tr>${'<td>' + lab(p) + '</td>'}${plain(p.steps, 0)}${plain(p.kcal, 0)}${balCell(p.bal)}${wcell(p.weight, p.prev?.weight)}</tr>`).join('')}
    </tbody></table>
    <p class="legend" style="margin-top:8px">Moyennes par jour. Bilan = calories mangées − dépensées (Garmin). Le % du poids compare ${mode === 'semaine' ? 'à la semaine' : 'au mois'} d'avant : poids : vert = baisse, rouge = hausse, gris = stable.</p>`;
}
function renderStats(app) {
  app.innerHTML = `
    <div class="top"><h1>Statistiques</h1></div>
    ${weightCard()}
    ${averagesCard()}
    <div class="seg big" style="margin-top:18px">${[['jour', 'Jour'], ['semaine', 'Semaine'], ['mois', 'Mois']].map(([v, t]) => `<button class="${UI.statMode === v ? 'on' : ''}" data-mode="${v}">${t}</button>`).join('')}</div>
    <div class="card" style="padding:12px 10px">${metricsTable()}</div>
    <button class="btn ghost" id="st-csv">⬇️ Exporter mes données (CSV)</button>`;
  $$('[data-range]', app).forEach(b => b.onclick = () => { UI.statRange = Number(b.dataset.range); render(); });
  $$('[data-mode]', app).forEach(b => b.onclick = () => { UI.statMode = b.dataset.mode; UI.statLimit = 31; render(); });
  if ($('#st-more')) $('#st-more').onclick = () => { UI.statLimit += 60; render(); };
  $('#st-csv').onclick = exportCSV;
  bindWeightHover(app);
}
async function exportCSV() {
  const rows = Object.keys(S.days).sort().map(k => {
    const d = S.days[k], t = d.entries?.length ? totals(d.entries) : null;
    return [k, d.weight ?? '', d.steps ?? '', dayKcal(d) != null ? r0(dayKcal(d)) : '', d.kcalOut ?? '', t ? r1(t.p) : '', t ? r1(t.c) : '', t ? r1(t.f) : '', t ? d.entries.length : 0, k > todayKey() ? 'prevu' : ''];
  });
  const csv = 'date,poids_kg,pas,kcal_mangees,kcal_depensees,proteines_g,glucides_g,lipides_g,nb_aliments,note\n' + rows.map(r => r.join(',')).join('\n') + '\n';
  const name = `kalo-donnees-${todayKey()}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Données Kalo' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('Fichier téléchargé ✓');
}

/* ====================== Profil ====================== */
const shortDate = k => { const d = dateOf(k); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
function parseHistoryCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
  const head = split(lines[0]).map(h => norm(h));
  const col = re => head.findIndex(h => re.test(h));
  const iD = col(/^(date|jour|day)/), iWg = col(/weight_?g|poids_?g/), iW = col(/^(weight|poids)(_?kg)?$/),
        iS = col(/^(steps|pas)$/), iK = col(/^(kcal|calories|energie|energy)/);
  if (iD < 0) throw new Error('Pas de colonne « date » dans ce fichier');
  const n = v => { const x = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(x) ? null : x; };
  const out = [];
  for (const l of lines.slice(1)) {
    const c = split(l);
    const m = (c[iD] || '').match(/^(\d{4})-(\d{2})-(\d{2})/) || (c[iD] || '').match(/^(\d{2})[./](\d{2})[./](\d{4})/);
    if (!m) continue;
    const date = m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
    let w = iWg >= 0 ? n(c[iWg]) : null; if (w != null) w = w / 1000;
    if (w == null && iW >= 0) { w = n(c[iW]); if (w != null && w > 1000) w = w / 1000; }
    const st = iS >= 0 ? n(c[iS]) : null, k = iK >= 0 ? n(c[iK]) : null;
    const r = { date, weight: w != null && w > 25 && w < 350 ? r1(w) : null, steps: st != null ? r0(st) : null, kcal: k ? r0(k) : null };
    if (r.weight != null || r.steps != null || r.kcal != null) out.push(r);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
const PRESETS = [
  { t: 'Équilibré 30/40/30', v: [30, 40, 30] },
  { t: 'Riche en protéines 35/35/30', v: [35, 35, 30] },
  { t: 'Endurance 20/55/25', v: [20, 55, 25] },
  { t: 'Pauvre en glucides 30/20/50', v: [30, 20, 50] },
];
function pctOf(T) {
  if (T.pct) return { ...T.pct };
  const k = T.p * 4 + T.c * 4 + T.f * 9 || 1;
  const p = Math.round(T.p * 4 / k * 100), f = Math.round(T.f * 9 / k * 100);
  return { p, c: 100 - p - f, f };
}
const gramsFrom = (kcal, pct) => ({ p: Math.round(kcal * pct.p / 100 / 4), c: Math.round(kcal * pct.c / 100 / 4), f: Math.round(kcal * pct.f / 100 / 9) });
function renderProfile(app) {
  const P = S.profile, T = P.targets, pct = pctOf(T);
  app.innerHTML = `
    <div class="top"><h1>Profil</h1></div>
    <div class="card">
      <h3>Objectif par jour</h3>
      <label class="field"><span>Calories par jour</span><input class="input bigin num" id="t-k" inputmode="numeric" value="${T.kcal}"></label>
      <p class="muted small" style="margin:4px 4px 8px">Répartition des macros</p>
      <div class="chips" style="padding-bottom:10px">${PRESETS.map(pr => `<button class="chip" data-preset="${pr.v.join(',')}">${pr.t}</button>`).join('')}</div>
      ${[['p', 'Protéines', 'var(--prot)'], ['c', 'Glucides', 'var(--carb)'], ['f', 'Lipides', 'var(--fat)']].map(([k, l, col]) => `
        <div class="pct-row">
          <span class="pct-name"><i class="dot" style="background:${col}"></i>${l}</span>
          <button class="pct-btn" data-step="${k}:-5" aria-label="${l} moins 5 %">−</button>
          <span class="pct-in"><input class="input num" id="pc-${k}" inputmode="numeric" value="${pct[k]}"><b>%</b></span>
          <button class="pct-btn" data-step="${k}:5" aria-label="${l} plus 5 %">+</button>
          <span class="pct-g num" id="pg-${k}"></span>
        </div>`).join('')}
      <div id="pct-total" class="pct-total"></div>
      <div class="chips" style="padding:10px 0 6px">${GOALS.map(g => `<button class="chip ${P.goal === g.v ? 'on' : ''}" data-goal="${g.v}">${g.t}</button>`).join('')}</div>
      <button class="btn" id="t-save">Enregistrer</button>
      <button class="btn ghost" id="t-recalc">Recalculer avec mon poids actuel</button>
    </div>
    <div class="card">
      <h3>Analyse des photos par l'IA</h3>
      ${S.apiKey ? `<div class="key-ok">✓ Clé enregistrée sur ce téléphone<br><span class="num">${esc(S.apiKey.slice(0, 14))}…${esc(S.apiKey.slice(-4))} · ${S.apiKey.length} caractères</span></div>
      <button class="btn" id="k-test">Tester la clé</button><p class="small center" id="k-res" style="margin:8px 0 0"></p>
      <button class="btn ghost" id="k-change">Changer de clé</button>` : ''}
      <div id="k-form" ${S.apiKey ? 'hidden' : ''}>
        <p class="muted small" style="margin-top:${S.apiKey ? '14px' : '0'}">Colle ici ta clé IA (elle commence par « sk-ant- »). Elle reste sur ce téléphone.</p>
        <button class="btn" id="k-paste">📋 Coller ma clé</button>
        <p class="muted small" style="margin:10px 4px 6px">Ou appuie longtemps dans le champ ci-dessous, puis « Coller » :</p>
        <textarea class="input key-in" id="p-key" rows="2" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="sk-ant-…"></textarea>
        <p class="small" id="k-check" style="margin:6px 4px 0"></p>
        <button class="btn" id="k-save">Enregistrer la clé</button>
      </div>
    </div>
    <div class="card">
      <h3>📅 Début de l'historique</h3>
      <p class="muted small" style="margin-top:0">${S.startDate ? `Kalo commence le <b>${shortDate(S.startDate)}</b> : rien d'avant n'est gardé (ni Garmin, ni import).` : 'Kalo garde tout l\'historique.'}</p>
      <label class="field"><span>Nouvelle date de début</span><input class="input" type="date" id="sd-date" value="${S.startDate || ''}" max="${todayKey()}"></label>
      <button class="btn ghost" id="sd-go">Appliquer cette date</button>
    </div>
    <div class="card">
      <h3>☁️ Sauvegarde en ligne et ⌚ Garmin</h3>
      ${S.garminCode
        ? `<div class="key-ok">✓ Connecté${S.who ? ' : ' + esc(S.who) : ''} · sauvegarde en ligne active${S.syncLast ? '<br><span>Dernière sauvegarde ' + agoText(S.syncLast) + '</span>' : ''}${S.garminLast ? '<br><span>Garmin : dernière récupération ' + agoText(S.garminLast) + '</span>' : ''}</div>
           ${S.syncErr ? `<p class="small" style="color:var(--bad);margin:8px 4px 0">⚠️ ${esc(S.syncErr)}</p>` : ''}
           <p class="muted small" style="margin:10px 4px 0">Tes repas, poids, favoris et réglages sont gardés en ligne. Sur un autre appareil (ou si tu perds ce téléphone), colle ton code Kalo pour tout retrouver. Garde ce code précieusement.</p>
           <div class="pw-box">
             <b>🔑 Mot de passe simple</b>
             <p class="muted small" style="margin:4px 0 8px">${S.pwName ? `✓ Tu te connectes avec <b>${esc(S.pwName)}</b> + ton mot de passe.` : 'Pour te connecter avec ton prénom et un mot de passe facile, au lieu du long code.'}</p>
             <form id="pw-form" autocomplete="on">
               <input class="input" name="username" id="pw-name" autocomplete="username" value="${esc(S.pwName || S.who || '')}" placeholder="prénom" style="margin-bottom:8px">
               <input class="input" type="password" name="new-password" id="pw-pass" autocomplete="new-password" placeholder="${S.pwName ? 'nouveau mot de passe' : 'mot de passe (6 caractères min.)'}">
               <button class="btn ghost" type="submit" id="pw-go">${S.pwName ? 'Changer le mot de passe' : 'Créer mon mot de passe'}</button>
             </form>
           </div>
           <button class="btn" id="s-now">Sauvegarder maintenant</button>
           <button class="btn ghost" id="g-now">Récupérer Garmin (toute l'année)</button>
           <label class="toggle"><input type="checkbox" id="g-auto" ${S.garminAuto !== false ? 'checked' : ''}> Récupérer Garmin tout seul à l'ouverture</label>
           <button class="btn danger" id="g-off">Se déconnecter</button>`
        : `<p class="muted small" style="margin-top:0">Connecte-toi avec ton code Kalo : toutes tes données seront sauvegardées en ligne (et retrouvées sur un autre appareil), et Kalo récupère tout seul tes pas, ton poids et tes calories Garmin.</p>
           ${loginForm('pl')}`}
    </div>
    <div class="card">
      <h3>Copie dans un fichier</h3>
      <p class="muted small" style="margin-top:0">En plus de la sauvegarde en ligne, tu peux garder une copie de tes données dans un fichier.</p>
      <button class="btn ghost" id="x-exp">Télécharger une copie</button>
      <button class="btn ghost" id="x-csv2">⬇️ Exporter en CSV (tableur)</button>
      <button class="btn ghost" id="x-imp">Restaurer une copie</button>
      <input type="file" id="x-file" accept="application/json,.json" hidden>
    </div>
    <div class="card">
      <h3>Importer un historique</h3>
      <p class="muted small" style="margin-top:0">Un fichier CSV (export d'une autre app) avec une date par ligne et ton poids, tes pas et/ou tes calories. Tes repas déjà notés ne sont pas touchés.</p>
      <button class="btn ghost" id="x-csv">📥 Choisir le fichier CSV</button>
      <input type="file" id="x-csvfile" accept=".csv,text/csv,text/plain" hidden>
    </div>
    <div class="card">
      <h3>Mes infos</h3>
      <p class="muted small" style="margin:0">${P.sex === 'h' ? 'Homme' : 'Femme'} · ${P.age} ans · ${P.height} cm · ${ACTIVITY.find(a => a.v === P.activity)?.t || ''}</p>
      <button class="btn ghost" id="x-redo">Refaire le questionnaire</button>
    </div>
    <p class="center muted small">Kalo · version ${APP_VERSION} · usage personnel</p>`;
  let goal = P.goal;
  $$('[data-goal]', app).forEach(b => b.onclick = () => { goal = b.dataset.goal; $$('[data-goal]', app).forEach(x => x.classList.toggle('on', x === b)); });
  const kIn = $('#t-k');
  const readPct = () => ({ p: r0(num($('#pc-p').value) || 0), c: r0(num($('#pc-c').value) || 0), f: r0(num($('#pc-f').value) || 0) });
  const updPct = () => {
    const kc = r0(num(kIn.value) || 0), pc = readPct(), g = gramsFrom(kc, pc), sum = pc.p + pc.c + pc.f;
    ['p', 'c', 'f'].forEach(k => ($('#pg-' + k).textContent = `${fmt(g[k])} g`));
    const ok = sum === 100;
    $('#pct-total').className = 'pct-total ' + (ok ? 'ok' : 'ko');
    $('#pct-total').textContent = ok ? 'Total 100 % ✓' : `Total ${sum} % : ${sum < 100 ? 'il manque ' + (100 - sum) + ' %' : 'il y a ' + (sum - 100) + ' % de trop'}. Ajuste pour arriver à 100 %.`;
    $('#t-save').disabled = !ok || kc < 800;
    $$('[data-preset]', app).forEach(b => b.classList.toggle('on', b.dataset.preset === [pc.p, pc.c, pc.f].join(',')));
  };
  kIn.oninput = updPct;
  ['p', 'c', 'f'].forEach(k => ($('#pc-' + k).oninput = updPct));
  $$('[data-step]', app).forEach(b => b.onclick = () => {
    const [k, d] = b.dataset.step.split(':'); const i = $('#pc-' + k);
    i.value = Math.max(0, Math.min(100, (r0(num(i.value)) || 0) + Number(d))); updPct();
  });
  $$('[data-preset]', app).forEach(b => b.onclick = () => {
    const [p, c, f] = b.dataset.preset.split(',');
    $('#pc-p').value = p; $('#pc-c').value = c; $('#pc-f').value = f; updPct();
  });
  updPct();
  $('#t-save').onclick = () => {
    const kc = r0(num(kIn.value)), pc = readPct();
    P.goal = goal; P.targets = { kcal: kc, ...gramsFrom(kc, pc), pct: pc };
    save(); toast('Objectif enregistré'); render();
  };
  $('#t-recalc').onclick = () => {
    P.goal = goal; P.weight = latestWeight() || P.weight; const kc = computeTargets(P).kcal, pc = readPct(); P.targets = { kcal: kc, ...gramsFrom(kc, pc), pct: pc }; save(); render(); toast('Calories recalculées : ' + fmt(kc) + ' kcal');
  };
  // Garde seulement les caractères possibles d'une clé (enlève espaces, guillemets, caractères invisibles).
  const cleanKey = v => String(v || '').replace(/[^A-Za-z0-9_-]/g, '');
  const keyIn = $('#p-key');
  const checkKey = () => {
    const k = cleanKey(keyIn.value), out = $('#k-check');
    if (!k) { out.textContent = ''; return; }
    const ok = k.startsWith('sk-ant-') && k.length >= 90;
    out.innerHTML = `<span style="color:var(${ok ? '--good' : '--bad'});font-weight:650">${ok ? '✓' : '⚠️'} ${esc(k.slice(0, 14))}…${esc(k.slice(-4))} · ${k.length} caractères</span>${ok ? '' : ' <span class="muted">(une clé complète commence par sk-ant- et fait environ 108 caractères)</span>'}`;
  };
  keyIn.oninput = checkKey;
  $('#k-paste').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) return toast('Le presse-papiers est vide : copie d\'abord ta clé');
      keyIn.value = cleanKey(t); checkKey();
    } catch { toast('Appuie longtemps dans le champ puis « Coller »'); keyIn.focus(); }
  };
  $('#k-save').onclick = () => {
    const k = cleanKey(keyIn.value);
    if (!k) return toast('Colle ta clé dans le champ');
    if (k && !k.startsWith('sk-ant-')) return toast('Cette clé ne ressemble pas à une clé Anthropic');
    S.apiKey = k; save(); render(); toast('Clé enregistrée ✓ Test en cours…');
    // On la teste tout de suite pour savoir si elle marche.
    setTimeout(() => { $('#k-test')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); $('#k-test')?.click(); }, 150);
  };
  if ($('#k-change')) $('#k-change').onclick = () => {
    $('#k-form').hidden = false; $('#k-change').hidden = true; $('#k-paste').scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  if ($('#k-test')) $('#k-test').onclick = async () => {
    const b = $('#k-test'), out = $('#k-res'); b.disabled = true; out.textContent = 'Test en cours… (10 à 20 s)';
    try {
      const r = await callClaude([{ type: 'text', text: AI_PROMPT + '\n\nRepas décrit : « une pomme moyenne ». ' }], 4000);
      out.innerHTML = `<span style="color:var(--good);font-weight:650">✓ La clé marche.</span> <span class="muted">(une pomme ≈ ${fmt(r.items?.[0]?.kcal)} kcal)</span>`;
    } catch (e) {
      out.innerHTML = `<span style="color:var(--bad);font-weight:650">${esc(aiErrorText(e))}</span><br><span class="err-detail" style="display:inline-block;margin-top:6px">${esc([e.status, e.error?.error?.message || e.message].filter(Boolean).join(' · ')).slice(0, 300)}</span>`;
    } finally { b.disabled = false; }
  };
  $('#sd-go').onclick = () => {
    const v = $('#sd-date').value;
    if (!v) return toast('Choisis une date');
    const before = Object.keys(S.days).filter(k => k < v).length;
    if (before && !confirm(`Effacer de ce téléphone les ${before} jours avant le ${shortDate(v)} ? C'est définitif (pense à faire une copie avant si besoin).`)) return;
    const n = applyStartDate(v); render(); toast(n ? `${n} jours effacés · début le ${shortDate(v)}` : `Début le ${shortDate(v)}`);
  };
  if ($('#pl-form')) bindLoginForm(app, 'pl', () => { render(); toast('Connecté ✓ · sauvegarde en ligne active'); });
  if ($('#g-now')) $('#g-now').onclick = () => garminSync(false, 366);
  if ($('#g-auto')) $('#g-auto').onchange = ev => { S.garminAuto = ev.target.checked; save(); };
  if ($('#g-off')) $('#g-off').onclick = logout;
  if ($('#s-now')) $('#s-now').onclick = async () => { await cloudSync(false); render(); };
  if ($('#pw-form')) $('#pw-form').onsubmit = async ev => {
    ev.preventDefault();
    const name = $('#pw-name').value.trim(), pass = $('#pw-pass').value;
    if (name.length < 2) return toast('Indique ton prénom');
    if (pass.length < 6) return toast('Au moins 6 caractères');
    const b = $('#pw-go'); b.disabled = true;
    try {
      const r = await relayFetch(`/password`, { method: 'POST', headers: { 'X-Kalo-Code': S.garminCode, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: pass }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) return toast('Ce prénom est déjà pris : ajoute une initiale (ex. francisco-r)');
      if (!r.ok) return toast('Impossible pour l\'instant, réessaie');
      S.pwName = name; S.who = name; rawSave(); render();
      toast('Mot de passe enregistré ✓ Accepte si le téléphone propose de l\'enregistrer');
    } catch { toast('Pas de connexion, réessaie'); }
    finally { b.disabled = false; }
  };
  $('#x-exp').onclick = exportBackup;
  $('#x-csv2').onclick = exportCSV;
  $('#x-imp').onclick = () => $('#x-file').click();
  $('#x-csv').onclick = () => $('#x-csvfile').click();
  $('#x-csvfile').onchange = async ev => {
    const f = ev.target.files?.[0]; ev.target.value = ''; if (!f) return;
    let rows;
    try { rows = parseHistoryCSV(await f.text()); } catch (e) { return toast(e.message || 'Fichier illisible'); }
    if (!rows.length) return toast('Aucune ligne utilisable dans ce fichier');
    const nW = rows.filter(r => r.weight != null).length, nS = rows.filter(r => r.steps != null).length, nK = rows.filter(r => r.kcal != null).length;
    openSheet(`<h2>Importer l'historique</h2>
      <p><b>${rows.length} jours</b> trouvés, du ${shortDate(rows[0].date)} au ${shortDate(rows[rows.length - 1].date)} :</p>
      <div class="nutri" style="grid-template-columns:repeat(3,1fr)"><div><b>${nW}</b><small>poids</small></div><div><b>${nS}</b><small>pas</small></div><div><b>${nK}</b><small>calories</small></div></div>
      <p class="muted small">Pour ces jours, le poids et les pas remplacent ceux déjà notés. Les calories importées servent seulement les jours où tu n'as pas noté de repas.</p>
      <button class="btn" id="imp-go">Importer</button>
      <button class="btn ghost" id="imp-no">Annuler</button>`, sh => {
      $('#imp-no', sh).onclick = closeSheet;
      $('#imp-go', sh).onclick = () => {
        for (const r of rows) {
          if (S.startDate && r.date < S.startDate) continue;
          const d = day(r.date);
          if (r.weight != null) d.weight = r.weight;
          if (r.steps != null) d.steps = r.steps;
          if (r.kcal != null) d.kcalImport = r.kcal;
          cleanDay(r.date);
        }
        save(); closeSheet(); UI.view = 'stats'; UI.statMode = 'semaine'; render(); window.scrollTo(0, 0); toast(rows.length + ' jours importés ✓');
      };
    });
  };
  $('#x-file').onchange = async ev => {
    const f = ev.target.files?.[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d.profile || !d.days) throw 0;
      if (!confirm('Remplacer les données de ce téléphone par cette copie ?')) return;
      S = Object.assign({ profile: null, apiKey: '', days: {}, foods: {}, meals: [] }, d, { apiKey: S.apiKey }); save(); render(); toast('Copie restaurée');
    } catch { toast('Ce fichier n\'est pas une copie valide'); }
  };
  $('#x-redo').onclick = () => {
    onb.i = 0; onb.p = { sex: P.sex, age: String(P.age), height: String(P.height), weight: String(latestWeight() || P.weight).replace('.', ','), activity: P.activity, goal: P.goal };
    S.profile = null; save(); render();
  };
}

/* ====================== Démarrage ====================== */
// Début d'historique demandé par Francisco, par téléphone. On reconnaît le téléphone à l'empreinte
// de son code Garmin (les codes eux-mêmes ne sont pas ici). S'applique une seule fois, puis réglable dans Profil.
const START_BY_CODE = {
  'dbd8131f9e1f39a720410071cad5e12a0a8f2125235582d632e05eb514e862bc': '2026-10-10',   // Francisco
  'e519bd64c299b44405b87b8c4ae6b35ad819a8d7e088c6cd9a33812cf1f3005c': '2026-11-23',   // sa femme
};
function checkStartByCode() {
  if (!S.profile || !S.garminCode || S.startDate !== undefined || !crypto.subtle) return Promise.resolve();
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(S.garminCode)).then(buf => {
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const start = START_BY_CODE[hex];
    if (!start || S.startDate !== undefined) return;
    const n = applyStartDate(start); render();
    toast(`Historique démarré au ${shortDate(start)}${n ? ` (${n} jours plus anciens effacés)` : ''}`);
  }).catch(() => {});
}
checkStartByCode();
if (S.apiKey && /[^A-Za-z0-9_-]/.test(S.apiKey)) { S.apiKey = S.apiKey.replace(/[^A-Za-z0-9_-]/g, ''); save(); }
render();
const garminAuto = () => { if (S.garminCode && S.garminAuto !== false && ((S.garminV || 0) < 2 || Date.now() - (S.garminLast || 0) > 30 * 60e3)) garminSync(true); };
lastSnap = snapOf(S);
if (S.garminCode && !S.linkedHash && crypto.subtle) sha256(S.garminCode).then(h => { S.linkedHash = h; rawSave(); }).catch(() => {});
let lastWake = 0;
const wake = async () => {
  if (Date.now() - lastWake < 20000) return; lastWake = Date.now();
  if (S.garminCode) await cloudSync(true);
  garminAuto();
};
setTimeout(wake, 600);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) wake();
  else if (syncTimer && S.garminCode) cloudSync(true);
  // Si l'app reste ouverte jusqu'au lendemain, revenir sur le bon jour.
  if (!document.hidden && UI.view === 'jour' && UI.date < todayKey() && !$('#sheet-root').innerHTML) { UI.date = todayKey(); render(); }
});
if ('serviceWorker' in navigator && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
