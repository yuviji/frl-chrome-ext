import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    background: 'src/background.ts',
    content: 'src/content.ts'
  },
  outDir: 'dist',
  format: ['esm'],
  sourcemap: true,
  minify: true,
  clean: true,
  target: 'es2022',
  dts: false,
  splitting: false,
})
