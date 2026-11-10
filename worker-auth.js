// ════════════════════════════════════════════════════════════════════════════
// worker-auth.js — autenticação, credenciais e autorização no BACKEND.
//
// • Login: valida a senha contra HASH PBKDF2 (coleção `credenciais`, que NENHUM
//   cliente consegue ler) e devolve um Firebase CUSTOM TOKEN (uid = id do doc em
//   `users`; postos = "posto_<id>"). A sessão passa a ser Firebase Auth real.
// • Todo o acesso do Worker ao Firestore usa conta de serviço (secret
//   FIREBASE_SERVICE_ACCOUNT) — nunca vai para o repositório nem para o front.
// • ID tokens são verificados LOCALMENTE (assinatura RS256 via JWKS do Google).
// • Autorização por módulo (matriz de acesso) é avaliada AQUI para as rotas de
//   arquivos — espelha o motor do front-end (níveis, temporárias com relógio do
//   servidor, capacidades, principal protegido).
// Segredos exigidos: FIREBASE_SERVICE_ACCOUNT, SETUP_TOKEN. Vars: FIREBASE_PROJECT_ID,
// PRINCIPAL_EMAIL (opcional p/ setup), PBKDF2_ITER (opcional).
// ════════════════════════════════════════════════════════════════════════════

const ENC = new TextEncoder();
const NIVEIS = ['sem_acesso', 'operador', 'gestao', 'adm'];
const SUPERVISORES = ['victor.simoes@gruporgbrasil.com', 'leonardo.costa@gruporgbrasil.com', 'plicila.silva@gruporgbrasil.com', 'supervisor.teste@gruporgbrasil.com', 'teste@gruporgbrasil.com'];
const SENHAS_PADRAO_CONHECIDAS = ['rg@2026', 'admin123'];
const MAX_FALHAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;

// ───────────── utilidades ─────────────
export function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function b64(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); }
function unb64(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }
function igualConstante(a, b) {
  const x = ENC.encode(String(a)), y = ENC.encode(String(b));
  let r = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) r |= (x[i] || 0) ^ (y[i] || 0);
  return r === 0;
}
function normEmail(e) { return String(e || '').trim(); }

// ───────────── conta de serviço ─────────────
let _saCache = null;
function contaServico(env) {
  if (_saCache && _saCache.raw === env.FIREBASE_SERVICE_ACCOUNT) return _saCache;
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('service_account_missing');
  const j = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  if (!j.client_email || !j.private_key) throw new Error('service_account_invalid');
  _saCache = { raw: env.FIREBASE_SERVICE_ACCOUNT, email: j.client_email, pem: j.private_key, projectId: env.FIREBASE_PROJECT_ID || j.project_id, key: null, token: null, tokenExp: 0 };
  if (!_saCache.projectId) throw new Error('project_id_missing');
  return _saCache;
}
async function chavePrivada(sa) {
  if (sa.key) return sa.key;
  const corpo = sa.pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  sa.key = await crypto.subtle.importKey('pkcs8', unb64(corpo), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return sa.key;
}
async function assinarJwt(sa, payload, header) {
  const h = b64url(ENC.encode(JSON.stringify(Object.assign({ alg: 'RS256', typ: 'JWT' }, header || {}))));
  const p = b64url(ENC.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await chavePrivada(sa), ENC.encode(h + '.' + p));
  return h + '.' + p + '.' + b64url(sig);
}
async function tokenAcesso(env) {
  const sa = contaServico(env);
  const agora = Math.floor(Date.now() / 1000);
  if (sa.token && sa.tokenExp - 60 > agora) return sa.token;
  const jwt = await assinarJwt(sa, { iss: sa.email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt });
  if (!r.ok) throw new Error('oauth_failed_' + r.status);
  const j = await r.json();
  sa.token = j.access_token; sa.tokenExp = agora + (j.expires_in || 3600);
  return sa.token;
}
export async function criarCustomToken(env, uid, claims) {
  const sa = contaServico(env);
  const agora = Math.floor(Date.now() / 1000);
  return assinarJwt(sa, { iss: sa.email, sub: sa.email, aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit', iat: agora, exp: agora + 3600, uid, claims: claims || {} });
}

// ───────────── Firestore REST (conta de serviço) ─────────────
const FS_BASE = 'https://firestore.googleapis.com/v1';
function raiz(env) { return `projects/${contaServico(env).projectId}/databases/(default)/documents`; }
export function paraFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(paraFs) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, paraFs(x)])) } };
  return { stringValue: String(v) };
}
export function deFs(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deFs);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, deFs(x)]));
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
function docParaObj(doc) { const o = Object.fromEntries(Object.entries(doc.fields || {}).map(([k, x]) => [k, deFs(x)])); o.__id = doc.name.split('/').pop(); return o; }
async function fs(env, metodo, caminho, corpo, query) {
  const t = await tokenAcesso(env);
  const url = `${FS_BASE}/${caminho}${query ? (caminho.includes('?') ? '&' : '?') + query : ''}`;
  const r = await fetch(url, { method: metodo, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  if (r.status === 404) return { naoExiste: true };
  if (!r.ok) throw new Error('firestore_' + r.status);
  return r.status === 204 ? {} : r.json();
}
export async function fsGet(env, caminho) {
  const r = await fs(env, 'GET', `${raiz(env)}/${caminho}`);
  return r.naoExiste ? null : docParaObj(r);
}
// Grava (merge por máscara). campos = objeto; campos ausentes na máscara não mudam.
export async function fsMerge(env, caminho, campos, remover) {
  const mascara = [...Object.keys(campos), ...(remover || [])];
  const q = mascara.map(c => 'updateMask.fieldPaths=' + encodeURIComponent(c)).join('&');
  const body = { fields: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, paraFs(v)])) };
  return fs(env, 'PATCH', `${raiz(env)}/${caminho}`, body, q || 'updateMask.fieldPaths=__none');
}
export async function fsCriar(env, colecao, campos, id) {
  const body = { fields: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, paraFs(v)])) };
  const r = await fs(env, 'POST', `${raiz(env)}/${colecao}`, body, id ? 'documentId=' + encodeURIComponent(id) : '');
  return docParaObj(r);
}
export async function fsApagar(env, caminho) { await fs(env, 'DELETE', `${raiz(env)}/${caminho}`); }
export async function fsConsultaIgual(env, colecao, campo, valor, limite) {
  const r = await fs(env, 'POST', `${raiz(env)}:runQuery`, { structuredQuery: { from: [{ collectionId: colecao }], where: { fieldFilter: { field: { fieldPath: campo }, op: 'EQUAL', value: paraFs(valor) } }, limit: limite || 5 } });
  return (Array.isArray(r) ? r : []).filter(x => x.document).map(x => docParaObj(x.document));
}
export async function fsListar(env, colecao) {
  const out = []; let tok = '';
  do {
    const r = await fs(env, 'GET', `${raiz(env)}/${colecao}`, null, 'pageSize=200' + (tok ? '&pageToken=' + encodeURIComponent(tok) : ''));
    (r.documents || []).forEach(d => out.push(docParaObj(d)));
    tok = r.nextPageToken || '';
  } while (tok);
  return out;
}

// ───────────── hash de senha (PBKDF2-SHA256) ─────────────
function iteracoes(env) { const n = parseInt(env.PBKDF2_ITER, 10); return n > 0 ? Math.min(n, 100000) : 100000; } // 100k = teto do Workers
async function derivar(senha, salt, iter) {
  const k = await crypto.subtle.importKey('raw', ENC.encode(senha), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256);
}
export async function hashSenha(env, senha) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iter = iteracoes(env);
  return { algo: 'pbkdf2-sha256', iter, salt: b64(salt), hash: b64(await derivar(senha, salt, iter)) };
}
export async function conferirSenha(senha, cred) {
  if (!cred || cred.algo !== 'pbkdf2-sha256') { await derivar(senha, new Uint8Array(16), 1000); return false; } // tempo similar
  const calc = b64(await derivar(senha, unb64(cred.salt), cred.iter));
  return igualConstante(calc, cred.hash);
}
function senhaTemporaria() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(14));
  let s = ''; for (const b of r) s += alfabeto[b % alfabeto.length];
  return s + '7a';
}
export function validarSenhaForte(senha) {
  if (typeof senha !== 'string' || senha.length < 6) return 'A senha deve ter no mínimo 6 caracteres.';
  if (senha.length > 128) return 'Senha muito longa.';
  if (!/[a-zA-Z]/.test(senha)) return 'A senha deve conter pelo menos uma letra.';
  if (!/[0-9]/.test(senha)) return 'A senha deve conter pelo menos um número.';
  return null;
}

// ───────────── verificação de ID token (RS256 / JWKS do Google) ─────────────
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let _jwks = { keys: null, exp: 0 };
async function chavesPublicas() {
  const agora = Date.now();
  if (_jwks.keys && _jwks.exp > agora) return _jwks.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error('jwks_unavailable');
  const j = await r.json();
  _jwks = { keys: j.keys || [], exp: agora + 30 * 60 * 1000 };
  return _jwks.keys;
}
export async function verificarIdToken(token, env) {
  try {
    const partes = String(token || '').split('.');
    if (partes.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(partes[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(partes[1])));
    if (header.alg !== 'RS256' || !header.kid) return null;
    let jwk = (await chavesPublicas()).find(k => k.kid === header.kid);
    if (!jwk) { _jwks.exp = 0; jwk = (await chavesPublicas()).find(k => k.kid === header.kid); }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(partes[2]), ENC.encode(partes[0] + '.' + partes[1]));
    if (!ok) return null;
    const projeto = contaServico(env).projectId, agora = Math.floor(Date.now() / 1000);
    if (payload.aud !== projeto || payload.iss !== 'https://securetoken.google.com/' + projeto) return null;
    if (!payload.sub || typeof payload.sub !== 'string') return null;
    if (!payload.exp || payload.exp <= agora || (payload.iat && payload.iat > agora + 300)) return null;
    return { uid: payload.sub, origem: payload.origem || null, payload };
  } catch (e) { return null; }
}

// ───────────── identidade → documento ─────────────
function uidDe(origem, id) { return origem === 'postos' ? 'posto_' + id : id; }
async function acharPorEmail(env, email) {
  for (const col of ['users', 'postos']) {
    for (const tentativa of [email, email.toLowerCase()]) {
      const r = await fsConsultaIgual(env, col, 'email', tentativa, 2);
      if (r.length) return { origem: col, doc: r[0], uid: uidDe(col, r[0].__id) };
    }
  }
  return null;
}
async function carregarUsuario(env, uid) {
  if (uid.startsWith('posto_')) { const d = await fsGet(env, 'postos/' + uid.slice(6)); return d ? { origem: 'postos', doc: d, uid } : null; }
  const d = await fsGet(env, 'users/' + uid); return d ? { origem: 'users', doc: d, uid } : null;
}

// ───────────── matriz de acesso no servidor (espelha o front) ─────────────
function ms(v) { if (v == null) return null; if (typeof v === 'number') return v; const t = Date.parse(v); return isNaN(t) ? null : t; }
function rank(n) { const i = NIVEIS.indexOf(n); return i < 0 ? 0 : i; }
// → { legado:true } | { legado:false, nivel }  (temporária usa o relógio do SERVIDOR)
export function nivelNoServidor(politica, aclDoc, uid, modulo, agoraMs) {
  if (politica && (politica.principais || []).includes(uid)) return { legado: false, nivel: 3 };
  const entrada = aclDoc && aclDoc.modulos ? aclDoc.modulos[modulo] : null;
  if (!politica || politica.ativa !== true || !aclDoc || aclDoc.usarPadrao === true || !entrada) return { legado: true };
  const perm = entrada.perm == null ? null : rank(entrada.perm);
  let temp = 0;
  if (entrada.temp) { const i = ms(entrada.tempIni), f = ms(entrada.tempFim); if (i != null && f != null && agoraMs >= i && agoraMs < f) temp = rank(entrada.temp); }
  if (perm == null) return temp ? { legado: true, nivelTemp: temp } : { legado: true };
  return { legado: false, nivel: Math.max(perm, temp) };
}
export function temCapacidadeServidor(politica, aclDoc, uid, usuarioDoc, cap) {
  if (politica && (politica.principais || []).includes(uid)) return true;
  if (cap === 'administrar_acessos') return !!(politica && (politica.delegados || []).includes(uid));
  if (politica && politica.ativa === true && aclDoc && aclDoc.usarPadrao !== true && Array.isArray(aclDoc.capacidades)) return aclDoc.capacidades.includes(cap);
  return !!usuarioDoc && usuarioDoc.role === 'admin';
}
async function contextoAcl(env, uid) {
  const [politica, aclDoc] = await Promise.all([fsGet(env, 'controle_acessos_config/politica'), fsGet(env, 'controle_acessos/' + uid)]);
  return { politica, aclDoc };
}
// Decisão para uma ação de módulo. legadoOk = resultado da regra legada.
export async function autorizarModulo(env, ident, modulo, minimo, legadoOk) {
  const { politica, aclDoc } = await contextoAcl(env, ident.uid);
  const n = nivelNoServidor(politica, aclDoc, ident.uid, modulo, Date.now());
  if (n.legado) return legadoOk || (n.nivelTemp != null && n.nivelTemp >= minimo);
  return n.nivel >= minimo;
}
// Identidade completa a partir do Bearer (ID token verificado + doc do usuário)
export async function identidadeDaRequisicao(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401 };
  const v = await verificarIdToken(m[1].trim(), env);
  if (!v) return { ok: false, status: 401 };
  const u = await carregarUsuario(env, v.uid);
  if (!u) return { ok: false, status: 401 };
  if (u.origem === 'users' && u.doc.ativo === false) return { ok: false, status: 401 };
  return { ok: true, uid: v.uid, origem: u.origem, usuario: u.doc, email: u.doc.email || null };
}

// ───────────── respostas ─────────────
function resp(request, status, body, base) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
  const origin = request.headers.get('Origin');
  if (origin && base.origem && origin === base.origem) { h.set('Access-Control-Allow-Origin', origin); h.set('Vary', 'Origin'); }
  return new Response(JSON.stringify(body), { status, headers: h });
}
async function lerJson(request) { try { const t = await request.text(); if (t.length > 20000) return null; return JSON.parse(t); } catch (e) { return null; } }

// ───────────── endpoints /api/auth/* ─────────────
async function login(request, env, base) {
  const b = await lerJson(request);
  const email = normEmail(b && b.email), senha = b && b.senha;
  if (!email || email.length > 200 || typeof senha !== 'string' || !senha || senha.length > 200) return resp(request, 400, { ok: false, error: 'invalid_request' }, base);
  const ach = await acharPorEmail(env, email);
  const cred = ach ? await fsGet(env, 'credenciais/' + ach.uid) : null;
  if (cred && cred.bloqueadoAte && ms(cred.bloqueadoAte) > Date.now()) return resp(request, 429, { ok: false, error: 'locked' }, base);
  const ok = await conferirSenha(senha, cred);
  if (!ach || !cred || !ok) {
    if (ach && cred) {
      const falhas = (cred.falhas || 0) + 1;
      await fsMerge(env, 'credenciais/' + ach.uid, falhas >= MAX_FALHAS ? { falhas: 0, bloqueadoAte: new Date(Date.now() + BLOQUEIO_MS).toISOString() } : { falhas });
    }
    return resp(request, 401, { ok: false, error: 'invalid_credentials' }, base);
  }
  if (ach.origem === 'users' && ach.doc.ativo === false) return resp(request, 403, { ok: false, error: 'account_disabled' }, base);
  if (cred.falhas || cred.bloqueadoAte) await fsMerge(env, 'credenciais/' + ach.uid, { falhas: 0, bloqueadoAte: null });
  const customToken = await criarCustomToken(env, ach.uid, { origem: ach.origem });
  return resp(request, 200, { ok: true, customToken, uid: ach.uid, origem: ach.origem, mustChangePassword: ach.origem === 'users' && (ach.doc.mustChangePassword === true || cred.mustChange === true) }, base);
}

async function trocarSenha(request, env, base) {
  const ident = await identidadeDaRequisicao(request, env);
  if (!ident.ok) return resp(request, ident.status, { ok: false, error: 'unauthorized' }, base);
  const b = await lerJson(request);
  if (!b || typeof b.senhaAtual !== 'string' || typeof b.senhaNova !== 'string') return resp(request, 400, { ok: false, error: 'invalid_request' }, base);
  const erro = validarSenhaForte(b.senhaNova);
  if (erro) return resp(request, 400, { ok: false, error: 'weak_password', message: erro }, base);
  const cred = await fsGet(env, 'credenciais/' + ident.uid);
  if (!(await conferirSenha(b.senhaAtual, cred))) return resp(request, 401, { ok: false, error: 'invalid_credentials' }, base);
  const novo = await hashSenha(env, b.senhaNova);
  await fsMerge(env, 'credenciais/' + ident.uid, Object.assign({}, novo, { mustChange: false, falhas: 0, bloqueadoAte: null, senhaAlteradaEm: new Date().toISOString() }));
  if (ident.origem === 'users') await fsMerge(env, 'users/' + ident.uid, { mustChangePassword: false });
  return resp(request, 200, { ok: true }, base);
}

// Redefinição administrativa (reset de pedido, senha inicial de novo colaborador, redefinição pelo Time).
async function redefinirSenhaAdmin(request, env, base) {
  const ident = await identidadeDaRequisicao(request, env);
  if (!ident.ok) return resp(request, ident.status, { ok: false, error: 'unauthorized' }, base);
  if (ident.origem !== 'users') return resp(request, 403, { ok: false, error: 'forbidden' }, base);
  const b = await lerJson(request);
  if (!b || typeof b.userId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.userId)) return resp(request, 400, { ok: false, error: 'invalid_request' }, base);
  const { politica, aclDoc } = await contextoAcl(env, ident.uid);
  if (!temCapacidadeServidor(politica, aclDoc, ident.uid, ident.usuario, 'reset_senha')) return resp(request, 403, { ok: false, error: 'forbidden' }, base);
  const alvoPosto = b.origem === 'postos';
  const alvo = await fsGet(env, (alvoPosto ? 'postos/' : 'users/') + b.userId);
  if (!alvo) return resp(request, 404, { ok: false, error: 'user_not_found' }, base);
  const uidAlvo = alvoPosto ? 'posto_' + b.userId : b.userId;
  if (!alvoPosto && (politica && (politica.principais || []).includes(b.userId)) && b.userId !== ident.uid) return resp(request, 403, { ok: false, error: 'protected_user' }, base); // só o próprio principal troca a sua
  let senha = typeof b.senha === 'string' && b.senha ? b.senha : null, gerada = false;
  if (senha) { const erro = validarSenhaForte(senha); if (erro) return resp(request, 400, { ok: false, error: 'weak_password', message: erro }, base); }
  else { senha = senhaTemporaria(); gerada = true; }
  const novo = await hashSenha(env, senha);
  await fsMerge(env, 'credenciais/' + uidAlvo, Object.assign({ origem: alvoPosto ? 'postos' : 'users', email: alvo.email || '' }, novo, { mustChange: !alvoPosto, falhas: 0, bloqueadoAte: null, senhaAlteradaEm: new Date().toISOString() }));
  if (!alvoPosto) await fsMerge(env, 'users/' + b.userId, { mustChangePassword: true });
  const agora = new Date().toISOString();
  if (typeof b.requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.requestId)) { try { await fsMerge(env, 'reset_requests/' + b.requestId, { status: 'concluido', resolvedAt: agora, resolvedBy: ident.uid }); } catch (e) { /* pedido já removido */ } }
  await fsCriar(env, 'redefinicoes_senha', { userId: b.userId, userName: alvo.name || alvo.nome || '', alvoOrigem: alvoPosto ? 'postos' : 'users', redefinidoPorId: ident.uid, redefinidoPorEmail: ident.email || '', redefinidoPorNome: ident.usuario.name || '', data: agora, origem: 'worker' });
  return resp(request, 200, Object.assign({ ok: true }, gerada ? { senhaTemporaria: senha } : {}), base);
}

async function esqueciSenha(request, env, base) {
  const b = await lerJson(request);
  const email = normEmail(b && b.email);
  const generica = () => resp(request, 200, { ok: true }, base); // nunca revela se o e-mail existe
  if (!email || email.length > 200) return generica();
  try {
    for (const t of [email, email.toLowerCase()]) {
      const r = await fsConsultaIgual(env, 'users', 'email', t, 1);
      if (!r.length) continue;
      const u = r[0];
      if (u.role === 'admin' || u.ativo === false) return generica();
      const pend = (await fsConsultaIgual(env, 'reset_requests', 'userId', u.__id, 20)).filter(x => x.status === 'pendente');
      if (!pend.length) await fsCriar(env, 'reset_requests', { userId: u.__id, userName: u.name || '', userEmail: u.email, status: 'pendente', requestedAt: new Date().toISOString() });
      return generica();
    }
  } catch (e) { console.warn('[auth/forgot]', e && e.message); }
  return generica();
}

// ───────────── /api/setup/* (migração) — protegido por SETUP_TOKEN ─────────────
function setupAutorizado(request, env) {
  const t = request.headers.get('X-Setup-Token') || '';
  return !!env.SETUP_TOKEN && env.SETUP_TOKEN.length >= 24 && igualConstante(t, env.SETUP_TOKEN);
}
async function setup(request, env, base, rota) {
  if (!setupAutorizado(request, env)) return resp(request, 401, { ok: false, error: 'unauthorized' }, base);
  const b = (request.method === 'POST' ? await lerJson(request) : null) || {};
  const [users, postos] = await Promise.all([fsListar(env, 'users'), fsListar(env, 'postos')]);
  const itens = [...users.map(d => ({ origem: 'users', d })), ...postos.map(d => ({ origem: 'postos', d }))];

  if (rota === 'status') {
    const creds = await fsListar(env, 'credenciais'), politica = await fsGet(env, 'controle_acessos_config/politica');
    const credIds = new Set(creds.map(c => c.__id));
    return resp(request, 200, { ok: true, usuarios: users.length, postos: postos.length,
      comSenhaEmTexto: itens.filter(i => typeof i.d.password === 'string' && i.d.password).length,
      semCredencial: itens.filter(i => !credIds.has(uidDe(i.origem, i.d.__id))).length,
      credenciais: creds.length, admins: users.filter(u => u.role === 'admin').map(u => ({ id: u.__id, nome: u.name || '', email: u.email || '' })), politicaInicializada: !!politica, principais: politica ? politica.principais : [], backups: (await fsListar(env, '_backup_auth')).length }, base);
  }

  if (rota === 'migrar') {
    const dryRun = b.dryRun !== false, limite = Math.min(Math.max(parseInt(b.limite, 10) || 20, 1), 40);
    const creds = new Set((await fsListar(env, 'credenciais')).map(c => c.__id));
    const pend = itens.filter(i => typeof i.d.password === 'string' && i.d.password && !creds.has(uidDe(i.origem, i.d.__id)));
    const semSenha = itens.filter(i => !(typeof i.d.password === 'string' && i.d.password) && !creds.has(uidDe(i.origem, i.d.__id))).map(i => i.origem + '/' + i.d.__id);
    let migrados = 0, padraoForcadas = 0;
    if (!dryRun) {
      for (const i of pend.slice(0, limite)) {
        const uid = uidDe(i.origem, i.d.__id), h = await hashSenha(env, i.d.password);
        // backup ANTES de qualquer mudança (permite reverter)
        await fsMerge(env, '_backup_auth/' + i.origem + '__' + i.d.__id, { col: i.origem, id: i.d.__id, password: i.d.password, mustChangePassword: i.d.mustChangePassword === true, salvoEm: new Date().toISOString() });
        const padrao = SENHAS_PADRAO_CONHECIDAS.includes(i.d.password); // estavam no código-fonte → troca obrigatória
        await fsMerge(env, 'credenciais/' + uid, Object.assign({ origem: i.origem, email: i.d.email || '' }, h, { mustChange: i.d.mustChangePassword === true || padrao, falhas: 0, migradoEm: new Date().toISOString() }));
        if (padrao && i.origem === 'users') { await fsMerge(env, 'users/' + i.d.__id, { mustChangePassword: true }); padraoForcadas++; }
        migrados++;
      }
    }
    // administrador principal — explícito (corpo ou variável do Worker), nunca "o primeiro que clicar"
    const emailPrincipal = normEmail(b.principalEmail || env.PRINCIPAL_EMAIL);
    let principal = { definido: false };
    const polExistente = await fsGet(env, 'controle_acessos_config/politica');
    const alvo = emailPrincipal ? users.find(u => (u.email || '').toLowerCase() === emailPrincipal.toLowerCase()) : null;
    if (polExistente) {
      // Política já existe: NUNCA é sobrescrita. Apenas informa se o e-mail informado confere.
      principal = { definido: true, jaExistia: true, userId: (polExistente.principais || [])[0], confere: !!(alvo && (polExistente.principais || []).includes(alvo.__id)) };
    } else if (!emailPrincipal) principal.erro = 'PRINCIPAL_EMAIL não informado';
    else if (!alvo) principal.erro = 'usuário principal não encontrado em users';
    else if (alvo.role !== 'admin') principal.erro = 'o usuário principal precisa ter role=admin';
    else {
      if (!dryRun) await fsMerge(env, 'controle_acessos_config/politica', { ativa: false, principais: [alvo.__id], delegados: [], versao: 1, criadoEm: new Date().toISOString(), criadoPor: 'setup' });
      principal = { definido: !dryRun, userId: alvo.__id, email: alvo.email, criar: true };
    }
    return resp(request, 200, { ok: true, dryRun, totalPendentes: pend.length, migradosNestaChamada: migrados, trocaObrigatoriaSenhaPadrao: padraoForcadas, comSenhaPadraoConhecida: pend.filter(i => SENHAS_PADRAO_CONHECIDAS.includes(i.d.password)).length, restantes: Math.max(pend.length - migrados, 0), semSenhaESemCredencial: semSenha, principal }, base);
  }

  if (rota === 'finalizar') {
    if (b.confirmar !== 'REMOVER_SENHAS_EM_TEXTO') return resp(request, 400, { ok: false, error: 'confirmacao_necessaria' }, base);
    const creds = new Set((await fsListar(env, 'credenciais')).map(c => c.__id));
    const comSenha = itens.filter(i => typeof i.d.password === 'string' && i.d.password);
    const faltam = comSenha.filter(i => !creds.has(uidDe(i.origem, i.d.__id)));
    if (faltam.length) return resp(request, 409, { ok: false, error: 'credenciais_pendentes', faltam: faltam.length }, base);
    let removidos = 0;
    for (const i of comSenha) { await fsMerge(env, i.origem + '/' + i.d.__id, {}, ['password']); removidos++; }
    return resp(request, 200, { ok: true, senhasRemovidas: removidos }, base);
  }

  if (rota === 'reverter') {
    if (b.confirmar !== 'RESTAURAR_SENHAS') return resp(request, 400, { ok: false, error: 'confirmacao_necessaria' }, base);
    const backups = await fsListar(env, '_backup_auth');
    let restaurados = 0;
    for (const bk of backups) { await fsMerge(env, bk.col + '/' + bk.id, { password: bk.password, mustChangePassword: bk.mustChangePassword === true }); restaurados++; }
    return resp(request, 200, { ok: true, restaurados }, base);
  }

  if (rota === 'limpar-backup') {
    if (b.confirmar !== 'APAGAR_BACKUP_DE_SENHAS') return resp(request, 400, { ok: false, error: 'confirmacao_necessaria' }, base);
    const backups = await fsListar(env, '_backup_auth');
    for (const bk of backups) await fsApagar(env, '_backup_auth/' + bk.__id);
    return resp(request, 200, { ok: true, apagados: backups.length }, base);
  }
  return resp(request, 404, { ok: false, error: 'not_found' }, base);
}

// ───────────── roteador (retorna null se a rota não for daqui) ─────────────
export async function tratarRotasAuth(request, env, base) {
  const url = new URL(request.url), p = url.pathname;
  if (!p.startsWith('/api/auth/') && !p.startsWith('/api/setup/')) return null;
  if (request.method === 'OPTIONS') return resp(request, 204, {}, base);
  try {
    if (p.startsWith('/api/setup/')) return await setup(request, env, base, p.slice('/api/setup/'.length));
    if (request.method !== 'POST') return resp(request, 405, { ok: false, error: 'method_not_allowed' }, base);
    if (p === '/api/auth/login') return await login(request, env, base);
    if (p === '/api/auth/change-password') return await trocarSenha(request, env, base);
    if (p === '/api/auth/admin-reset') return await redefinirSenhaAdmin(request, env, base);
    if (p === '/api/auth/forgot') return await esqueciSenha(request, env, base);
    return resp(request, 404, { ok: false, error: 'not_found' }, base);
  } catch (e) {
    console.error('[auth] erro interno:', e && e.message);
    return resp(request, 500, { ok: false, error: 'internal_error' }, base);
  }
}
