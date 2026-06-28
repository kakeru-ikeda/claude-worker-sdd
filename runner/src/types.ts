export type EngineName = "codex" | "opencode" | "gemini";

export type AgentName =
  | "executor"
  | "reviewer"
  | "explorer"
  | "thinker"
  | "test-writer"
  | "operator";

export type TaskSpec = {
  id: string;
  title: string;
  source_plan?: string;
  source_task_index?: number;
  agent: AgentName;
  engine: {
    name: EngineName;
    runner?: string | null;
    model?: string | null;
    agent?: string | null;
  };
  worktree?: {
    enabled: boolean;
    base?: string | null;
    path?: string | null;
  };
  scope?: {
    allow_files?: string[];
    deny_files?: string[];
  };
  acceptance: string[];
  verify?: {
    commands?: string[];
  };
  constraints?: string[];
};

export type Progress = {
  plan: string;
  base_commit?: string | null;
  defaults?: Record<string, unknown>;
  tasks: Record<
    string,
    {
      status: "pending" | "running" | "complete" | "failed" | "needs_retry";
      engine?: EngineName;
      agent?: AgentName;
      model?: string | null;
      path: string;
      reviewed?: boolean;
      attempts?: Array<Record<string, unknown>>;
    }
  >;
};

export type RunOptions = {
  planPath: string;
  taskId?: string;
  engine?: EngineName;
  model?: string;
  agent?: AgentName;
  reviewOnly?: boolean;
};

export type AdapterRunInput = {
  workspace: string;
  taskDir: string;
  task: TaskSpec;
  dispatchPath: string;
  stdoutPath: string;
  finalPath: string;
  mode: "run" | "review";
};

export type AdapterRunResult = {
  exitCode: number;
  command: string;
};

