// Worker do GestãoRGRio.
// Comportamento preservado: toda rota que não seja explicitamente
// interceptada abaixo continua sendo entregue por env.ATIVOS.fetch(request),
// exatamente como antes desta alteração.

async function handleStorageHealth(request, env) {
  // Só GET nesta rota — qualquer outro método retorna 405.
  if (request.method !== 'GET') {
    return new Response(
      JSON.stringify({ ok: false, error: 'method_not_allowed' }),
      {
        status: 405,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Cache-Control': 'no-store',
          'Allow': 'GET'
        }
      }
    );
  }

  try {
    if (!env.ARQUIVOS_BUCKET) {
      throw new Error('binding_missing');
    }

    // Operação segura e somente leitura: lista no máximo 1 objeto do bucket.
    // Nunca cria, altera ou exclui nada.
    await env.ARQUIVOS_BUCKET.list({ limit: 1 });

    return new Response(
      JSON.stringify({
        ok: true,
        service: 'cloudflare-r2',
        bucket: 'gestaorgrio-arquivos',
        binding: 'ARQUIVOS_BUCKET',
        status: 'connected'
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Cache-Control': 'no-store'
        }
      }
    );
  } catch (err) {
    // Nunca expor stack trace nem detalhe interno do erro na resposta.
    return new Response(
      JSON.stringify({
        ok: false,
        service: 'cloudflare-r2',
        bucket: 'gestaorgrio-arquivos',
        binding: 'ARQUIVOS_BUCKET',
        status: 'error'
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Só esta rota exata é interceptada nesta etapa — nada de bloqueio
    // genérico para /api, conforme instruído.
    if (url.pathname === '/api/storage/health') {
      return handleStorageHealth(request, env);
    }

    // Fallback atual, preservado integralmente.
    return env.ATIVOS.fetch(request);
  }
};
