// Runs in the AudioWorklet global scope, so it must be a packaged file rather
// than part of the panel bundle. It only forwards mono samples; every decision
// about what to keep lives on the main thread.
class BrowserGuideRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // A copy: the render quantum's buffer is reused by the engine.
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}

registerProcessor("browser-guide-recorder", BrowserGuideRecorderProcessor);
