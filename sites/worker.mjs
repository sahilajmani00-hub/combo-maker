// Sites enforces the owner/visitor allowlist before dispatching requests.
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request)
    const secured = new Response(response.body, response)
    secured.headers.set('X-Content-Type-Options', 'nosniff')
    secured.headers.set('Referrer-Policy', 'no-referrer')
    secured.headers.set('Cache-Control', 'no-store')
    return secured
  },
}
