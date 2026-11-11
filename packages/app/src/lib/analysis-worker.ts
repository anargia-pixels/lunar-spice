import {
  acSweep,
  operatingPoint,
  transient,
} from "@lunar-spice/simulator/analyses";

import type { AnalysisRequest, AnalysisResponse } from "./analysis-request";

function run(request: AnalysisRequest) {
  switch (request.kind) {
    case "dc":
      return operatingPoint(request.text);
    case "ac":
      return acSweep(request.text, request.options);
    case "transient":
      return transient(request.text, request.options);
  }
}

// Analyses run here, off the UI thread, so long sweeps never freeze the editor.
self.addEventListener("message", (event: MessageEvent<AnalysisRequest>) => {
  let response: AnalysisResponse;

  try {
    response = { isOk: true, result: run(event.data) };
  } catch (cause) {
    response = {
      isOk: false,
      error: cause instanceof Error ? cause.message : "The analysis failed.",
    };
  }

  self.postMessage(response);
});
