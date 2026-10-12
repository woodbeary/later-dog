export interface TeamComputer {
  id: string;
  name: string;
  section: string | null;
  state: string;
  held: boolean;
  problem?: string;
}

export interface TeamComputersPayload {
  computers: TeamComputer[];
  configured: boolean;
  problem?: string;
}
