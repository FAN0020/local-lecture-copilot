export class MicrophoneTimeoutError extends Error {
  constructor() {
    super('Microphone access request timed out');
    this.name = 'MicrophoneTimeoutError';
  }
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

export function requestMicrophone(getUserMedia, constraints, {
  timeoutMs = 15_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let settled = false;
  let timer;
  const acquisition = Promise.resolve().then(() => getUserMedia(constraints));

  return new Promise((resolve, reject) => {
    timer = setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new MicrophoneTimeoutError());
    }, timeoutMs);

    acquisition.then((stream) => {
      if (settled) {
        stopStream(stream);
        return;
      }
      settled = true;
      clearTimer(timer);
      resolve(stream);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      reject(error);
    });
  });
}
