declare module '*.css' { const text: string; export default text }
declare module '*/listing.mjs' {
  export function decodeListing(text: string | undefined): unknown
}
