// Worker do GestãoRGRio.
// Comportamento preservado: toda rota que não seja explicitamente
// interceptada abaixo continua sendo entregue por env.ATIVOS.fetch(request),
// exatamente como antes desta alteração.

const ORIGEM_PERMITIDA = 'https://gestaorgrio.celoportugal19899.workers.dev';

// ══════════════════════════════════════════════════════════════════════════
// HELPERS DE RESPOSTA — JSON padronizado, nunca stack trace/token/segredo.
// CORS restrito ao próprio domínio (nunca "*") — front e Worker já são o
// mesmo domínio, então isto é defensivo, não uma necessidade funcional hoje.
// ══════════════════════════════════════════════════════════════════════════
function baseHeaders(request, extra) {
  const h = new Headers(extra || {});
  const origin = request.headers.get('Origin');
  if (origin === ORIGEM_PERMITIDA) {
    h.set('Access-Control-Allow-Origin', ORIGEM_PERMITIDA);
    h.set('Vary', 'Origin');
  }
  return h;
}

function jsonResponse(request, status, body, extraHeaders) {
  const headers = baseHeaders(request, Object.assign(
    { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
    extraHeaders || {}
  ));
  return new Response(JSON.stringify(body), { status, headers });
}

// Códigos controlados: unauthorized, method_not_allowed, invalid_request,
// invalid_path, file_not_found, unsupported_file_type, file_too_large,
// storage_error, internal_error.
function jsonError(request, code, status, extraHeaders) {
  return jsonResponse(request, status, { ok: false, error: code }, extraHeaders);
}

// ══════════════════════════════════════════════════════════════════════════
// SEGURANÇA DE PATH E NOME DE ARQUIVO
// ══════════════════════════════════════════════════════════════════════════

// Path relativo ao bucket — nunca aceita "..", barra invertida, path vazio,
// path absoluto começando com "/", nem qualquer URL completa (http://,
// https://, gs://, ou qualquer outro scheme://).
function pathValido(path) {
  if (!path || typeof path !== 'string') return false;
  if (path.trim() === '') return false;
  if (path.includes('..')) return false;
  if (path.includes('\\')) return false;
  if (path.startsWith('/')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return false; // qualquer "algo://"
  if (path.toLowerCase().startsWith('gs://')) return false;
  return true;
}

// Segmento de path derivado de input do cliente (operacaoId, modulo,
// categoria) — nunca confia no valor cru; restringe a um charset seguro.
function sanitizarSegmentoPath(v) {
  return String(v || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

// Nome de arquivo — usado só para exibição (Content-Disposition) e como
// sufixo do path físico, nunca como base da localização real do arquivo
// (isso é sempre o UUID). Remove acentos e qualquer caractere fora de um
// charset seguro para nome de arquivo/URL.
function sanitizarNomeArquivo(nome) {
  const semAcento = String(nome || 'arquivo').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const limpo = semAcento.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
  return limpo || 'arquivo';
}

// Monta o path padronizado — usado pelos dois caminhos de upload
// (multipart e streaming), evita duplicar essa lógica.
function montarPathArquivo(operacaoId, modulo, categoria, uuid, nomeSanitizado) {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  return `${operacaoId}/${modulo}/${categoria}/${ano}/${mes}/${uuid}_${nomeSanitizado}`;
}

// ══════════════════════════════════════════════════════════════════════════
// AUTENTICAÇÃO — reutilizada, sem alteração de comportamento em relação à
// Etapa 2A. Retorna dados mínimos e normalizados do usuário, nunca o token.
// ══════════════════════════════════════════════════════════════════════════
async function autenticarFirebase(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const idToken = match[1].trim();
  if (!idToken) return null;

  if (!env.FIREBASE_API_KEY) {
    throw new Error('firebase_api_key_missing');
  }

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );

  if (resp.status !== 200) return null;

  const data = await resp.json();
  const user = data && Array.isArray(data.users) ? data.users[0] : null;
  if (!user) return null;
  if (user.disabled) return null;

  return {
    uid: user.localId,
    email: user.email || null,
    emailVerified: !!user.emailVerified,
    displayName: user.displayName || null
  };
}

// Helper único usado por TODAS as rotas protegidas — distingue "sem
// autenticação válida" (401) de "falha interna ao validar" (500), sem
// duplicar essa lógica em cada rota.
async function exigirAutenticacao(request, env) {
  try {
    const user = await autenticarFirebase(request, env);
    if (!user) return { ok: false, status: 401 };
    return { ok: true, user };
  } catch (e) {
    console.warn('[auth] erro ao validar token:', e && e.message);
    return { ok: false, status: 500 };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ROTA — GET /api/storage/health (preservada, sem alteração)
// ══════════════════════════════════════════════════════════════════════════
async function handleStorageHealth(request, env) {
  if (request.method !== 'GET') {
    return jsonError(request, 'method_not_allowed', 405, { Allow: 'GET' });
  }
  try {
    if (!env.ARQUIVOS_BUCKET) throw new Error('binding_missing');
    await env.ARQUIVOS_BUCKET.list({ limit: 1 });
    return jsonResponse(request, 200, {
      ok: true, service: 'cloudflare-r2', bucket: 'gestaorgrio-arquivos',
      binding: 'ARQUIVOS_BUCKET', status: 'connected'
    });
  } catch (err) {
    return jsonResponse(request, 500, {
      ok: false, service: 'cloudflare-r2', bucket: 'gestaorgrio-arquivos',
      binding: 'ARQUIVOS_BUCKET', status: 'error'
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ROTA — GET /api/storage/auth-check (preservada, sem alteração)
// ══════════════════════════════════════════════════════════════════════════
async function handleStorageAuthCheck(request, env) {
  if (request.method !== 'GET') {
    return jsonError(request, 'method_not_allowed', 405, { Allow: 'GET' });
  }
  const authResult = await exigirAutenticacao(request, env);
  if (!authResult.ok) {
    if (authResult.status === 500) return jsonError(request, 'internal_error', 500);
    return jsonResponse(request, 401, { ok: false, authenticated: false, error: 'unauthorized' });
  }
  return jsonResponse(request, 200, { ok: true, authenticated: true, user: authResult.user });
}

// ══════════════════════════════════════════════════════════════════════════
// TIPOS E LIMITES PERMITIDOS PARA UPLOAD
//
// PDF/imagem/DOCX/XLSX/PPTX: limites pequenos o bastante (≤25MB) para
// caberem com folga no limite de memória de uma invocação do Worker
// (128MB) — o caminho multipart + arrayBuffer() é seguro aqui.
//
// MP4: NUNCA passa por multipart/form-data + arrayBuffer(). O corpo da
// requisição já é o arquivo bruto e vai direto de request.body
// (ReadableStream) pro R2.put(), sem nunca ser materializado inteiro numa
// variável do Worker. Limite de 80MB: abaixo do teto de 100MB de corpo de
// requisição do plano Free do Cloudflare, com margem de segurança — como o
// vídeo não usa multipart, não há overhead de boundary/headers competindo
// com essa margem, mas o teto de 100MB é da plataforma, não é algo que o
// código do Worker consiga contornar de qualquer forma.
// ══════════════════════════════════════════════════════════════════════════
const MB = 1024 * 1024;
const TIPOS_PERMITIDOS_MULTIPART = {
  'application/pdf': 25 * MB,
  'image/jpeg': 10 * MB,
  'image/png': 10 * MB,
  'image/webp': 10 * MB,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 25 * MB,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 25 * MB,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 25 * MB
};
const LIMITE_MP4 = 80 * MB;

// ══════════════════════════════════════════════════════════════════════════
// ROTA — POST /api/storage/upload
// Dois caminhos internos: multipart (arquivos pequenos) e streaming (MP4).
// ══════════════════════════════════════════════════════════════════════════
async function handleUpload(request, env) {
  if (request.method !== 'POST') {
    return jsonError(request, 'method_not_allowed', 405, { Allow: 'POST' });
  }
  const authResult = await exigirAutenticacao(request, env);
  if (!authResult.ok) return jsonError(request, authResult.status === 500 ? 'internal_error' : 'unauthorized', authResult.status);

  const contentType = request.headers.get('Content-Type') || '';

  if (contentType === 'video/mp4') {
    return handleUploadStreamVideo(request, env, authResult.user);
  }

  return handleUploadMultipart(request, env, authResult.user);
}

// Caminho multipart — PDF, imagem, DOCX/XLSX/PPTX.
async function handleUploadMultipart(request, env, user) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonError(request, 'invalid_request', 400);
  }

  const file = form.get('file');
  const moduloRaw = form.get('modulo');
  const categoriaRaw = form.get('categoria');
  const operacaoIdRaw = form.get('operacaoId');
  const referenciaIdRaw = form.get('referenciaId');

  if (!file || typeof file.arrayBuffer !== 'function') return jsonError(request, 'invalid_request', 400);
  if (!moduloRaw || !categoriaRaw || !operacaoIdRaw) return jsonError(request, 'invalid_request', 400);

  const modulo = sanitizarSegmentoPath(moduloRaw);
  const categoria = sanitizarSegmentoPath(categoriaRaw);
  const operacaoId = sanitizarSegmentoPath(operacaoIdRaw);
  if (!modulo || !categoria || !operacaoId) return jsonError(request, 'invalid_request', 400);

  const limite = TIPOS_PERMITIDOS_MULTIPART[file.type];
  if (!limite) return jsonError(request, 'unsupported_file_type', 415);
  if (file.size > limite) return jsonError(request, 'file_too_large', 413);

  const uuid = crypto.randomUUID();
  const nomeOriginal = String(file.name || 'arquivo').slice(0, 200);
  const nomeSanitizado = sanitizarNomeArquivo(file.name);
  const path = montarPathArquivo(operacaoId, modulo, categoria, uuid, nomeSanitizado);
  const referenciaId = referenciaIdRaw ? String(referenciaIdRaw).slice(0, 120) : '';

  try {
    const bytes = await file.arrayBuffer();
    await env.ARQUIVOS_BUCKET.put(path, bytes, {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        uploadedByUid: user.uid,
        uploadedByEmail: user.email || '',
        modulo, categoria, operacaoId, referenciaId,
        nomeOriginal
      }
    });
  } catch (e) {
    console.error('[storage/upload] falha ao gravar no R2, path=', path, 'erro=', e && e.message);
    return jsonError(request, 'storage_error', 500);
  }

  return jsonResponse(request, 200, {
    ok: true,
    arquivo: {
      id: uuid, path, nomeOriginal, mimeType: file.type, tamanho: file.size,
      modulo, categoria, operacaoId, referenciaId: referenciaId || null,
      criadoPor: user.email, criadoEm: new Date().toISOString()
    }
  });
}

// Caminho streaming — MP4. Metadados vêm da query string (não há multipart
// pra carregar campos de formulário). O corpo da requisição é o arquivo
// bruto, direto de request.body pro R2, sem materializar em memória.
async function handleUploadStreamVideo(request, env, user) {
  const url = new URL(request.url);
  const moduloRaw = url.searchParams.get('modulo');
  const categoriaRaw = url.searchParams.get('categoria');
  const operacaoIdRaw = url.searchParams.get('operacaoId');
  const referenciaIdRaw = url.searchParams.get('referenciaId');
  const nomeOriginalRaw = url.searchParams.get('filename');

  if (!moduloRaw || !categoriaRaw || !operacaoIdRaw) return jsonError(request, 'invalid_request', 400);

  const modulo = sanitizarSegmentoPath(moduloRaw);
  const categoria = sanitizarSegmentoPath(categoriaRaw);
  const operacaoId = sanitizarSegmentoPath(operacaoIdRaw);
  if (!modulo || !categoria || !operacaoId) return jsonError(request, 'invalid_request', 400);

  if (!request.body) return jsonError(request, 'invalid_request', 400);

  // Primeira barreira, barata: Content-Length declarado, checado ANTES de
  // gastar tempo/CPU escrevendo no R2. Não é a fonte de verdade final (ver
  // checagem pós-gravação abaixo), só evita processar de graça um upload
  // que já se anuncia acima do limite.
  const declaredLength = parseInt(request.headers.get('Content-Length') || '', 10);
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) return jsonError(request, 'invalid_request', 400);
  if (declaredLength > LIMITE_MP4) return jsonError(request, 'file_too_large', 413);

  const uuid = crypto.randomUUID();
  const nomeOriginal = String(nomeOriginalRaw || 'video.mp4').slice(0, 200);
  const nomeSanitizado = sanitizarNomeArquivo(nomeOriginalRaw || 'video.mp4');
  const path = montarPathArquivo(operacaoId, modulo, categoria, uuid, nomeSanitizado);
  const referenciaId = referenciaIdRaw ? String(referenciaIdRaw).slice(0, 120) : '';

  let objetoGravado;
  try {
    // request.body é um ReadableStream — vai direto pro R2.put() sem nunca
    // ser materializado inteiro em uma variável do Worker. Esta é a forma
    // de streaming oficialmente suportada pelo binding R2 dos Workers.
    objetoGravado = await env.ARQUIVOS_BUCKET.put(path, request.body, {
      httpMetadata: { contentType: 'video/mp4' },
      customMetadata: {
        uploadedByUid: user.uid,
        uploadedByEmail: user.email || '',
        modulo, categoria, operacaoId, referenciaId,
        nomeOriginal
      }
    });
  } catch (e) {
    console.error('[storage/upload] falha ao gravar vídeo no R2 (stream), path=', path, 'erro=', e && e.message);
    return jsonError(request, 'storage_error', 500);
  }

  // Fonte de verdade final: tamanho REAL do objeto gravado. Se o
  // Content-Length declarado tiver mentido e o corpo real ultrapassar o
  // limite, desfaz o upload — nunca fica um arquivo acima do limite lógico
  // parado no bucket.
  const tamanhoReal = objetoGravado ? objetoGravado.size : declaredLength;
  if (tamanhoReal > LIMITE_MP4) {
    try { await env.ARQUIVOS_BUCKET.delete(path); }
    catch (eDel) { console.error('[storage/upload] falha ao remover vídeo acima do limite, path=', path, 'erro=', eDel && eDel.message); }
    return jsonError(request, 'file_too_large', 413);
  }

  return jsonResponse(request, 200, {
    ok: true,
    arquivo: {
      id: uuid, path, nomeOriginal, mimeType: 'video/mp4', tamanho: tamanhoReal,
      modulo, categoria, operacaoId, referenciaId: referenciaId || null,
      criadoPor: user.email, criadoEm: new Date().toISOString()
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// ROTAS — GET /api/storage/file (inline) e GET /api/storage/download
// (attachment) — mesma função, com suporte a Range para vídeo.
//
// ⚠ AUTORIZAÇÃO AINDA NÃO IMPLEMENTADA NESTA ROTA — autenticação (saber
// QUEM está pedindo) não é suficiente aqui. Hoje, qualquer usuário
// autenticado com um path válido consegue ler qualquer arquivo do bucket.
// Antes de conectar esta rota ao frontend (Central de Conhecimento ou
// qualquer outro módulo), será obrigatório adicionar uma camada de
// autorização que confirme se este usuário específico pode acessar ESTE
// path — considerando operacaoId, módulo, perfil do usuário e público-alvo
// do conteúdo. Essa autorização não está sendo desenhada nem implementada
// agora — só sinalizada aqui para a próxima etapa.
// ══════════════════════════════════════════════════════════════════════════
function parseRangeHeader(rangeHeader, totalSize) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {
    const suffixLength = end;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else if (end === null) {
    end = totalSize - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start > end || start >= totalSize || start < 0) return null;
  end = Math.min(end, totalSize - 1);
  return { offset: start, length: end - start + 1, end };
}

async function handleFileRead(request, env, opts) {
  if (request.method !== 'GET') {
    return jsonError(request, 'method_not_allowed', 405, { Allow: 'GET' });
  }
  const authResult = await exigirAutenticacao(request, env);
  if (!authResult.ok) return jsonError(request, authResult.status === 500 ? 'internal_error' : 'unauthorized', authResult.status);

  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!pathValido(path)) return jsonError(request, 'invalid_path', 400);

  let head;
  try {
    head = await env.ARQUIVOS_BUCKET.head(path);
  } catch (e) {
    console.error('[storage/file] erro ao consultar R2, path=', path, 'erro=', e && e.message);
    return jsonError(request, 'storage_error', 500);
  }
  if (!head) return jsonError(request, 'file_not_found', 404);

  const totalSize = head.size;
  const contentType = (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream';
  const nomeParaExibir = sanitizarNomeArquivo((head.customMetadata && head.customMetadata.nomeOriginal) || 'arquivo');
  const disposicao = opts.attachment ? 'attachment' : 'inline';

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const parsed = parseRangeHeader(rangeHeader, totalSize);
    if (!parsed) {
      return new Response(null, {
        status: 416,
        headers: baseHeaders(request, { 'Content-Range': `bytes */${totalSize}`, 'Cache-Control': 'private, no-store' })
      });
    }
    let obj;
    try {
      obj = await env.ARQUIVOS_BUCKET.get(path, { range: { offset: parsed.offset, length: parsed.length } });
    } catch (e) {
      console.error('[storage/file] erro ao ler range do R2, path=', path, 'erro=', e && e.message);
      return jsonError(request, 'storage_error', 500);
    }
    if (!obj) return jsonError(request, 'file_not_found', 404);
    const headers = baseHeaders(request, {
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${parsed.offset}-${parsed.end}/${totalSize}`,
      'Content-Length': String(parsed.length),
      'Content-Disposition': `${disposicao}; filename="${nomeParaExibir}"`
    });
    return new Response(obj.body, { status: 206, headers });
  }

  let obj;
  try {
    obj = await env.ARQUIVOS_BUCKET.get(path);
  } catch (e) {
    console.error('[storage/file] erro ao ler do R2, path=', path, 'erro=', e && e.message);
    return jsonError(request, 'storage_error', 500);
  }
  if (!obj) return jsonError(request, 'file_not_found', 404);

  const headers = baseHeaders(request, {
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(totalSize),
    'Content-Disposition': `${disposicao}; filename="${nomeParaExibir}"`
  });
  return new Response(obj.body, { status: 200, headers });
}

// ══════════════════════════════════════════════════════════════════════════
// ROTA — GET /api/storage/metadata
//
// ⚠ AUTORIZAÇÃO AINDA NÃO IMPLEMENTADA NESTA ROTA — mesma observação da
// rota de leitura acima: autenticação sozinha não é suficiente. Qualquer
// usuário autenticado com um path válido consegue ver os metadados de
// qualquer arquivo do bucket hoje. A camada de autorização por
// operacaoId/módulo/perfil/público do conteúdo é obrigatória antes desta
// rota ser conectada ao frontend, e não está sendo implementada agora.
// ══════════════════════════════════════════════════════════════════════════
async function handleMetadata(request, env) {
  if (request.method !== 'GET') {
    return jsonError(request, 'method_not_allowed', 405, { Allow: 'GET' });
  }
  const authResult = await exigirAutenticacao(request, env);
  if (!authResult.ok) return jsonError(request, authResult.status === 500 ? 'internal_error' : 'unauthorized', authResult.status);

  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!pathValido(path)) return jsonError(request, 'invalid_path', 400);

  let obj;
  try {
    obj = await env.ARQUIVOS_BUCKET.head(path);
  } catch (e) {
    console.error('[storage/metadata] erro ao consultar R2, path=', path, 'erro=', e && e.message);
    return jsonError(request, 'storage_error', 500);
  }
  if (!obj) return jsonError(request, 'file_not_found', 404);

  return jsonResponse(request, 200, {
    ok: true,
    path,
    size: obj.size,
    etag: obj.httpEtag || obj.etag || null,
    uploaded: obj.uploaded ? new Date(obj.uploaded).toISOString() : null,
    httpMetadata: obj.httpMetadata || {},
    customMetadata: obj.customMetadata || {}
  });
}

// ══════════════════════════════════════════════════════════════════════════
// ROTA — DELETE /api/storage/file
//
// ⚠ AUTORIZAÇÃO AINDA NÃO IMPLEMENTADA NESTA ROTA — a única barreira além
// da autenticação, hoje, é a checagem de que o path informado começa pela
// operacaoId também informada no corpo da requisição. Isso NÃO impede que
// qualquer usuário autenticado de uma operacaoId apague qualquer arquivo
// daquela mesma operacaoId, independente de módulo, perfil ou se ele
// realmente tem permissão sobre aquele conteúdo específico. Antes de
// conectar esta rota ao frontend, será obrigatória uma camada de
// autorização real (módulo/perfil/público do conteúdo) — não implementada
// nem desenhada agora, só sinalizada aqui.
// ══════════════════════════════════════════════════════════════════════════
async function handleDelete(request, env) {
  if (request.method !== 'DELETE') {
    return jsonError(request, 'method_not_allowed', 405, { Allow: 'DELETE' });
  }
  const authResult = await exigirAutenticacao(request, env);
  if (!authResult.ok) return jsonError(request, authResult.status === 500 ? 'internal_error' : 'unauthorized', authResult.status);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError(request, 'invalid_request', 400);
  }

  const path = body && body.path;
  const operacaoId = body && body.operacaoId;

  if (!pathValido(path)) return jsonError(request, 'invalid_path', 400);
  if (!operacaoId || typeof operacaoId !== 'string') return jsonError(request, 'invalid_request', 400);
  if (!path.startsWith(operacaoId + '/')) return jsonError(request, 'invalid_request', 400);

  let existe;
  try {
    existe = await env.ARQUIVOS_BUCKET.head(path);
  } catch (e) {
    console.error('[storage/delete] erro ao consultar R2, path=', path, 'erro=', e && e.message);
    return jsonError(request, 'storage_error', 500);
  }
  if (!existe) return jsonError(request, 'file_not_found', 404);

  try {
    await env.ARQUIVOS_BUCKET.delete(path);
  } catch (e) {
    console.error('[storage/delete] falha ao excluir do R2, path=', path, 'erro=', e && e.message);
    return jsonError(request, 'storage_error', 500);
  }

  return jsonResponse(request, 200, { ok: true, deleted: true });
}

// ══════════════════════════════════════════════════════════════════════════
// ROTEAMENTO — só as rotas exatas abaixo são interceptadas. Sem catch-all
// para /api. Qualquer outra URL, incluindo o sistema principal, continua
// sendo entregue por env.ATIVOS.fetch(request), sem nenhuma condição a mais.
// ══════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/storage/health') return handleStorageHealth(request, env);
    if (path === '/api/storage/auth-check') return handleStorageAuthCheck(request, env);
    if (path === '/api/storage/upload') return handleUpload(request, env);
    if (path === '/api/storage/metadata') return handleMetadata(request, env);
    if (path === '/api/storage/download') return handleFileRead(request, env, { attachment: true });
    if (path === '/api/storage/file') {
      if (request.method === 'DELETE') return handleDelete(request, env);
      return handleFileRead(request, env, { attachment: false });
    }

    // Fallback atual, preservado integralmente.
    return env.ATIVOS.fetch(request);
  }
};
