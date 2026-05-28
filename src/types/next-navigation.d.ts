// Types only. Runtime resolution of 'next/navigation' is handled by vinext's
// vite plugin (→ its shim). Do NOT add a tsconfig `paths` entry for this module:
// the Cloudflare/vinext bundler consults tsconfig paths and would resolve the
// import to this .d.ts at runtime, leaving getNavigationContext undefined.
declare module 'next/navigation' {
  export * from 'vinext/shims/navigation'
}
