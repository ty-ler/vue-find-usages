import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import type { RawUsage } from './scanCore';

export interface ParseResult {
  fsPath: string;
  raw: RawUsage[];
}

interface CancelToken {
  isCancellationRequested: boolean;
}

/** Recommended worker count: leave a core for the main thread, cap the fleet. */
export function recommendedWorkerCount(): number {
  return Math.min(8, Math.max(1, os.cpus().length - 1));
}

/**
 * A fixed pool of worker threads that parse files off the main thread. Files are
 * round-robined across workers (so heavy/light files spread evenly) and each
 * file's result is streamed back as it completes.
 */
export class ParsePool {
  private readonly workers: Worker[] = [];

  constructor(size: number) {
    const workerFile = path.join(__dirname, 'indexWorker.js');
    for (let i = 0; i < size; i++) {
      this.workers.push(new Worker(workerFile));
    }
  }

  get size(): number {
    return this.workers.length;
  }

  run(
    files: string[],
    onResult: (result: ParseResult) => void,
    token?: CancelToken,
  ): Promise<void> {
    const chunks: string[][] = this.workers.map(() => []);
    files.forEach((f, i) => chunks[i % this.workers.length].push(f));
    return Promise.all(
      this.workers.map((w, i) => this.runChunk(w, chunks[i], onResult, token)),
    ).then(() => undefined);
  }

  private runChunk(
    worker: Worker,
    files: string[],
    onResult: (result: ParseResult) => void,
    token?: CancelToken,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (files.length === 0) {
        resolve();
        return;
      }
      const onMessage = (msg: any) => {
        if (msg && msg.done) {
          worker.off('message', onMessage);
          resolve();
          return;
        }
        if (!token?.isCancellationRequested) {
          onResult(msg as ParseResult);
        }
      };
      worker.on('message', onMessage);
      // If a worker dies (error) or is terminated, settle so the run can finish.
      worker.once('error', () => {
        worker.off('message', onMessage);
        resolve();
      });
      worker.once('exit', () => {
        worker.off('message', onMessage);
        resolve();
      });
      worker.postMessage({ files });
    });
  }

  async dispose(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
  }
}
