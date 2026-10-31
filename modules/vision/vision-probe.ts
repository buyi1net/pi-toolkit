import type { PiVisionImage } from "./pi-model-backend.ts";

export const VISION_PROBE_IMAGE: PiVisionImage = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAYAAADlNHIOAAAAlklEQVR4nO3RwQkAMAgEwSs9nRvSQ+BARty/MplkmuWU674/9QsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAOgLfFkm7tAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD7MBUWbzxwABZ5XAAAAAElFTkSuQmCC",
};

export const VISION_PROBE_EXPECTED: readonly string[] = [
  "red",
  "green",
  "blue",
  "yellow",
  "black",
  "white",
];
