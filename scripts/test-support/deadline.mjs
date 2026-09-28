// Test deadlines are referenced while pending and cancelled on every outcome.
export async function withDeadline(promise, milliseconds, onTimeout = () => {
  throw new Error(`Timed out after ${milliseconds}ms`);
}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        try { resolve(onTimeout()); } catch (error) { reject(error); }
      }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function waitForChildMessage(child, predicate, milliseconds) {
  let onMessage, onExit, onError;
  try {
    return await withDeadline(new Promise((resolve, reject) => {
      onMessage = (message) => { if (predicate(message)) resolve(message); };
      onExit = () => reject(new Error('Child exited before the expected message'));
      onError = reject;
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
      if (child.exitCode !== null || child.signalCode !== null) onExit();
    }), milliseconds);
  } finally {
    child.off('message', onMessage);
    child.off('exit', onExit);
    child.off('error', onError);
  }
}
