import type {TerminalSessionOutputEvent} from '../../../shared/types';

/** Sequence offsets count UTF-16 code units, exactly like JS string slicing. */
export class TerminalOutputCursor {
  private sequence: number;
  constructor(private readonly sessionId: string, private readonly attachmentId: string, sequence: number) {
    this.sequence = sequence;
  }
  accept(event: TerminalSessionOutputEvent): {data: string; gap: boolean} | null {
    if (event.sessionId !== this.sessionId || event.attachmentId !== this.attachmentId || event.sequence <= this.sequence) return null;
    const gap = event.startSequence > this.sequence;
    const data = event.data.slice(Math.max(0, this.sequence - event.startSequence));
    this.sequence = event.sequence;
    return {data, gap};
  }
}
