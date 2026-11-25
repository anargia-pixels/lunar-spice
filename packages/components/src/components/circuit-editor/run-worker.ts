import { RunEngine } from "./run-engine";
import type { FromWorker, ToWorker } from "./run-protocol";

/**
 * Longest the worker steps before it looks at its messages. Snapshots wait for the end of
 * a slice, so it stays well under a frame.
 */
const SLICE_MS = 8;

/** How long the worker rests once caught up with real time, in milliseconds. */
const IDLE_MS = 1;

/**
 * The editor sends a frame message every animation frame while it shows the run. After
 * this long without one, as when its tab is hidden, the worker pauses, as the editor's
 * own animation frames would.
 */
const FRAME_TIMEOUT_MS = 250;

const engine = new RunEngine();

/** Wakes the loop at once, without the delay a chain of timers builds up. */
const wake = new MessageChannel();

/** True while a slice is due, so messages do not start a second loop. */
let isScheduled = false;

/** When the editor last sent a frame message, in milliseconds. */
let lastFrame = 0;

function post(message: FromWorker) {
  const transfer: Transferable[] = [message.voltages.buffer];

  for (const scope of message.scopes) {
    transfer.push(scope.voltages.buffer, scope.currents.buffer);
  }

  for (const { live, triggered } of message.oscilloscopes) {
    for (const trace of [live, triggered]) {
      for (const channel of trace?.channels ?? []) {
        if (channel) {
          transfer.push(
            channel.extremes.buffer,
            channel.means.buffer,
            channel.squares.buffer,
          );
        }
      }
    }
  }

  if (message.sound) {
    transfer.push(message.sound.buffer);
  }

  self.postMessage(message, { transfer });
}

/**
 * Steps for one slice, then schedules the next: at once while steps are still owed, soon
 * otherwise.
 */
function pump() {
  isScheduled = false;

  const now = performance.now();

  if (!engine.isStepping || now - lastFrame > FRAME_TIMEOUT_MS) {
    engine.rest();

    return;
  }

  const isOwed = engine.run(now, SLICE_MS);

  isScheduled = true;

  if (isOwed) {
    wake.port2.postMessage(null);
  } else {
    setTimeout(pump, IDLE_MS);
  }
}

/** Starts the loop unless it is already going. */
function schedule() {
  if (!isScheduled && engine.isStepping) {
    isScheduled = true;
    wake.port2.postMessage(null);
  }
}

wake.port1.addEventListener("message", pump);

wake.port1.start();

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const message = event.data;

  switch (message.kind) {
    case "load":
      engine.load(
        message.generation,
        message.elements,
        message.settings,
        message.isRestart,
      );
      break;
    case "settings":
      engine.updateSettings(message.settings);
      break;
    case "running":
      engine.setRunning(message.isRunning);

      // A pause reports where it stopped.
      if (!message.isRunning) {
        post(engine.snapshot());
      }

      break;
    case "scopes":
      engine.setScopes(message.scopes);
      break;
    case "oscilloscopes":
      engine.setOscilloscopes(message.oscilloscopes);
      break;
    case "frame":
      lastFrame = performance.now();
      engine.updateSound(message.sound);
      post(engine.snapshot());
      break;
    case "input":
      engine.writeInput(message.samples);
      break;
    case "clip":
      engine.setClip(message.elementId, message.samples, message.sampleRate);
      break;
  }

  schedule();
});
