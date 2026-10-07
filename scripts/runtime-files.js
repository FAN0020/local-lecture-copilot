import fs from 'node:fs/promises';

// Release libraries use aliases such as libwhisper.so.1 -> libwhisper.so.1.9.3.
// Materialize aliases so staging/build copies never point back into a temp dir.
export async function copyRuntimeDirectory(source, destination) {
  await fs.cp(source, destination, { recursive: true, dereference: true });
}
