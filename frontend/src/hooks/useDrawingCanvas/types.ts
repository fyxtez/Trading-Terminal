export type EditingTextState = {
  drawingId: string;
  value: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
};

export type ReduceOrderEditorState = {
  drawingId: string;
  left: number;
  top: number;
  reducePct: number;
  isSubmitting: boolean;
};
