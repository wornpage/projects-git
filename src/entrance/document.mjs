// Rewrite only document-owned asset URLs; module imports remain relative.
export function workbenchDocument(html, assetPrefix, {demo = false} = {}) {
  const root = demo ? '/demo/' : '/workspace/';
  return html.replace(/\b(src|href)="\/([^"?#]+\.(?:js|css))"/g,
    (_, attribute, path) => `${attribute}="${assetPrefix}${path}"`)
    .replaceAll('href="/?view=', 'href="?view=')
    .replace('href="/">Sign in with Access', `href="${root}">Sign in with Access`)
    .replace('href="/reviewer.html"', 'href="/workspace/reviewer"');
}
