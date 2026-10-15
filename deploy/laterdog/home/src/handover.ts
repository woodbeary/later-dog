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
  private readonly launching = new Set<Promise<void>>();

  constructor(private readonly side: HandoverSide) {}

  holds(): boolean {
    return this.side.standing() === "holding";
  }

  idle(): boolean {
    return this.starting === 0 && this.launching.size === 0 && !this.side.running();
  }

  async release(): Promise<boolean> {
    this.turn += 1;
    await this.side.stand("released");
    await Promise.allSettled([...this.launching]);
    await this.side.quiet();
    return this.idle();
  }

  launch(run: () => Promise<void>): Promise<void> {
    if (!this.holds()) return Promise.reject(new Error(HANDING_OVER));
    const launched = run();
    this.launching.add(launched);
    const forget = () => {
      this.launching.delete(launched);
    };
    launched.then(forget, forget);
    return launched;
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
    if (this.turn === turn) return true;
    await this.side.stand("released");
    return false;
  }
}
