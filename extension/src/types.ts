export type SelectorStrategy = "aria" | "data" | "css";

export interface BuiltSelector {
  // The selector string that identifies the element inside its deepest root
  selector: string;
  // Preferred strategy used to build the selector
  strategy: SelectorStrategy;
  // When strategy is 'aria', indicates how the accessible name should be matched
  nameMatch?: "exact" | "contains";
  // If the target is inside shadow DOMs, these are selectors to traverse from document → deepest shadow host
  // in outer-to-inner order. Each entry can be queried in the previous root to get the next shadow host.
  shadowChain: string[];
  // If the target is inside iframes, these are selectors for the iframe elements from top document → deepest iframe
  frameChain: string[];
  // Optional human-facing hints
  textHint?: string;
  roleHint?: string;
  // Optional alternative selectors for fallback during replay
  alternatives?: Array<{
    strategy: SelectorStrategy;
    selector: string;
    nameMatch?: "exact" | "contains";
  }>;
}

export type ActionKind =
  | { name: "click" }
  | { name: "dblclick" }
  | { name: "type"; text: string }
  | { name: "press"; key: "Enter" }
  | { name: "scroll"; deltaX: number; deltaY: number }
  | { name: "navigate"; url: string; title?: string };

export type PredicateName =
  | "urlChanged"
  | "domAdded"
  | "ariaLiveUpdated"
  | "textChanged"
  | "layoutStable";

export interface ActionStep {
  kind: "action";
  action: ActionKind;
  selector: BuiltSelector;
  tabLid?: number;
  timestamp: number;
  // When true, indicates sensitive user input content was redacted in this step
  redacted?: boolean;
}

export interface WaitPredicateStep {
  kind: "waitForPredicate";
  predicate: PredicateName;
  container?: BuiltSelector;
  meta?: Record<string, unknown>;
  tabLid?: number;
  timestamp: number;
}

export interface TraceMeta {
  version: number;
  recorder?: string;
  startedAt?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  // URL of the page where recording started; used by replayer to navigate first
  startUrl?: string;
}

export interface TracePayload {
  meta: TraceMeta;
  steps: Array<ActionStep | WaitPredicateStep>;
}

export {};


