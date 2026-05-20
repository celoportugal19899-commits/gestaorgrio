export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const asset = await env.ASSETS.fetch(request);
    return new Response(asset.body, {
      status: asset.status,
      headers: {
        ...Object.fromEntries(asset.headers),
        'Content-Type': 'text/html; charset=utf-8'
      }
    });
  }
}
