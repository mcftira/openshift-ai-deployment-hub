// HF pull-through proxy for networks where huggingface.co is unreachable.
// Routes:
//   /<org>/<repo>/resolve/...  -> huggingface.co (same path+query)
//   /api/...                   -> huggingface.co (same path+query)
//   /__ext__/?u=<b64url>       -> allow-listed HF-owned CDN hosts (used to
//                                 keep 302 redirects off the client network)
const ALLOWED_HOST = (h) =>
  h === "huggingface.co" || h.endsWith(".huggingface.co") ||
  h === "hf.co" || h.endsWith(".hf.co");

const b64urlEncode = (s) =>
  btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const b64urlDecode = (s) =>
  atob(s.replaceAll("-", "+").replaceAll("_", "/"));

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }

    let target;
    if (url.pathname === "/__ext__/") {
      const u = url.searchParams.get("u");
      if (!u) return new Response("missing u", { status: 400 });
      try {
        target = new URL(b64urlDecode(u));
      } catch {
        return new Response("bad u", { status: 400 });
      }
      if (target.protocol !== "https:" || !ALLOWED_HOST(target.hostname)) {
        return new Response("host not allowed", { status: 403 });
      }
    } else {
      target = new URL("https://huggingface.co" + url.pathname + url.search);
    }

    const upstream = await fetch(
      new Request(target.toString(), {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      })
    );

    // Keep redirects on this proxy so the client never has to reach HF/CDN.
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const loc = upstream.headers.get("location");
      if (loc) {
        const abs = new URL(loc, target);
        const headers = new Headers(upstream.headers);
        if (ALLOWED_HOST(abs.hostname)) {
          headers.set(
            "location",
            url.origin + "/__ext__/?u=" + b64urlEncode(abs.toString())
          );
        }
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(null, { status: upstream.status, headers });
      }
    }

    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
