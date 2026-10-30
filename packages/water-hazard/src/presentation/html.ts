/** 所有动态字段转义后进入固定模板；持久化页面自包含。 */
export function escape(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
export function documentHtml(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`
  const resize = `<script>(()=>{if(parent===window)return;const send=()=>parent.postMessage({type:'chart-document:height',height:Math.ceil(document.body.getBoundingClientRect().height)},'*');new ResizeObserver(send).observe(document.body);addEventListener('load',send);send()})()</script>`
  return html.replace('<head>', `<head>${policy}`).replace('</body>', `${resize}</body>`)
}
