export interface FeishuCardV2 {
  schema: "2.0";
  config?: { update_multi?: boolean };
  header?: {
    title: { tag: "plain_text"; content: string };
    template?: string;
  };
  body: { elements: FeishuElement[] };
}

export type FeishuElement =
  | { tag: "markdown"; content: string }
  | { tag: "hr" }
  | {
      tag: "column_set";
      flex_mode?: string;
      horizontal_spacing?: string;
      columns: FeishuColumn[];
    }
  | {
      tag: "button";
      text: { tag: "plain_text"; content: string };
      type: "primary" | "danger" | "default";
      width?: "fill" | "auto";
      value: Record<string, unknown>;
    };

export interface FeishuColumn {
  tag: "column";
  width: "weighted" | "auto";
  weight?: number;
  elements: FeishuElement[];
}
