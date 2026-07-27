const CLIENT_HOST = "client.vishnu.one";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/client" || url.pathname.startsWith("/client/")) {
      return Response.redirect(new URL(`${url.pathname}${url.search}`, `https://${CLIENT_HOST}`), 307);
    }

    if (url.pathname === "/public-feed") {
      const assetUrl = new URL("/public-feed.json", url);
      const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
      const headers = new Headers(asset.headers);
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("Cache-Control", "public, max-age=300");
      return new Response(asset.body, { status: asset.status, headers });
    }

    return env.ASSETS.fetch(request);
  },
};
