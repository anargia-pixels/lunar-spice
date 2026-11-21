import { activeBuffer, useCircuitStore } from "../stores/circuit-store";
import { useSimulationStore } from "../stores/simulation-store";
import {
  AGENT_TOOLS,
  type AgentTool,
  type CircuitHost,
  type JsonObject,
  type JsonValue,
  runAgentTool,
} from "./agent-tools";

/** The editor of the open circuit; throws while none is mounted. */
function editor() {
  const current = useSimulationStore.getState().editor;

  if (!current) {
    throw new Error("The editor is not open yet.");
  }

  return current;
}

/** The open circuit in the app: the active buffer, its editor and the analysis panel. */
const appHost: CircuitHost = {
  title: () => activeBuffer(useCircuitStore.getState())?.title ?? "untitled",
  text: () => activeBuffer(useCircuitStore.getState())?.text ?? "",
  edit: (change) => editor().editCircuit(change),
  openDraft: (title, text) => useCircuitStore.getState().openText(title, text),
  analyze: async (request) => {
    const buffer = activeBuffer(useCircuitStore.getState());

    if (!buffer) {
      throw new Error("There is no open circuit.");
    }

    // The simulation panel shows the run, so the user sees what the agent ran.
    const store = useSimulationStore.getState();

    store.setAnalysis(request.kind);

    if (request.kind === "ac") {
      store.setAcOptions(request.options);
    } else if (request.kind === "transient") {
      store.setTransientOptions(request.options);
    }

    const response = await store.runAnalysis(buffer.id, request.text);

    if (!response.isOk) {
      throw new Error(response.error);
    }

    return response.result;
  },
  simulate: (action) => {
    const { status } = useSimulationStore.getState();

    if (action === "reset") {
      editor().resetSimulation();

      return { isRunning: status.isRunning, time: 0, error: null };
    }

    const isRunning = action === "status" ? status.isRunning : action === "run";

    if (isRunning !== status.isRunning) {
      editor().toggleRunning();
    }

    return { isRunning, time: status.time, error: status.error };
  },
};

/** Runs a tool: its result, or `{ error }` with what the agent can fix. */
async function callTool(name: string, input?: JsonValue): Promise<JsonValue> {
  try {
    return await runAgentTool(name, input, appHost);
  } catch (cause) {
    return {
      error: cause instanceof Error ? cause.message : "The tool failed.",
    };
  }
}

/** What an early WebMCP build hands back from `registerTool`, to unregister with. */
type ToolHandle = { unregister?: () => void };

/** A tool as WebMCP's `registerTool` takes it. */
type ModelContextTool = Omit<AgentTool, "run"> & {
  execute: (input: JsonObject) => Promise<string>;
};

/** The part of WebMCP's model context the app uses. */
type ModelContext = {
  registerTool: (
    tool: ModelContextTool,
    options: { signal: AbortSignal },
  ) => Promise<ToolHandle | undefined> | ToolHandle | undefined;
};

function isModelContext(value: unknown): value is ModelContext {
  return (
    value instanceof Object &&
    "registerTool" in value &&
    value.registerTool instanceof Function
  );
}

/**
 * The browser's WebMCP model context: `document.modelContext` as the draft has it now,
 * or `navigator.modelContext` in browsers from before the move; null without WebMCP.
 */
function modelContext() {
  const holders = [globalThis.document, globalThis.navigator];

  for (const holder of holders) {
    if (holder instanceof Object && "modelContext" in holder) {
      const context = holder.modelContext;

      if (isModelContext(context)) {
        return context;
      }
    }
  }

  return null;
}

/** The tools for scripts that drive the page without WebMCP, such as browser automation. */
const pageTools = {
  tools: AGENT_TOOLS.map(
    ({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations,
    }),
  ),
  callTool,
};

/** Registers every agent tool with `context`; returns what withdraws them. */
function registerTools(context: ModelContext) {
  const controller = new AbortController();
  const handles: ToolHandle[] = [];

  for (const {
    name,
    title,
    description,
    inputSchema,
    annotations,
  } of AGENT_TOOLS) {
    // WebMCP hands the result on to the agent as text.
    const execute = async (input: JsonObject) =>
      JSON.stringify(await callTool(name, input));

    Promise.resolve(
      context.registerTool(
        { name, title, description, inputSchema, annotations, execute },
        { signal: controller.signal },
      ),
    )
      .then((handle) => {
        if (handle) {
          handles.push(handle);
        }
      })
      .catch(() => {
        // A tool the page already registered, as after a hot reload, stays as it is.
      });
  }

  return () => {
    controller.abort();

    for (const handle of handles) {
      handle.unregister?.();
    }
  };
}

/**
 * Offers the agent tools to agents in the browser through WebMCP, where it is enabled,
 * and to page scripts as `window.lunarSpice`. Returns a function that withdraws them.
 */
export function startAgentTools() {
  const context = modelContext();
  const unregister = context ? registerTools(context) : null;

  Object.assign(globalThis, { lunarSpice: pageTools });

  return () => {
    unregister?.();
    Reflect.deleteProperty(globalThis, "lunarSpice");
  };
}
