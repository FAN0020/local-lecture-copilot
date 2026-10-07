/** Wait for all captured samples before draining the speech segmenter. */
export function flushPcmWorklet(node, { timeoutMs = 1500 } = {}) {
  if (!node) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      node.port.removeEventListener('message', onMessage);
    };
    const onMessage = (event) => {
      if (event.data?.type !== 'flushed') return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Audio capture did not acknowledge its final samples.'));
    }, timeoutMs);
    node.port.addEventListener('message', onMessage);
    try {
      node.port.postMessage({ type: 'flush' });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
