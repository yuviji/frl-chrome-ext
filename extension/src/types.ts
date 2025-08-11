export type SelectorStrategy = "aria" | "data" | "css";

export interface BuiltSelector {
  // The selector string that identifies the element inside its deepest root
  selector: string;
  // Preferred strategy used to build the selector
  strategy: SelectorStrategy;
  // If the target is inside shadow DOMs, these are selectors to traverse from document → deepest shadow host
  // in outer-to-inner order. Each entry can be queried in the previous root to get the next shadow host.
  shadowChain: string[];
  // If the target is inside iframes, these are selectors for the iframe elements from top document → deepest iframe
  frameChain: string[];
  // Optional human-facing hints
  textHint?: string;
  roleHint?: string;
}

export {};


