// Identity bootstrap only: no durable/provider bindings and no data operations.
// Access owns its /cdn-cgi authentication flow in front of this inert response.
export default {
  fetch() {
    return new Response('Private qualification identity setup. The application is not active.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
