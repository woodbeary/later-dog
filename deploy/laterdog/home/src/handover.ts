export type HomeStanding = "holding" | "released";

export interface HandoverPeer {
  release(): Promise<boolean>;
}

export interface HandoverSide {
  standing(): HomeStanding;
  stand(standing: HomeStanding): Promise<void>;
  running(): boolean;
  quiet(): Promise<void>;
  sibling(): HandoverPeer;
}

export interface StartSteps {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const HANDING_OVER = "This home is handing over to its other computer.";

export class Handover {
  private turn = 0;
  private starting = 0;

  constructor(private readonly side: HandoverSide) {}

  holds(): boolean {
    return this.side.standing() === "holding";
  }

  idle(): boolean {
    return this.starting === 0 && !this.side.running();
  }

  async release(): Promise<boolean> {
    this.turn += 1;
    await this.side.stand("released");
    await this.side.quiet();
    return this.idle();
  }

  async start(claim: boolean, steps: StartSteps): Promise<boolean> {
    const turn = this.turn;
    this.starting += 1;
    try {
      if (!(await this.mayRun(claim, turn))) return false;
      await steps.prepare();
      if (this.turn !== turn) return false;
      await steps.start();
      if (this.turn === turn) return true;
      await steps.stop();
      return false;
    } finally {
      this.starting -= 1;
    }
  }

  private async mayRun(claim: boolean, turn: number): Promise<boolean> {
    if (this.holds()) return true;
    if (!claim) return false;
    if (!(await this.side.sibling().release())) return false;
    if (this.turn !== turn) return false;
    await this.side.stand("holding");
    return this.turn === turn;
  }
}
