// Types only. Runtime resolution of 'next/link' is handled by vinext's vite
// plugin (→ its shim). Mirroring the pattern used for 'next/navigation' —
// do NOT add a tsconfig `paths` entry, since that would make the bundler
// resolve the import to this .d.ts at runtime.
declare module 'next/link' {
  export * from 'vinext/shims/link'
  export { default } from 'vinext/shims/link'
}
