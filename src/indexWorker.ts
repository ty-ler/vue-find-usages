import { parentPort } from 'worker_threads';
import { readFileSync } from 'fs';
import { extractRawUsages, RawUsage } from './scanCore';
import { importResolvesToVue } from './resolve';
import { setComponentExtensions } from './componentExt';

// Worker-thread entry: receives a batch of file paths, reads + parses each on a
// background thread, and streams one message per file back to the main thread,
// followed by a `{ done: true }` sentinel. Only imports vscode-free modules.

const port = parentPort;
if (!port) {
  throw new Error('indexWorker.js must be run as a worker thread');
}

port.on('message', (msg: { files?: string[]; suffixes?: string[] }) => {
  // Apply the main thread's configured component suffixes for this batch.
  setComponentExtensions(msg.suffixes);
  const files = msg.files ?? [];
  for (const fsPath of files) {
    let raw: RawUsage[];
    try {
      const text = readFileSync(fsPath, 'utf8');
      raw = extractRawUsages(text, fsPath, importResolvesToVue);
    } catch {
      raw = [];
    }
    port.postMessage({ fsPath, raw });
  }
  port.postMessage({ done: true });
});
