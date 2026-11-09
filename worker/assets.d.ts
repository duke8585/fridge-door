/** Vite `?raw` imports: the file's text, bundled at build time. */
declare module "*.md?raw" {
  const text: string;
  export default text;
}
