import type { DogState } from "@/lib/mascot";

export interface SceneProps {
  playing: boolean;
  onCue?: (state: DogState) => void;
  onEnded?: () => void;
  label: string;
}
