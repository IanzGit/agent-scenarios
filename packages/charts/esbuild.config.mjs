/** 外部 Harness 插件的 lazy-CJS Client 构建，浏览器依赖内联，React 使用宿主实例。 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const { name } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
await build({
  entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2023', jsx: 'automatic', minify: true,
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
