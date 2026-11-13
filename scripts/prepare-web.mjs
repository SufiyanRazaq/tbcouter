import { copyFile, mkdir } from 'node:fs/promises';
const out = new URL('../public/ocr/', import.meta.url);
await mkdir(out, { recursive: true });
await copyFile(new URL('../node_modules/tesseract.js/dist/worker.min.js', import.meta.url), new URL('worker.min.js', out));
await copyFile(new URL('../node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt', import.meta.url), new URL('worker.min.js.LICENSE.txt', out));
for (const name of ['tesseract-core-lstm.wasm.js','tesseract-core-simd-lstm.wasm.js','tesseract-core-lstm.wasm','tesseract-core-simd-lstm.wasm']) {
  await copyFile(new URL('../node_modules/tesseract.js-core/' + name, import.meta.url), new URL(name, out));
}
await copyFile(new URL('../node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', import.meta.url), new URL('eng.traineddata.gz', out));
console.log('Prepared self-hosted OCR worker, WebAssembly and English model.');
